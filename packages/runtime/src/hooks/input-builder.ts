// @summary Conversation data extraction utilities for building hook input payloads

import type { AssistantMessage, Message } from "@diligent/core/message-contract";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Aggregate token usage across all assistant messages in a context array. */
export function getSessionUsage(messages: Message[]): SessionUsage {
  const total: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const { usage } = msg as AssistantMessage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return total;
}

/**
 * Aggregate token usage for the current turn only.
 * The turn boundary is the last user message in the context.
 */
export function getTurnUsage(messages: Message[]): SessionUsage {
  const total: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  for (let i = lastUserIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const { usage } = msg as AssistantMessage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
  }

  return total;
}

/** Extract the text content of the last assistant message from a context array. */
export function getLastAssistantMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const { content } = msg;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
  }
  return "";
}
