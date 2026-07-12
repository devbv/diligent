// @summary Resolves subagent catalog states from built-ins, discovery, and layered config.

import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import type { DiligentConfigLayers } from "../config/loader";
import type { DiligentConfig } from "../config/schema";

export type SubagentController = "required" | "default" | "global" | "project";
export type SubagentStateReason = "enabled" | "disabled_by_user" | "required_builtin";
export type SubagentSource = "builtin" | "global" | "project" | "config";

export interface SubagentCatalogEntry {
  definition: ResolvedAgentDefinition;
  source: SubagentSource;
  required: boolean;
}

export interface ResolvedSubagentState extends SubagentCatalogEntry {
  globalEnabled: boolean;
  effectiveEnabled: boolean;
  available: boolean;
  controlledBy: SubagentController;
  reason: SubagentStateReason;
}

export function resolveSubagentStates(
  catalog: SubagentCatalogEntry[],
  config: DiligentConfig["agents"] | undefined,
  layers: DiligentConfigLayers,
): ResolvedSubagentState[] {
  const globalOverrides = layers.global?.agents?.overrides ?? {};
  const projectOverrides = layers.project?.agents?.overrides ?? {};
  const effectiveOverrides = config?.overrides ?? {};

  return catalog.map((entry) => {
    if (entry.required) {
      return {
        ...entry,
        globalEnabled: true,
        effectiveEnabled: true,
        available: true,
        controlledBy: "required",
        reason: "required_builtin",
      };
    }
    const globalEnabled = globalOverrides[entry.definition.name] ?? true;
    const effectiveEnabled = effectiveOverrides[entry.definition.name] ?? true;
    const controlledBy: SubagentController = Object.hasOwn(projectOverrides, entry.definition.name)
      ? "project"
      : Object.hasOwn(globalOverrides, entry.definition.name)
        ? "global"
        : "default";
    return {
      ...entry,
      globalEnabled,
      effectiveEnabled,
      available: effectiveEnabled,
      controlledBy,
      reason: effectiveEnabled ? "enabled" : "disabled_by_user",
    };
  });
}

export function filterAvailableAgentDefinitions(states: ResolvedSubagentState[]): ResolvedAgentDefinition[] {
  return states.filter((state) => state.available).map((state) => state.definition);
}
