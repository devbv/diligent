// @summary Factory creating the four collab tools sharing a single AgentRegistry
import type { Tool } from "@diligent/core/tool-contract";
import { createCloseAgentTool } from "./close-agent";
import { AgentRegistry } from "./registry";
import { createSendInputTool } from "./send-input";
import { createSpawnAgentTool } from "./spawn-agent";
import type { CollabToolDeps } from "./types";
import { createWaitTool } from "./wait";

export function createCollabTools(
  deps: CollabToolDeps,
  /**
   * Pass an existing registry to reuse across turns.
   * Its mutable deps will be updated in-place so child agents spawned
   * in previous turns remain accessible from subsequent turns.
   */
  existingRegistry?: AgentRegistry,
): {
  tools: Tool[];
  registry: AgentRegistry;
} {
  let registry: AgentRegistry;
  if (existingRegistry) {
    // Reuse existing registry: update mutable deps only
    existingRegistry.updateDeps(deps);
    registry = existingRegistry;
  } else {
    registry = new AgentRegistry(deps);
  }
  const tools: Tool[] = [
    createSpawnAgentTool(registry, deps.agentDefinitions),
    createWaitTool(registry),
    createSendInputTool(registry),
    createCloseAgentTool(registry),
  ];
  return { tools, registry };
}
