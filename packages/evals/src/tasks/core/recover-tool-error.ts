// @summary Core eval task for recovering from an explicit stale-revision tool error

import { z } from "zod";
import type { EvalTask } from "../../task";
import { fixtureToken, getToolTrace, isRecord } from "./helpers";

export interface RecoverToolErrorWorld {
  recordId: string;
  staleRevision: string;
  currentRevision: string;
  desiredValue: string;
  value: string;
  updateAttempts: number;
}

export const recoverToolErrorTask: EvalTask<RecoverToolErrorWorld> = {
  id: "recover-tool-error",
  description: "Recovers from a stale revision using the revision returned in an error result.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "Complete the requested update with the available tool. When a tool reports a recoverable error, use the exact corrective value in that result and retry.",
    },
  ],
  limits: { maxTurns: 3, maxToolCalls: 2, timeoutMs: 180_000, maxOutputTokens: 8_192 },
  createWorld: (seed) => ({
    recordId: fixtureToken(seed, "recover-record-id", "record"),
    staleRevision: fixtureToken(seed, "recover-stale-revision", "rev_stale"),
    currentRevision: fixtureToken(seed, "recover-current-revision", "rev_current"),
    desiredValue: fixtureToken(seed, "recover-desired-value", "value"),
    value: "unchanged",
    updateAttempts: 0,
  }),
  createTools: (world) => [
    {
      name: "update_record",
      description:
        "Update a record using its exact revision. A stale-revision error returns the current revision to retry.",
      parameters: z.object({ recordId: z.string(), revision: z.string(), value: z.string() }),
      async execute({ recordId, revision, value }) {
        world.updateAttempts += 1;
        if (recordId !== world.recordId || value !== world.desiredValue) {
          return { output: "Error: invalid record or value", metadata: { error: true, code: "invalid_update" } };
        }
        if (world.updateAttempts === 1) {
          return {
            output: JSON.stringify({ error: "stale_revision", currentRevision: world.currentRevision }),
            metadata: { error: true, code: "stale_revision" },
          };
        }
        if (revision !== world.currentRevision) {
          return {
            output: JSON.stringify({ error: "stale_revision", currentRevision: world.currentRevision }),
            metadata: { error: true, code: "stale_revision" },
          };
        }
        world.value = value;
        return { output: JSON.stringify({ status: "updated", recordId, revision, value }) };
      },
    },
  ],
  createUserMessage: (world) => ({
    role: "user",
    content: `Update record ${world.recordId} from revision ${world.staleRevision} to value ${world.desiredValue}. Recover if the revision is stale.`,
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({ ...world }),
  evaluate: (execution) => {
    const trace = getToolTrace(execution);
    if (trace.length !== 2) {
      return {
        passed: false,
        code: "recover_tool_error.wrong_trace",
        message: "Expected exactly two update_record calls.",
        dimension: "behavior",
      };
    }
    if (trace.some((entry) => entry.toolName !== "update_record"))
      return {
        passed: false,
        code: "recover_tool_error.wrong_trace",
        message: "Recovery used an undeclared tool surface.",
        dimension: "runtime_policy",
      };
    const first = trace[0]?.input;
    const second = trace[1]?.input;
    if (
      !isRecord(first) ||
      first.recordId !== execution.world.recordId ||
      first.revision !== execution.world.staleRevision ||
      first.value !== execution.world.desiredValue
    ) {
      return {
        passed: false,
        code: "recover_tool_error.wrong_first_call",
        message: "The first update call was invalid.",
        dimension: "behavior",
      };
    }
    if (
      !isRecord(second) ||
      second.recordId !== execution.world.recordId ||
      second.revision !== execution.world.currentRevision ||
      second.value !== execution.world.desiredValue
    ) {
      return {
        passed: false,
        code: "recover_tool_error.wrong_retry",
        message: "The retry did not use the current revision.",
        dimension: "behavior",
      };
    }
    if (execution.world.updateAttempts !== 2 || execution.world.value !== execution.world.desiredValue) {
      return {
        passed: false,
        code: "recover_tool_error.not_updated",
        message: "The record did not reach the expected state.",
        dimension: "semantic_goal",
      };
    }
    return { passed: true };
  },
};
