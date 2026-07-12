// @summary Product experiment list/set handlers with atomic coupled capability persistence.

import { getGlobalConfigPath, saveGlobalExperimentOverrides } from "../config";
import type { ExperimentDefinition, ResolvedExperiment } from "../experiments";
import type { ExperimentsListResponse, ExperimentsSetParams } from "../protocol";
import type { ConfigReloadResult } from "./config-handlers";
import { handleConfigReload } from "./config-handlers";
import type { ThreadRuntime } from "./thread-handlers";

export interface ExperimentConfigManager {
  getDefinitions: () => ExperimentDefinition[];
  getExperiments: () => ResolvedExperiment[];
}

export function handleExperimentsList(manager: ExperimentConfigManager): ExperimentsListResponse {
  return buildResponse(manager.getExperiments());
}

export async function handleExperimentsSet(
  manager: ExperimentConfigManager,
  reloadConfig: (() => Promise<ConfigReloadResult>) | undefined,
  threads: Map<string, ThreadRuntime>,
  params: ExperimentsSetParams,
): Promise<ExperimentsListResponse> {
  const definitions = manager.getDefinitions();
  const knownIds = new Set(definitions.map((definition) => definition.id));
  const unknownIds = Object.keys(params.overrides).filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw Object.assign(new Error(`Unknown experiment(s): ${unknownIds.sort().join(", ")}`), { code: -32602 });
  }
  const stored = Object.fromEntries(
    definitions
      .filter((definition) => params.overrides[definition.id] !== undefined)
      .filter((definition) => params.overrides[definition.id] !== definition.defaultEnabled)
      .map((definition) => [definition.id, params.overrides[definition.id]!]),
  );
  await saveGlobalExperimentOverrides(stored);
  await handleConfigReload(reloadConfig, threads);
  return buildResponse(manager.getExperiments());
}

function buildResponse(experiments: readonly ResolvedExperiment[]): ExperimentsListResponse {
  return {
    configPath: getGlobalConfigPath(),
    appliesOnNextTurn: true,
    experiments: experiments.map(({ id, title, description, defaultEnabled, enabled }) => ({
      id,
      title,
      description,
      defaultEnabled,
      enabled,
    })),
  };
}
