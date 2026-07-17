// @summary Core eval task for one exact in-memory lookup tool call

import { z } from "zod";
import type { EvalTask } from "../../task";
import { fixtureToken, getFinalText, getToolTrace, isRecord } from "./helpers";

export interface SingleToolWorld {
  recordId: string;
  verificationCode: string;
  successfulLookups: number;
}

export const singleToolTask: EvalTask<SingleToolWorld> = {
  id: "single-tool",
  description: "Looks up one hidden verification code through a core function tool.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "Use the available tool to obtain facts that are not present in the prompt. Finish with a concise answer.",
    },
  ],
  limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 120_000, maxOutputTokens: 8_192 },
  createWorld: (seed) => ({
    recordId: fixtureToken(seed, "single-tool-record", "record"),
    verificationCode: fixtureToken(seed, "single-tool-code", "verify"),
    successfulLookups: 0,
  }),
  createTools: (world) => [
    {
      name: "lookup_record",
      description: "Look up a record by its exact recordId and return its verification code.",
      parameters: z.object({ recordId: z.string().describe("The exact record identifier from the user") }),
      async execute({ recordId }) {
        if (recordId !== world.recordId) {
          return { output: "Error: record not found", metadata: { error: true, code: "record_not_found" } };
        }
        world.successfulLookups += 1;
        return { output: JSON.stringify({ recordId, verificationCode: world.verificationCode }) };
      },
    },
  ],
  createUserMessage: (world) => ({
    role: "user",
    content: `Look up record ${world.recordId}. Return the verification code from the record in your final answer.`,
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({ ...world }),
  evaluate: (execution) => {
    const trace = getToolTrace(execution);
    if (trace.length !== 1 || trace[0]?.toolName !== "lookup_record") {
      return { passed: false, code: "single_tool.wrong_trace", message: "Expected exactly one lookup_record call." };
    }
    const input = trace[0].input;
    if (!isRecord(input) || input.recordId !== execution.world.recordId) {
      return { passed: false, code: "single_tool.wrong_record_id", message: "lookup_record used the wrong record ID." };
    }
    if (execution.world.successfulLookups !== 1) {
      return { passed: false, code: "single_tool.lookup_failed", message: "The lookup did not complete exactly once." };
    }
    if (!getFinalText(execution).includes(execution.world.verificationCode)) {
      return {
        passed: false,
        code: "single_tool.missing_code",
        message: "The final answer omitted the verification code.",
      };
    }
    return { passed: true };
  },
};
