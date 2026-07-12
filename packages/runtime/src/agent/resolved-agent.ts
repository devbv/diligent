// @summary Shared resolved agent definition helpers for built-in and user-defined agents
import type { ModelClass } from "@diligent/core/llm/models";
import type { AgentMetadata } from "../agents/types";

export interface ResolvedAgentDefinition {
  name: string;
  description: string;
  source: "builtin" | "user";
  systemPromptPrefix?: string;
  allowedTools?: string[];
  readonly: boolean;
  defaultModelClass?: ModelClass;
  filePath?: string;
}

export function resolveAvailableAgentDefinitions(
  builtinAgents: ResolvedAgentDefinition[],
  userAgents: AgentMetadata[],
): ResolvedAgentDefinition[] {
  return [...builtinAgents, ...resolveCustomAgentDefinitions(userAgents)];
}

export function resolveCustomAgentDefinitions(userAgents: AgentMetadata[]): ResolvedAgentDefinition[] {
  return userAgents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    source: "user" as const,
    systemPromptPrefix: `${agent.content.trim()}\n`,
    allowedTools: agent.tools,
    readonly: false,
    defaultModelClass: agent.defaultModelClass,
    filePath: agent.filePath,
  }));
}

export function resolveAgentDefinition(
  agents: ResolvedAgentDefinition[],
  name: string,
): ResolvedAgentDefinition | undefined {
  return agents.find((agent) => agent.name === name);
}
