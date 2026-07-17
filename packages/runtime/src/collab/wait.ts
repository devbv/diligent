// @summary wait tool — block until specified agents finish or timeout, returning final statuses

import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import type { AgentRegistry } from "./registry";
import type { AgentStatus } from "./types";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_TIMEOUT_MS = 1 * 60 * 1000; // 5 minutes
const MAX_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

const WaitParams = z.object({
  ids: z.array(z.string()).min(1).describe("Thread IDs of agents to wait for"),
  timeout_ms: z
    .number()
    .optional()
    .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, min ${MIN_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
});

function summarizeStatus(status: AgentStatus, nickname: string): string {
  switch (status.kind) {
    case "completed": {
      const preview = status.output ? status.output.split("\n")[0] : "(no output)";
      return `${nickname}: Completed — ${preview}`;
    }
    case "errored":
      return `${nickname}: Error — ${status.error}`;
    case "running":
      return `${nickname}: Still running`;
    case "pending":
      return `${nickname}: Pending`;
    case "shutdown":
      return `${nickname}: Shutdown`;
  }
}

export function createWaitTool(registry: AgentRegistry): Tool<typeof WaitParams> {
  return {
    name: "wait",
    description:
      "Wait for spawned agents to finish. Returns their final status and output. " +
      "Blocks until all specified agents complete or timeout expires.",
    parameters: WaitParams,
    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);

      const onUpdate = (summary: string) => ctx.onUpdate?.(summary);

      const { status, timedOut } = await registry.wait(args.ids, timeoutMs, onUpdate, ctx.signal);

      // Build human-readable summary
      const lines: string[] = [];
      for (const [id, s] of Object.entries(status)) {
        const nickname = registry.getNickname(id) ?? id;
        lines.push(summarizeStatus(s, nickname));
      }

      const output = JSON.stringify({
        status,
        timed_out: timedOut,
        summary: lines,
      });

      return { output };
    },
  };
}
