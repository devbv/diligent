// @summary Persisted state for OpenAI-family compacted response-item histories, pruned to what replay needs

export const OPENAI_COMPACTION_STATE_TYPE = "diligent_openai_compaction_state";

type OpenAICompactionState = {
  type: typeof OPENAI_COMPACTION_STATE_TYPE;
  items: Record<string, unknown>[];
};

function isResponseItem(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string";
}

const COMPACTION_ITEM_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"]);

/**
 * Mirror codex-rs `should_keep_compacted_history_item`: the compact endpoint returns a full
 * replacement transcript whose bulk is echoed instruction content, reasoning, and tool
 * call/output items. Those details are already distilled into the compaction item(s), and the
 * system prompt and tool schemas are re-sent fresh on every request — so persisting the echoes
 * only inflates the compacted context. In the QA-10459 session, tool call/output and reasoning
 * content made up ~81% of the message tokens; keeping the full transcript made the "compacted"
 * state nearly as large as the original history. Keep real conversation messages and the
 * compaction state items; drop the rest (call/output items are dropped as pairs, so no orphans).
 */
function shouldKeepCompactedItem(item: Record<string, unknown>): boolean {
  if (item.type === "message") {
    return item.role === "user" || item.role === "assistant";
  }
  return COMPACTION_ITEM_TYPES.has(item.type as string);
}

/** Extract the compact endpoint's replacement history, pruned to conversation and compaction items. */
export function extractOpenAICompactionState(payload: Record<string, unknown>): OpenAICompactionState | undefined {
  if (!Array.isArray(payload.output) || payload.output.length === 0 || !payload.output.every(isResponseItem)) {
    return undefined;
  }
  const items = payload.output.filter(shouldKeepCompactedItem);
  if (items.length === 0) {
    return undefined;
  }
  return {
    type: OPENAI_COMPACTION_STATE_TYPE,
    items,
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
