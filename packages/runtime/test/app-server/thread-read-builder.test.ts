// @summary Tests for thread read snapshot assembly

import { describe, expect, test } from "bun:test";
import { buildThreadReadItems } from "../../src/app-server/thread-read-builder";

describe("buildThreadReadItems", () => {
  test("preserves presentable context injections as context snapshot items", () => {
    const items = buildThreadReadItems([
      {
        type: "context",
        id: "ctx-1",
        timestamp: "2026-07-16T00:00:00.000Z",
        source: "studiorpc-human-edits",
        presentation: { kind: "human-edits", title: "Human edits detected", content: "Added: Ramp" },
      },
    ]);

    expect(items).toEqual([
      {
        type: "contextMessage",
        itemId: "ctx-1",
        source: "studiorpc-human-edits",
        presentation: { kind: "human-edits", title: "Human edits detected", content: "Added: Ramp" },
        timestamp: Date.parse("2026-07-16T00:00:00.000Z"),
      },
    ]);
  });

  test("preserves tool result metadata on tool call snapshots", () => {
    const items = buildThreadReadItems([
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-07-02T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc_1", name: "glob", input: { pattern: "**/*", path: "/" } }],
          model: "test-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp: 100,
        },
      },
      {
        type: "message",
        id: "tool-1",
        timestamp: "2026-07-02T00:00:01.000Z",
        message: {
          role: "tool_result",
          toolCallId: "tc_1",
          toolName: "glob",
          output: "Error: refusing to glob the filesystem root: /",
          isError: true,
          timestamp: 110,
          metadata: {
            error: true,
            status: {
              kind: "invalid_scope",
              code: "filesystem_root",
              path: "/",
              retryable: false,
              actionable: true,
            },
          },
        },
      },
    ]);

    const toolItem = items.find((item) => item.type === "toolCall" && item.output);
    expect(toolItem).toMatchObject({
      type: "toolCall",
      toolCallId: "tc_1",
      metadata: {
        error: true,
        status: { kind: "invalid_scope", code: "filesystem_root", path: "/" },
      },
    });
  });
});
