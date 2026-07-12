// @summary Product-injected experiment definitions and coupled capability resolution.

export interface ExperimentDefinition {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  toolNames?: readonly string[];
  skillNames?: readonly string[];
}

export interface ResolvedExperiment extends ExperimentDefinition {
  enabled: boolean;
}

export function resolveExperimentStates(
  definitions: readonly ExperimentDefinition[],
  overrides: Readonly<Record<string, boolean>> | undefined,
): ResolvedExperiment[] {
  return definitions.map((definition) => ({
    ...definition,
    enabled: overrides?.[definition.id] ?? definition.defaultEnabled,
  }));
}

export function resolveExperimentGates(states: readonly ResolvedExperiment[]): {
  disabledToolNames: Set<string>;
  disabledSkillNames: Set<string>;
} {
  const disabledToolNames = new Set<string>();
  const disabledSkillNames = new Set<string>();
  for (const state of states) {
    if (state.enabled) continue;
    for (const name of state.toolNames ?? []) disabledToolNames.add(name);
    for (const name of state.skillNames ?? []) disabledSkillNames.add(name);
  }
  return { disabledToolNames, disabledSkillNames };
}
