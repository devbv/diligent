// @summary Subagent settings management request handlers.

import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import { resolveSubagentStates, type SubagentCatalogEntry, type SubagentSource } from "../agents";
import type { DiligentConfigLayers } from "../config/loader";
import type { DiligentConfig } from "../config/schema";
import { getGlobalConfigPath, writeGlobalAgentsConfig } from "../config/writer";
import type {
  SubagentDescriptor,
  SubagentsListResponse,
  SubagentsSetParams,
  SubagentsSetResponse,
} from "../protocol/index";
import type { ConfigReloadResult } from "./config-reload";
import { handleConfigReload } from "./config-reload";
import type { ThreadHandlersContext } from "./context";

export interface SubagentSettingsContext {
  cwd: string;
  config: DiligentConfig["agents"] | undefined;
  layers: DiligentConfigLayers;
  catalog: SubagentCatalogEntry[];
  experimentManagedAgentNames?: ReadonlySet<string>;
}

export interface SubagentConfigManager {
  resolve: (cwd: string) => Promise<SubagentSettingsContext>;
}

export async function handleSubagentsList(
  ctx: ThreadHandlersContext,
  manager: SubagentConfigManager,
  threadId: string | undefined,
): Promise<SubagentsListResponse> {
  const cwd = await ctx.resolveSubagentSettingsCwd(threadId);
  return buildSubagentsListResponse(await manager.resolve(cwd));
}

export async function handleSubagentsSet(
  ctx: ThreadHandlersContext,
  manager: SubagentConfigManager,
  reloadConfig: (() => Promise<ConfigReloadResult>) | undefined,
  params: SubagentsSetParams,
): Promise<SubagentsSetResponse> {
  const cwd = await ctx.resolveSubagentSettingsCwd(params.threadId);
  const before = await manager.resolve(cwd);
  const requested = Object.keys(params.overrides);
  const experimentManaged = requested.filter((name) => before.experimentManagedAgentNames?.has(name));
  if (experimentManaged.length > 0) {
    throw Object.assign(
      new Error(`Cannot edit experiment-managed subagent(s): ${experimentManaged.sort().join(", ")}`),
      { code: -32602 },
    );
  }
  const required = new Set(before.catalog.filter((entry) => entry.required).map((entry) => entry.definition.name));
  const projectOverrides = before.layers.project?.agents?.overrides ?? {};
  const immutable = requested.filter((name) => required.has(name));
  if (immutable.length > 0) {
    throw Object.assign(new Error(`Cannot edit required subagent(s): ${immutable.sort().join(", ")}`), {
      code: -32602,
    });
  }
  const projectControlled = requested.filter((name) => Object.hasOwn(projectOverrides, name));
  if (projectControlled.length > 0) {
    throw Object.assign(
      new Error(`Cannot edit project-controlled subagent override(s): ${projectControlled.sort().join(", ")}`),
      { code: -32602 },
    );
  }
  await writeGlobalAgentsConfig({ overrides: params.overrides });
  await handleConfigReload(reloadConfig, ctx.threads);
  return buildSubagentsListResponse(await manager.resolve(cwd));
}

export function buildSubagentCatalog(
  builtinDefinitions: ResolvedAgentDefinition[],
  customDefinitions: Array<{ definition: ResolvedAgentDefinition; source: SubagentSource }>,
): SubagentCatalogEntry[] {
  return [
    ...builtinDefinitions.map((definition) => ({
      definition,
      source: "builtin" as const,
      required: definition.name === "general",
    })),
    ...customDefinitions.map(({ definition, source }) => ({ definition, source, required: false })),
  ];
}

export function buildSubagentsListResponse(context: SubagentSettingsContext): SubagentsListResponse {
  return {
    configPath: getGlobalConfigPath(),
    appliesOnNextTurn: true,
    subagents: resolveSubagentStates(
      context.catalog.filter((entry) => !context.experimentManagedAgentNames?.has(entry.definition.name)),
      context.config,
      context.layers,
    ).map(
      (state): SubagentDescriptor => ({
        name: state.definition.name,
        description: state.definition.description,
        source: state.source,
        required: state.required,
        globalEnabled: state.globalEnabled,
        effectiveEnabled: state.effectiveEnabled,
        available: state.available,
        controlledBy: state.controlledBy,
        reason: state.reason,
      }),
    ),
  };
}
