// @summary Tests that estimateTokens counts images by a bounded per-image estimate, NOT base64
// length (which over-counts ~100-1000x and spuriously triggers compaction → prompt-cache churn).
import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../src/llm/tokens";
import type { Message } from "../../src/types";

const bigBase64 = "A".repeat(400_000); // ~100k "tokens" if counted as chars/4

describe("estimateTokens", () => {
  test("counts plain text by chars/4", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(40) }])).toBe(10);
  });

  test("does NOT count a tool_result image's base64 length", () => {
    const messages: Message[] = [
      {
        role: "tool_result",
        toolCallId: "t1",
        output: "ok",
        outputImages: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bigBase64 } }],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeLessThan(2000); // base64-counting would give ~100,000
    expect(tokens).toBeGreaterThanOrEqual(1000); // but the image is still counted, not ignored
  });

  test("does NOT count a user image block's base64 length", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bigBase64 } }],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeLessThan(2000);
    expect(tokens).toBeGreaterThanOrEqual(1000);
  });

  test("scales with the number of images", () => {
    const img = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png" as const, data: bigBase64 },
    };
    const one = estimateTokens([{ role: "tool_result", toolCallId: "t", output: "", outputImages: [img] }]);
    const three = estimateTokens([{ role: "tool_result", toolCallId: "t", output: "", outputImages: [img, img, img] }]);
    expect(three).toBeGreaterThan(one * 2); // roughly 3x the per-image estimate
  });

  test("still counts assistant text and tool_call input", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "y".repeat(20) },
          { type: "tool_call", id: "c", name: "do", input: { a: "z".repeat(16) } },
        ],
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 0,
      },
    ];
    expect(estimateTokens(messages)).toBeGreaterThan(0);
    expect(estimateTokens(messages)).toBeLessThan(100);
  });
});
