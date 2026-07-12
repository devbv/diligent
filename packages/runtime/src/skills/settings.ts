// @summary Resolves layered config gates for discovered skills.

import type { DiligentConfigLayers } from "../config/loader";
import type { DiligentConfig } from "../config/schema";
import type { SkillMetadata } from "./types";

export type SkillStateReason = "enabled" | "disabled_by_user" | "skills_disabled";
export type SkillSettingController = "default" | "global" | "project";

export interface ResolvedSkillState {
  skill: SkillMetadata;
  globalEnabled: boolean;
  effectiveEnabled: boolean;
  available: boolean;
  controlledBy: SkillSettingController;
  reason: SkillStateReason;
}

export function resolveSkillsEnabledControl(layers: DiligentConfigLayers): SkillSettingController {
  if (layers.project?.skills?.enabled !== undefined) return "project";
  if (layers.global?.skills?.enabled !== undefined) return "global";
  return "default";
}

export function resolveSkillStates(
  skills: SkillMetadata[],
  resolvedConfig: DiligentConfig["skills"] | undefined,
  layers: DiligentConfigLayers,
): ResolvedSkillState[] {
  const skillsEnabled = resolvedConfig?.enabled ?? true;
  const globalOverrides = layers.global?.skills?.overrides ?? {};
  const projectOverrides = layers.project?.skills?.overrides ?? {};
  const effectiveOverrides = resolvedConfig?.overrides ?? {};

  return skills.map((skill) => {
    const globalEnabled = globalOverrides[skill.name] ?? true;
    const effectiveEnabled = effectiveOverrides[skill.name] ?? true;
    const controlledBy: SkillSettingController = Object.hasOwn(projectOverrides, skill.name)
      ? "project"
      : Object.hasOwn(globalOverrides, skill.name)
        ? "global"
        : "default";
    const available = skillsEnabled && effectiveEnabled;
    const reason: SkillStateReason = !skillsEnabled
      ? "skills_disabled"
      : effectiveEnabled
        ? "enabled"
        : "disabled_by_user";

    return {
      skill,
      globalEnabled,
      effectiveEnabled,
      available,
      controlledBy,
      reason,
    };
  });
}

export function filterAvailableSkills(states: ResolvedSkillState[]): SkillMetadata[] {
  return states.filter((state) => state.available).map((state) => state.skill);
}
