// @summary spawn_agent tool — non-blocking sub-agent creation returning thread_id and nickname

import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import { formatAgentTypeParameterDescription, formatSpawnAgentToolDescription } from "../agent/agent-types";
import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import type { AgentRegistry } from "./registry";

const SpawnAgentParams = z.object({
  message: z
    .string()
    .describe(
      "The full worker brief for the sub-agent. Include the objective, relevant context, exact scope, and expected deliverable or result shape.",
    ),
  description: z.string().optional().describe("Brief description for status display"),
  agent_type: z.string().optional().describe(formatAgentTypeParameterDescription()),
  resume_id: z.string().optional().describe("Session ID to resume a previous sub-agent session"),
  allow_nested_agents: z
    .boolean()
    .optional()
    .describe(
      "Explicit opt-in for nested subagents. Disabled by default; child agents cannot access collab tools unless this is true.",
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Optional per-spawn child-tool allow-list. Can only narrow the selected agent's default tool access. Omit this field to inherit all permitted tools; an empty list is treated the same as omitted. Collab tools remain excluded unless allow_nested_agents=true.",
    ),
});

function normalizeAllowedTools(toolNames: string[] | undefined): string[] | undefined {
  return toolNames && toolNames.length > 0 ? toolNames : undefined;
}

export function createSpawnAgentTool(
  registry: AgentRegistry,
  agentDefinitions: ResolvedAgentDefinition[],
): Tool<typeof SpawnAgentParams> {
  const parameters = SpawnAgentParams.extend({
    agent_type: z.string().optional().describe(formatAgentTypeParameterDescription(agentDefinitions)),
  });

  return {
    name: "spawn_agent",
    description: formatSpawnAgentToolDescription(agentDefinitions),
    parameters,
    execute: async (args, _ctx: ToolContext): Promise<ToolResult> => {
      const prompt = args.message;
      const { threadId, nickname } = registry.spawn({
        prompt,
        description: args.description ?? "",
        agentType: args.agent_type,
        resumeId: args.resume_id,
        allowNestedAgents: args.allow_nested_agents,
        allowedTools: normalizeAllowedTools(args.allowed_tools),
      });
      return { output: JSON.stringify({ thread_id: threadId, nickname }) };
    },
  };
}
