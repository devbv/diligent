import type { SessionEntry, ToolCallBlock, ToolCallPair, ToolResultEntry } from "./types.js";

/**
 * Pair tool calls (from AssistantMessage content blocks) with their ToolResultEntry results.
 * Keyed by toolCallId.
 */
export function pairToolCalls(entries: SessionEntry[]): Map<string, ToolCallPair> {
  const pairs = new Map<string, ToolCallPair>();

  // Index tool results by toolCallId
  const resultMap = new Map<string, ToolResultEntry>();
  for (const entry of entries) {
    if ("role" in entry && entry.role === "tool_result") {
      resultMap.set(entry.toolCallId, entry);
    }
  }

  // Walk assistant messages
  for (const entry of entries) {
    if ("role" in entry && entry.role === "assistant") {
      for (const block of entry.content) {
        if (block.type === "tool_call") {
          const toolCall = block as ToolCallBlock;
          const result = resultMap.get(toolCall.id);
          pairs.set(toolCall.id, {
            call: toolCall,
            result,
            assistantMessageId: entry.id,
            startTime: entry.timestamp,
            endTime: result?.timestamp,
          });
        }
      }
    }
  }

  return pairs;
}
