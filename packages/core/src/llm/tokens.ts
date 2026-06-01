// @summary Token estimation utility — chars/4 heuristic (D038, matches pi-agent)

import type { Message } from "../types";

/**
 * Estimate token count from message content.
 * Uses chars/4 heuristic (D038 — matches pi-agent).
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      chars += typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length;
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "tool_call") chars += JSON.stringify(block.input).length + block.name.length;
      }
    } else if (msg.role === "tool_result") {
      chars += msg.output.length;
      for (const img of msg.outputImages ?? []) {
        chars += img.source.data.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
