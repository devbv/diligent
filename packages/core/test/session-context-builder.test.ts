import { describe, expect, it } from "bun:test";
import { buildSessionContext } from "../src/session/context-builder";
import type { CompactionEntry, SessionEntry } from "../src/session/types";

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

  it("tracks model changes", () => {
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
      makeMsg("a3", "a2", "assistant", "hello"),
    ];

    const ctx = buildSessionContext(entries);
    expect(ctx.currentModel?.provider).toBe("anthropic");
    expect(ctx.currentModel?.modelId).toBe("claude-opus-4-20250514");
    expect(ctx.messages).toHaveLength(2); // model_change doesn't produce a message
  });

  it("returns empty for unknown leafId", () => {
    const entries: SessionEntry[] = [makeMsg("a1", null, "user", "hi")];
    const ctx = buildSessionContext(entries, "nonexistent");
    expect(ctx.messages).toEqual([]);
  });

  it("handles CompactionEntry — summary replaces older messages", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      summary: "## Goal\nRefactor config module",
      firstKeptEntryId: "a3",
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
    // First message should be the summary injection
    expect(ctx.messages).toHaveLength(3); // summary + new user + new assistant
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[0].content as string).toContain("[Session Summary]");
    expect(ctx.messages[0].content as string).toContain("Refactor config module");
    expect(ctx.messages[1].role).toBe("user");
    expect(ctx.messages[2].role).toBe("assistant");
  });

  it("handles CompactionEntry with file operation details", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      summary: "Summary text",
      firstKeptEntryId: "a3",
      tokensBefore: 50000,
      tokensAfter: 5000,
      details: {
        readFiles: ["/src/a.ts", "/src/b.ts"],
        modifiedFiles: ["/src/c.ts"],
      },
    };

    const entries: SessionEntry[] = [
      makeMsg("a1", null, "user", "old"),
      makeMsg("a2", "a1", "assistant", "old"),
      compaction,
      makeMsg("a3", "c1", "user", "new"),
    ];

    const ctx = buildSessionContext(entries);
    const summaryContent = ctx.messages[0].content as string;
    expect(summaryContent).toContain("Files Read");
    expect(summaryContent).toContain("/src/a.ts");
    expect(summaryContent).toContain("Files Modified");
    expect(summaryContent).toContain("/src/c.ts");
  });

  it("uses latest CompactionEntry when multiple exist", () => {
    const compaction1: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-02-25T10:01:00.000Z",
      summary: "First summary",
      firstKeptEntryId: "a3",
      tokensBefore: 50000,
      tokensAfter: 5000,
    };
    const compaction2: CompactionEntry = {
      type: "compaction",
      id: "c2",
      parentId: "a4",
      timestamp: "2026-02-25T10:02:00.000Z",
      summary: "Second summary",
      firstKeptEntryId: "a5",
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
    const summaryContent = ctx.messages[0].content as string;
    expect(summaryContent).toContain("Second summary");
    expect(summaryContent).not.toContain("First summary");
    expect(ctx.messages).toHaveLength(2); // summary + latest user msg
  });

  it("no compaction — existing behavior unchanged", () => {
    const entries: SessionEntry[] = [makeMsg("a1", null, "user", "hello"), makeMsg("a2", "a1", "assistant", "hi")];
    const ctx = buildSessionContext(entries);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[1].role).toBe("assistant");
  });
});
