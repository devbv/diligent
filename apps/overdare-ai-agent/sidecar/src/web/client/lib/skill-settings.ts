// @summary Helpers for configurable runtime skill settings drafts and payloads

import type { SkillsListResponse, SkillsSetParams } from "@diligent/protocol";

export interface SkillSettingsDraft {
  overrides: Record<string, boolean>;
}

export function createSkillDraft(state: SkillsListResponse): SkillSettingsDraft {
  return {
    overrides: Object.fromEntries(state.skills.map((skill) => [skill.name, skill.globalEnabled])),
  };
}

export function buildSkillsSetParams(
  threadId: string | null | undefined,
  state: SkillsListResponse,
  draft: SkillSettingsDraft,
): SkillsSetParams {
  const overrides: Record<string, boolean> = {};
  for (const skill of state.skills) {
    if (skill.controlledBy === "project") continue;
    const drafted = draft.overrides[skill.name] ?? skill.globalEnabled;
    if (drafted !== skill.globalEnabled) {
      overrides[skill.name] = drafted;
    }
  }
  return threadId ? { threadId, overrides } : { overrides };
}

export function hasSkillDraftChanged(state: SkillsListResponse, draft: SkillSettingsDraft): boolean {
  return Object.keys(buildSkillsSetParams(undefined, state, draft).overrides).length > 0;
}
