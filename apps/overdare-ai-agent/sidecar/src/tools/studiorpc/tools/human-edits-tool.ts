// @summary Reports what the human creator changed in Studio, sourced from Studio's EditLogging transaction log.

import { z } from "zod";
import type { Tool, ToolResult } from "../types";
import {
  deleteConsumed,
  MID_TURN_HEADER,
  NO_EDITS_MESSAGE,
  peekEditLogs,
  rotateAndReadEditLogs,
  summarizeEditLog,
} from "./edit-log";

const params = z.object({});

const description =
  "Summarize what the human creator changed in Studio, from Studio's edit-transaction log (added/removed/" +
  "moved instances, property changes, script edits). Covers edits since the agent's last completed turn plus " +
  "any made while this turn is running. Agent edits are never logged, so everything reported is a genuine " +
  "human edit. Read-only.";

/** Turn-start capture: the frozen summary plus a callback that deletes the consumed log files. */
export interface HumanEditsCapture {
  result: ToolResult;
  /** Delete the rotated log files. Call once the summary has been delivered into the turn. */
  finalize: () => void;
}

/**
 * Consume all pending edit-log transactions: rotate the files out of Studio's
 * way, summarize them, and hand back a deferred deletion. Called at turn start
 * so the report never mixes with this turn's agent edits (which are not logged
 * anyway, but the boundary keeps "since your last turn" semantics exact).
 */
export function consumeHumanEdits(cwd: string): HumanEditsCapture {
  try {
    const { envelopes, parseFailures, consumedPaths } = rotateAndReadEditLogs(cwd);
    const { output, editCount } = summarizeEditLog(envelopes, parseFailures);
    return {
      result: {
        output,
        metadata: { method: "human_edits", humanEditsDetected: editCount > 0, transactions: envelopes.length },
      },
      finalize: () => deleteConsumed(consumedPaths),
    };
  } catch (error) {
    return {
      result: {
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { error: true, method: "human_edits" },
      },
      finalize: () => {},
    };
  }
}

/** Non-destructive summary of edits logged after turn start (edits made during this turn). */
function peekHumanEdits(cwd: string): ToolResult {
  try {
    const { envelopes, parseFailures } = peekEditLogs(cwd);
    const { output, editCount } = summarizeEditLog(envelopes, parseFailures, MID_TURN_HEADER);
    return { output, metadata: { method: "human_edits", humanEditsDetected: editCount > 0 } };
  } catch (error) {
    return {
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { error: true, method: "human_edits" },
    };
  }
}

export function createHumanEditsTool(cwd: string, getCached?: () => ToolResult | undefined): Tool {
  return {
    name: "studiorpc_human_edits",
    description,
    parameters: params,
    async execute() {
      const cached = getCached?.();
      const live = peekHumanEdits(cwd);
      const parts: string[] = [];
      if (cached?.metadata?.humanEditsDetected === true) parts.push(cached.output);
      if (live.metadata?.humanEditsDetected === true) parts.push(live.output);
      if (parts.length === 0) return cached ?? { output: NO_EDITS_MESSAGE, metadata: { method: "human_edits" } };
      return {
        output: parts.join("\n\n"),
        metadata: { method: "human_edits", humanEditsDetected: true },
      };
    },
  };
}
