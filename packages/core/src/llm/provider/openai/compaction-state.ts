// @summary Lossless persisted state for OpenAI-family compacted response-item histories

export const OPENAI_COMPACTION_STATE_TYPE = "diligent_openai_compaction_state";

type OpenAICompactionState = {
  type: typeof OPENAI_COMPACTION_STATE_TYPE;
  items: Record<string, unknown>[];
};

function isResponseItem(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string";
}

/** Preserve the compact endpoint's complete replacement history without converting provider-owned items. */
export function extractOpenAICompactionState(payload: Record<string, unknown>): OpenAICompactionState | undefined {
  if (!Array.isArray(payload.output) || payload.output.length === 0 || !payload.output.every(isResponseItem)) {
    return undefined;
  }
  return {
    type: OPENAI_COMPACTION_STATE_TYPE,
    items: payload.output,
  };
}

/** Expand persisted replacement history, while continuing to accept legacy single compaction items. */
export function openAICompactionStateToInputItems(state: Record<string, unknown>): Record<string, unknown>[] {
  if (state.type !== OPENAI_COMPACTION_STATE_TYPE) return [state];
  if (!Array.isArray(state.items) || state.items.length === 0 || !state.items.every(isResponseItem)) {
    throw new Error("Invalid persisted OpenAI compaction state");
  }
  return state.items;
}
