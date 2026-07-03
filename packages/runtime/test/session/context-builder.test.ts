// @summary Tests for building context from session entries
import { describe, expect, it } from "bun:test";
import type { Message } from "@diligent/core/types";
import type { CompactionEntry, SessionEntry } from "@diligent/runtime/session";
import { buildSessionContext, buildSessionTranscript } from "@diligent/runtime/session";

function msgContent(msg: Message): string {
  if (msg.role === "user") return typeof msg.content === "string" ? msg.content : "";
  if (msg.role === "assistant") {
    const t = msg.content.find((b) => b.type === "text");
    return t?.type === "text" ? t.text : "";
  }
  return "";
}

function makeMsg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntry {
  if (role === "user") {
    return {
      type: "message",
      id,
      parentId,
      timestamp: "2026-02-25T10:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1708900000000 },
    };
  }
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-02-25T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn",
      timestamp: 1708900000000,
    },
  };
}

describe("buildSessionContext", () => {
  it("returns empty messages for empty entries", () => {
    const ctx = buildSessionContext([]);
    expect(ctx.messages).toEqual([]);
  });

  it("extracts linear message chain", () => {
    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "hello"),
      makeMsg("a2", "a1", "assistant", "hi"),
      makeMsg("a3", "a2", "user", "how?"),
    ];

    const ctx = buildSessionContext(entries);
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[1].role).toBe("assistant");
    expect(ctx.messages[2].role).toBe("user");
  });

  it("follows correct branch in tree structure", () => {
    // Tree:
    //   a1 (user: hello)
    //   ├── a2 (assistant: branch A)
    //   └── a3 (assistant: branch B)
    //        └── a4 (user: continue B)
    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "hello"),
      makeMsg("a2", "a1", "assistant", "branch A"),
      makeMsg("a3", "a1", "assistant", "branch B"),
      makeMsg("a4", "a3", "user", "continue B"),
    ];

    // Default (last entry = a4) → follows a1 → a3 → a4
    const ctx = buildSessionContext(entries);
    expect(ctx.messages).toHaveLength(3);
    if (ctx.messages[1].role === "assistant") {
      const content = ctx.messages[1].content;
      expect(content[0].type === "text" && content[0].text).toBe("branch B");
    }

    // Explicit leaf at a2 → follows a1 → a2
    const ctxA = buildSessionContext(entries, "a2");
    expect(ctxA.messages).toHaveLength(2);
  });

  it("tracks model and effort changes", () => {
    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "hi"),
      {
        type: "model_change",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-02-25T10:00:01.000Z",
        provider: "anthropic",
        modelId: "claude-opus-4-20250514",
      },
      {
        type: "effort_change",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-02-25T10:00:02.000Z",
        effort: "medium",
        changedBy: "command",
      },
      makeMsg("a4", "a3", "assistant", "hello"),
    ];

    const ctx = buildSessionContext(entries);
    expect(ctx.currentModel?.provider).toBe("anthropic");
    expect(ctx.currentModel?.modelId).toBe("claude-opus-4-20250514");
    expect(ctx.currentEffort).toBe("medium");
    expect(ctx.messages).toHaveLength(2); // non-message changes don't produce messages
  });

  it("returns empty for unknown leafId", () => {
    const entries: SessionEntry[] = [makeMsg("a1", null, "user", "hi")];
    const ctx = buildSessionContext(entries, "nonexistent");
    expect(ctx.messages).toEqual([]);
  });

  it("handles CompactionEntry — recent user msgs + summary + new turns", () => {
    const recentUserMsg = { role: "user" as const, content: "kept user msg", timestamp: 1708900000000 };
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      summary: "## Goal\nRefactor config module",
      recentUserMessages: [recentUserMsg],
      tokensBefore: 50000,
      tokensAfter: 5000,
    };

    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "old message 1"),
      makeMsg("a2", "a1", "assistant", "old response 1"),
      compaction,
      makeMsg("a3", "c1", "user", "new message"),
      makeMsg("a4", "a3", "assistant", "new response"),
    ];

    const ctx = buildSessionContext(entries);
    // recent user msg + summary + new user + new assistant
    expect(ctx.messages).toHaveLength(4);
    // First: recent user message
    expect(ctx.messages[0].role).toBe("user");
    expect(msgContent(ctx.messages[0])).toBe("kept user msg");
    // Second: summary
    expect(ctx.messages[1].role).toBe("user");
    expect(msgContent(ctx.messages[1])).toContain("Refactor config module");
    // Third + Fourth: new turns
    expect(ctx.messages[2].role).toBe("user");
    expect(ctx.messages[3].role).toBe("assistant");
  });

  it("uses latest CompactionEntry when multiple exist", () => {
    const compaction1: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      summary: "First summary",
      recentUserMessages: [],
      tokensBefore: 50000,
      tokensAfter: 5000,
    };
    const middleUserMsg = { role: "user" as const, content: "middle message", timestamp: 1708900000000 };
    const compaction2: CompactionEntry = {
      type: "compaction",
      id: "c2",
      parentId: "a4",
      timestamp: "2026-02-25T10:02:00.000Z",
      summary: "Second summary",
      recentUserMessages: [middleUserMsg],
      tokensBefore: 30000,
      tokensAfter: 3000,
    };

    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "very old"),
      makeMsg("a2", "a1", "assistant", "very old response"),
      compaction1,
      makeMsg("a3", "c1", "user", "middle message"),
      makeMsg("a4", "a3", "assistant", "middle response"),
      compaction2,
      makeMsg("a5", "c2", "user", "latest"),
    ];

    const ctx = buildSessionContext(entries);
    // recent user msg from c2 + summary + latest user msg
    expect(ctx.messages).toHaveLength(3);
    expect(msgContent(ctx.messages[0])).toBe("middle message");
    const summaryContent = msgContent(ctx.messages[1]);
    expect(summaryContent).toContain("Second summary");
    expect(summaryContent).not.toContain("First summary");
    expect(ctx.messages[2].role).toBe("user");
  });

  it("returns compaction summary separately for native compaction entries", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      displaySummary: "Compacted",
      compactionSummary: { type: "compaction", encrypted_content: "opaque" },
      tokensBefore: 50000,
      tokensAfter: 5000,
    };

    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "old message 1"),
      makeMsg("a2", "a1", "assistant", "old response 1"),
      compaction,
      makeMsg("a3", "c1", "user", "new message"),
    ];

    const ctx = buildSessionContext(entries);
    expect(ctx.compactionSummary).toEqual({ type: "compaction", encrypted_content: "opaque" });
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.providerMessages).toHaveLength(1);
    expect(msgContent(ctx.messages[0])).toBe("Compacted");
    expect(msgContent(ctx.messages[1])).toBe("new message");
    expect(msgContent(ctx.providerMessages[0])).toBe("new message");
  });

  it("no compaction — existing behavior unchanged", () => {
    const entries: SessionEntry[] = [makeMsg("a1", null, "user", "hello"), makeMsg("a2", "a1", "assistant", "hi")];
    const ctx = buildSessionContext(entries);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[1].role).toBe("assistant");
  });
});

