// @summary Tests for TurnStager staging message and compaction events

import { describe, expect, test } from "bun:test";
import type { CoreAgentEvent } from "@diligent/core/agent";
import type { Message } from "@diligent/core/types";
import { TurnStager } from "@diligent/runtime/session";

function makeUser(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

describe("TurnStager", () => {
  test("starts with the user message staged", () => {
    const stager = new TurnStager(null, [], makeUser("hello"));
    const snapshot = stager.getSnapshot();

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.type).toBe("message");
    if (snapshot.entries[0]?.type === "message") {
      expect(snapshot.entries[0].message.role).toBe("user");
    }
  });

  test("stages assistant and tool_result messages as their events arrive", () => {
    const stager = new TurnStager(null, [], makeUser("hello"));
    const messageEnd: CoreAgentEvent = {
      type: "message_end",
      turnId: "t1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: Date.now(),
      },
    };
    const toolEnd: CoreAgentEvent = {
      type: "tool_end",
      turnId: "t1",
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

    stager.handleEvent(messageEnd, 20_000);
    stager.handleEvent(toolEnd, 20_000);
    const snapshot = stager.getSnapshot();

    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries.map((entry) => entry.type)).toEqual(["message", "message", "message"]);
    if (snapshot.entries[1]?.type === "message" && snapshot.entries[2]?.type === "message") {
      expect(snapshot.entries[1].message.role).toBe("assistant");
      expect(snapshot.entries[2].message.role).toBe("tool_result");
      expect(snapshot.entries[2].message.metadata).toMatchObject({
        status: { kind: "invalid_scope", code: "filesystem_root", path: "/" },
      });
    }
  });

  test("stages compaction entry on compaction_end", () => {
    const stager = new TurnStager(null, [], makeUser("hello"));
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

    const snapshot = stager.getSnapshot();
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[1]?.type).toBe("compaction");
  });

  test("preserves compaction summary on compaction_end", () => {
    const stager = new TurnStager(null, [], makeUser("hello"));
    stager.handleEvent(
      {
        type: "compaction_end",
        turnId: "t1",
        summary: "Compacted",
        compactionSummary: { type: "compaction", encrypted_content: "opaque" },
        tokensBefore: 100,
        tokensAfter: 20,
      },
      20_000,
    );

    const snapshot = stager.getSnapshot();
    expect(snapshot.entries[1]?.type).toBe("compaction");
    if (snapshot.entries[1]?.type === "compaction") {
      expect(snapshot.entries[1].compactionSummary).toEqual({ type: "compaction", encrypted_content: "opaque" });
    }
  });
});
