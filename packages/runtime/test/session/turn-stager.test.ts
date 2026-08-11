// @summary Tests for TurnStager staging message and compaction events

import { describe, expect, test } from "bun:test";
import type { CoreAgentEvent } from "@diligent/core/agent";
import type { Message } from "@diligent/core/message-contract";
import { TurnStager } from "@diligent/runtime/session";

function makeUser(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

describe("TurnStager", () => {
  test("starts with the user message staged", () => {
    const stager = new TurnStager(null, makeUser("hello"), "persisted-user-1");
    const snapshot = stager.getSnapshot();

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.type).toBe("message");
    if (snapshot.entries[0]?.type === "message") {
      expect(snapshot.entries[0].id).toBe("persisted-user-1");
      expect(snapshot.entries[0].message.role).toBe("user");
    }
  });

  test("stages assistant and tool_result messages as their events arrive", () => {
    const stager = new TurnStager(null, makeUser("hello"));
    const messageStart: CoreAgentEvent = {
      type: "message_start",
      turnId: "t1",
      itemId: "render-only-assistant-id",
      message: {
        role: "assistant",
        content: [],
        model: { provider: "anthropic", modelId: "test-model" },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
    };
    const messageEnd: CoreAgentEvent = {
      type: "message_end",
      turnId: "t1",
      itemId: "render-only-assistant-id",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: { provider: "anthropic", modelId: "test-model" },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: Date.now(),
      },
    };
    const toolEnd: CoreAgentEvent = {
      type: "tool_end",
      turnId: "t1",
      itemId: "tool-item-1",
      toolCallId: "tc_1",
      toolName: "echo",
      input: {},
      output: "ok",
      isError: false,
      timestamp: Date.now(),
      metadata: {
        status: {
          kind: "invalid_scope",
          code: "filesystem_root",
          path: "/",
          retryable: false,
          actionable: true,
        },
      },
    };

    const started = stager.handleEvent(messageStart);
    const discarded = stager.handleEvent({
      type: "message_discarded",
      itemId: "render-only-assistant-id",
      error: { name: "ProviderError", message: "retry" },
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 1,
    });
    const restarted = stager.handleEvent(messageStart);
    const completed = stager.handleEvent(messageEnd);
    stager.handleEvent(toolEnd);
    const snapshot = stager.getSnapshot();

    expect(started.messageId).toBeDefined();
    expect(discarded.messageId).toBe(started.messageId);
    expect(restarted.messageId).toBe(started.messageId);
    expect(completed.messageId).toBe(started.messageId);
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries.map((entry) => entry.type)).toEqual(["message", "message", "message"]);
    if (snapshot.entries[1]?.type === "message" && snapshot.entries[2]?.type === "message") {
      expect(snapshot.entries[1].message.role).toBe("assistant");
      expect(snapshot.entries[1].id).toBe(started.messageId);
      expect(snapshot.entries[2].message.role).toBe("tool_result");
      expect(snapshot.entries[2].message.metadata).toMatchObject({
        status: { kind: "invalid_scope", code: "filesystem_root", path: "/" },
      });
    }
  });

  test("returns distinct persistent entry ids for injected steering messages", () => {
    const stager = new TurnStager(null, makeUser("hello"));

    const result = stager.handleEvent({
      type: "steering_injected",
      messageCount: 2,
      steerIds: ["duplicate-steer", "duplicate-steer"],
      messages: [makeUser("first"), makeUser("second")],
    });

    expect(result.messageIds).toHaveLength(2);
    expect(new Set(result.messageIds).size).toBe(2);
    expect(result.messageIds).not.toContain("duplicate-steer");
    expect(
      stager
        .getSnapshot()
        .entries.slice(1)
        .map((entry) => entry.id),
    ).toEqual(result.messageIds);
  });

  test("stages compaction before the fresh user message", () => {
    const stager = new TurnStager(null, makeUser("hello"));
    stager.handleEvent(
      {
        type: "compaction_end",
        turnId: "t1",
        summary: "summary",
        tokensBefore: 100,
        tokensAfter: 20,
      },
      20_000,
    );
    stager.handleEvent({ type: "turn_start", turnId: "t1" }, 20_000);

    const snapshot = stager.getSnapshot();
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.map((entry) => entry.type)).toEqual(["compaction", "message"]);
    expect(snapshot.entries[0]?.parentId).toBeNull();
    expect(snapshot.entries[1]?.parentId).toBe(snapshot.entries[0]?.id);
  });

  test("preserves compaction summary on compaction_end", () => {
    const stager = new TurnStager(null, makeUser("hello"));
    const compactionSummary = {
      type: "diligent_openai_compaction_state",
      items: [{ type: "message", role: "user", content: [] }],
    };
    stager.handleEvent(
      {
        type: "compaction_end",
        turnId: "t1",
        summary: "Compacted",
        compactionSummary,
        tokensBefore: 100,
        tokensAfter: 20,
      },
      20_000,
    );

    const snapshot = stager.getSnapshot();
    expect(snapshot.entries[0]?.type).toBe("compaction");
    if (snapshot.entries[0]?.type === "compaction") {
      expect(snapshot.entries[0].compactionSummary).toEqual(compactionSummary);
    }
  });

  test("stages context injections as internal entries with source and runtime metadata", () => {
    const stager = new TurnStager(null, makeUser("hello"));
    stager.handleEvent(
      {
        type: "context_injected",
        injections: [
          {
            source: "test-hook",
            message: makeUser("internal"),
            metadata: {
              presentation: { kind: "human-edits", title: "Human edits detected", content: "Added: Ramp" },
            },
          },
        ],
      },
      20_000,
    );

    const entry = stager.getSnapshot().entries[1];
    expect(entry).toMatchObject({
      type: "message",
      visibility: "internal",
      source: "test-hook",
      presentation: { kind: "human-edits", title: "Human edits detected", content: "Added: Ramp" },
    });
  });
});