describe("buildSessionTranscript", () => {
  it("preserves full visible conversation history across compaction", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      displaySummary: "Compacted summary",
      recentUserMessages: [{ role: "user", content: "kept user msg", timestamp: 1708900000000 }],
      tokensBefore: 50000,
      tokensAfter: 5000,
    };

    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "old user"),
      makeMsg("a2", "a1", "assistant", "old assistant"),
      compaction,
      makeMsg("a3", "c1", "user", "new user"),
    ];

    const transcript = buildSessionTranscript(entries);
    expect(transcript).toHaveLength(4);
    expect(transcript[0]).toMatchObject({ type: "message" });
    expect(transcript[1]).toMatchObject({ type: "message" });
    expect(transcript[2]).toMatchObject({ type: "compaction" });
    expect(transcript[3]).toMatchObject({ type: "message" });
    expect(transcript[2] && transcript[2].type === "compaction" ? transcript[2].summary : "").toContain(
      "Compacted summary",
    );
  });

  it("preserves detailed native compaction summary separately from display label", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      summary: "## Goal\nRecover Anthropic compacted details",
      displaySummary: "Compacted",
      compactionSummary: { type: "compaction", encrypted_content: "opaque" },
      tokensBefore: 50000,
      tokensAfter: 5000,
    };

    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "old user"),
      makeMsg("a2", "a1", "assistant", "old assistant"),
      compaction,
      makeMsg("a3", "c1", "user", "new user"),
    ];

    const transcript = buildSessionTranscript(entries);
    expect(transcript[2]).toMatchObject({ type: "compaction" });
    expect(transcript[2] && transcript[2].type === "compaction" ? transcript[2].summary : "").toContain(
      "Recover Anthropic compacted details",
    );
    expect(transcript[2] && transcript[2].type === "compaction" ? transcript[2].displaySummary : "").toBe("Compacted");
  });
});
