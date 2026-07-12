// @summary Helpers for global-only subagent settings drafts and update payloads

import type { SubagentsListResponse, SubagentsSetParams } from "@diligent/protocol";

export interface SubagentSettingsDraft {
  overrides: Record<string, boolean>;
}

export function createSubagentDraft(state: SubagentsListResponse): SubagentSettingsDraft {
  return {
    overrides: Object.fromEntries(state.subagents.map((subagent) => [subagent.name, subagent.globalEnabled])),
  };
}

export function buildSubagentsSetParams(
  threadId: string | null | undefined,
  state: SubagentsListResponse,
  draft: SubagentSettingsDraft,
): SubagentsSetParams {
  const overrides: Record<string, boolean> = {};
  for (const subagent of state.subagents) {
    if (subagent.required || subagent.controlledBy === "project") continue;
    const drafted = draft.overrides[subagent.name] ?? subagent.globalEnabled;
    if (drafted !== subagent.globalEnabled) overrides[subagent.name] = drafted;
  }
  return threadId ? { threadId, overrides } : { overrides };
}

export function hasSubagentDraftChanged(state: SubagentsListResponse, draft: SubagentSettingsDraft): boolean {
  return Object.keys(buildSubagentsSetParams(undefined, state, draft).overrides).length > 0;
}
