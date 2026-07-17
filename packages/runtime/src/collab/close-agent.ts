// @summary close_agent tool — abort a sub-agent and return its final status

import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import type { AgentRegistry } from "./registry";

const CloseAgentParams = z.object({
  id: z.string().describe("Thread ID of the agent to close"),
});

export function createCloseAgentTool(registry: AgentRegistry): Tool<typeof CloseAgentParams> {
  return {
    name: "close_agent",
    description: "Abort a sub-agent and clean up its resources. Returns the agent's final status.",
    parameters: CloseAgentParams,
    execute: async (args, _ctx: ToolContext): Promise<ToolResult> => {
      const nickname = registry.getNickname(args.id) ?? args.id;
      const finalStatus = await registry.close(args.id);
      return { output: JSON.stringify({ thread_id: args.id, nickname, final_status: finalStatus }) };
    },
  };
}
