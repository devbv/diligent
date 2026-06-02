// @summary Token estimation utility — chars/4 heuristic (D038, matches pi-agent)

import type { Message } from "../types";

const CHARS_PER_TOKEN = 4;

// Images cost a roughly fixed, resolution-bounded number of tokens regardless of byte size: base64 is
// transport only, decoded server-side before the vision encoder. Counting base64 length here would
// over-count ~100-1000x and spuriously trip compaction — which prepends a summary and reshuffles the
// message prefix, destroying prompt-cache hits on every image-bearing turn. A bounded per-image
// estimate (providers cap image cost around 85-1600 tokens) keeps the trigger honest.
const IMAGE_TOKEN_ESTIMATE = 1500;

/**
 * Estimate token count from message content.
 * Text uses the chars/4 heuristic (D038 — matches pi-agent); images use a bounded per-image estimate.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  let imageTokens = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === "text") chars += block.text.length;
          // `image` carries base64 data; `local_image` is materialized to an image before sending.
          else if (block.type === "image" || block.type === "local_image") imageTokens += IMAGE_TOKEN_ESTIMATE;
          else chars += JSON.stringify(block).length;
        }
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "tool_call") chars += JSON.stringify(block.input).length + block.name.length;
      }
    } else if (msg.role === "tool_result") {
      chars += msg.output.length;
      imageTokens += (msg.outputImages?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + imageTokens;
}
