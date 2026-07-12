// @summary Skill settings management request handlers.

import type { DiligentConfigLayers } from "../config/loader";
import type { DiligentConfig } from "../config/schema";
import { getGlobalConfigPath, writeGlobalSkillsConfig } from "../config/writer";
import type { SkillDescriptor, SkillsListResponse, SkillsSetParams, SkillsSetResponse } from "../protocol/index";
import type { SkillMetadata } from "../skills";
import { resolveSkillStates, resolveSkillsEnabledControl } from "../skills";
import type { ConfigReloadResult } from "./config-handlers";
import { handleConfigReload } from "./config-handlers";
import type { ThreadHandlersContext } from "./thread-handlers";

export interface SkillSettingsContext {
  cwd: string;
  config: DiligentConfig["skills"] | undefined;
  layers: DiligentConfigLayers;
  discoveredSkills: SkillMetadata[];
}

export interface SkillConfigManager {
  resolve: (cwd: string) => Promise<SkillSettingsContext>;
}

export async function handleSkillsList(
  ctx: ThreadHandlersContext,
  manager: SkillConfigManager,
  threadId: string | undefined,
): Promise<SkillsListResponse> {
  const cwd = await ctx.resolveSkillSettingsCwd(threadId);
  const context = await manager.resolve(cwd);
  return buildSkillsListResponse(context);
}

export async function handleSkillsSet(
  ctx: ThreadHandlersContext,
  manager: SkillConfigManager,
  reloadConfig: (() => Promise<ConfigReloadResult>) | undefined,
  params: SkillsSetParams,
): Promise<SkillsSetResponse> {
  const cwd = await ctx.resolveSkillSettingsCwd(params.threadId);
  const before = await manager.resolve(cwd);
  const projectOverrides = before.layers.project?.skills?.overrides ?? {};
  const projectControlledKeys = Object.keys(params.overrides).filter((name) => Object.hasOwn(projectOverrides, name));
  if (projectControlledKeys.length > 0) {
    throw Object.assign(
      new Error(`Cannot edit project-controlled skill override(s): ${projectControlledKeys.sort().join(", ")}`),
      { code: -32602 },
    );
  }

  await writeGlobalSkillsConfig({ overrides: params.overrides });
  await handleConfigReload(reloadConfig, ctx.threads);

  const after = await manager.resolve(cwd);
  return buildSkillsListResponse(after);
}

export function buildSkillsListResponse(context: SkillSettingsContext): SkillsListResponse {
  const states = resolveSkillStates(context.discoveredSkills, context.config, context.layers);
  return {
    configPath: getGlobalConfigPath(),
    appliesOnNextTurn: true,
    skillsEnabled: context.config?.enabled ?? true,
    skillsEnabledControlledBy: resolveSkillsEnabledControl(context.layers),
    skills: states.map(
      (state): SkillDescriptor => ({
        name: state.skill.name,
        description: state.skill.description,
        source: state.skill.source,
        globalEnabled: state.globalEnabled,
        effectiveEnabled: state.effectiveEnabled,
        available: state.available,
        controlledBy: state.controlledBy,
        reason: state.reason,
      }),
    ),
  };
}
