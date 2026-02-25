import { describe, expect, it } from "bun:test";
import { buildSessionContext } from "../src/session/context-builder";
import type { SessionEntry } from "../src/session/types";

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
});
