// @summary Tests for thread read snapshot item assembly

import { describe, expect, test } from "bun:test";
import { buildThreadReadItems, type ThreadReadTranscriptEntry } from "@diligent/runtime/app-server/thread-read-builder";

describe("buildThreadReadItems", () => {
  test("preserves tool_result status and metadata on completed toolCall items", () => {
    const transcript: ThreadReadTranscriptEntry[] = [
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc-1", name: "demo", input: { query: "x" } }],
          model: "unknown",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp: 100,
        },
      },
      {
        type: "message",
        id: "tool-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "tool_result",
          toolCallId: "tc-1",
          toolName: "demo",
          output: "ok",
          isError: false,
          timestamp: 150,
          status: { kind: "completed", label: "Done", severity: "info" },
          metadata: { requestId: "req-1" },
        },
      },
    ];

    const completedToolCall = buildThreadReadItems(transcript).find(
      (item) => item.type === "toolCall" && item.output === "ok",
    );

    expect(completedToolCall).toMatchObject({
      type: "toolCall",
      status: { kind: "completed", label: "Done", severity: "info" },
      metadata: { requestId: "req-1" },
    });
  });
});
