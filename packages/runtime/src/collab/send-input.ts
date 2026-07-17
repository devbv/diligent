// @summary send_input tool — inject a steering message into a running sub-agent

import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import type { AgentRegistry } from "./registry";

const SendInputParams = z.object({
  id: z.string().describe("Thread ID of the agent to send input to"),
  message: z.string().describe("Steering message to inject into the running agent"),
});

export function createSendInputTool(registry: AgentRegistry): Tool<typeof SendInputParams> {
  return {
    name: "send_input",
    description:
      "Send a steering message to a running sub-agent. The agent will incorporate this guidance on its next turn. " +
      "Does not interrupt the current tool execution.",
    parameters: SendInputParams,
    execute: async (args, _ctx: ToolContext): Promise<ToolResult> => {
      const nickname = registry.getNickname(args.id) ?? args.id;
      await registry.sendInput(args.id, args.message);
      return { output: JSON.stringify({ ok: true, nickname, message: args.message }) };
    },
  };
}
