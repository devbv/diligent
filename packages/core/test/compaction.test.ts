import { describe, expect, it } from "bun:test";
import {
  estimateTokens,
  extractFileOperations,
  findCutPoint,
  formatFileOperations,
  shouldCompact,
} from "../src/session/compaction";
import type { SessionEntry } from "../src/session/types";
import type { Message } from "../src/types";

// --- Helper factories ---

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMsg(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function toolResultMsg(toolCallId: string, toolName: string, output: string): Message {
  return {
    role: "tool_result",
    toolCallId,
    toolName,
    output,
    isError: false,
    timestamp: Date.now(),
  };
}

function assistantWithToolCall(
  text: string,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_call", id: toolCallId, name: toolName, input },
    ],
    model: "test",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: Date.now(),
  };
}

function msgEntry(id: string, parentId: string | null, msg: Message): SessionEntry {
  return { type: "message", id, parentId, timestamp: new Date().toISOString(), message: msg };
}

// --- Tests ---

describe("estimateTokens", () => {
  it("estimates tokens for simple user message", () => {
    const messages = [userMsg("hello world")]; // 11 chars → ceil(11/4) = 3
    expect(estimateTokens(messages)).toBe(3);
  });

  it("estimates tokens for assistant message", () => {
    const messages = [assistantMsg("hello world")]; // 11 chars → 3
    expect(estimateTokens(messages)).toBe(3);
  });

  it("estimates tokens for tool result", () => {
    const output = "a".repeat(100); // 100 chars → 25
    const messages = [toolResultMsg("tc1", "bash", output)];
    expect(estimateTokens(messages)).toBe(25);
  });

  it("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("accumulates across multiple messages", () => {
    const messages = [
      userMsg("a".repeat(40)), // 40 chars → 10
      assistantMsg("b".repeat(80)), // 80 chars → 20
      toolResultMsg("tc1", "bash", "c".repeat(120)), // 120 chars → 30
    ];
    expect(estimateTokens(messages)).toBe(60);
  });

  it("handles thinking blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a".repeat(40) },
          { type: "text", text: "b".repeat(40) },
        ],
        model: "test",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
    ];
    expect(estimateTokens(messages)).toBe(20); // (40+40)/4
  });

  it("handles tool call blocks in assistant message", () => {
    const messages = [assistantWithToolCall("hi", "tc1", "bash", { command: "ls -la" })];
    // "hi" = 2 chars, tool_call: JSON.stringify({command:"ls -la"}) + "bash" = ~24 chars
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("shouldCompact", () => {
  it("returns true when tokens exceed threshold", () => {
    expect(shouldCompact(100_000, 200_000, 16_384)).toBe(false);
    expect(shouldCompact(190_000, 200_000, 16_384)).toBe(true);
    expect(shouldCompact(183_617, 200_000, 16_384)).toBe(true); // exactly at boundary
  });

  it("returns false when tokens are below threshold", () => {
    expect(shouldCompact(50_000, 200_000, 16_384)).toBe(false);
  });

  it("handles edge case: exactly at threshold", () => {
    // threshold = 200000 - 16384 = 183616
    expect(shouldCompact(183_616, 200_000, 16_384)).toBe(false);
    expect(shouldCompact(183_617, 200_000, 16_384)).toBe(true);
  });
});

describe("findCutPoint", () => {
  it("returns empty split for empty entries", () => {
    const result = findCutPoint([], 1000);
    expect(result.entriesToSummarize).toEqual([]);
    expect(result.entriesToKeep).toEqual([]);
  });

  it("keeps all entries when within budget", () => {
    const entries: SessionEntry[] = [msgEntry("a1", null, userMsg("hello")), msgEntry("a2", "a1", assistantMsg("hi"))];
    const result = findCutPoint(entries, 100_000);
    expect(result.entriesToSummarize).toHaveLength(0);
    expect(result.entriesToKeep).toHaveLength(2);
  });

  it("splits at user message boundary", () => {
    // Build a conversation with enough tokens to trigger splitting
    const longText = "x".repeat(400); // 100 tokens each
    const entries: SessionEntry[] = [
      msgEntry("a1", null, userMsg(longText)),
      msgEntry("a2", "a1", assistantMsg(longText)),
      msgEntry("a3", "a2", userMsg(longText)),
      msgEntry("a4", "a3", assistantMsg(longText)),
      msgEntry("a5", "a4", userMsg(longText)),
      msgEntry("a6", "a5", assistantMsg(longText)),
    ];

    // Keep 250 tokens → should keep last ~2.5 messages worth → snap to user boundary
    const result = findCutPoint(entries, 250);
    expect(result.entriesToSummarize.length).toBeGreaterThan(0);
    expect(result.entriesToKeep.length).toBeGreaterThan(0);
    // First kept entry should be a user message (turn boundary)
    const firstKept = result.entriesToKeep[0];
    if (firstKept.type === "message") {
      expect(firstKept.message.role).toBe("user");
    }
  });

  it("respects existing compaction entry", () => {
    const entries: SessionEntry[] = [
      msgEntry("a1", null, userMsg("old message")),
      msgEntry("a2", "a1", assistantMsg("old response")),
      {
        type: "compaction",
        id: "c1",
        parentId: "a2",
        timestamp: new Date().toISOString(),
        summary: "Previous summary",
        firstKeptEntryId: "a3",
        tokensBefore: 5000,
        tokensAfter: 1000,
      },
      msgEntry("a3", "c1", userMsg("new message")),
      msgEntry("a4", "a3", assistantMsg("new response")),
    ];

    // With a large budget, nothing to summarize (entries before compaction are excluded)
    const result = findCutPoint(entries, 100_000);
    expect(result.entriesToSummarize).toHaveLength(0);
    // Entries to keep should only include entries after compaction
    expect(result.entriesToKeep).toHaveLength(2);
  });

  it("handles single turn conversation", () => {
    const entries: SessionEntry[] = [
      msgEntry("a1", null, userMsg("hello")),
      msgEntry("a2", "a1", assistantMsg("hi there")),
    ];
    // Even with a small budget, we need at least the user message
    const result = findCutPoint(entries, 1);
    // Should still work without errors
    expect(result.entriesToSummarize.length + result.entriesToKeep.length).toBe(2);
  });
});

describe("extractFileOperations", () => {
  it("extracts read operations", () => {
    const messages: Message[] = [
      assistantWithToolCall("Reading file", "tc1", "read", { file_path: "/src/index.ts" }),
      toolResultMsg("tc1", "read", "file contents here"),
    ];
    const details = extractFileOperations(messages);
    expect(details.readFiles).toEqual(["/src/index.ts"]);
    expect(details.modifiedFiles).toEqual([]);
  });

  it("extracts write operations", () => {
    const messages: Message[] = [
      assistantWithToolCall("Writing file", "tc1", "write", { file_path: "/src/new.ts" }),
      toolResultMsg("tc1", "write", "File written"),
    ];
    const details = extractFileOperations(messages);
    expect(details.readFiles).toEqual([]);
    expect(details.modifiedFiles).toEqual(["/src/new.ts"]);
  });

  it("extracts edit operations", () => {
    const messages: Message[] = [
      assistantWithToolCall("Editing", "tc1", "edit", { file_path: "/src/mod.ts" }),
      toolResultMsg("tc1", "edit", "File edited"),
    ];
    const details = extractFileOperations(messages);
    expect(details.modifiedFiles).toEqual(["/src/mod.ts"]);
  });

  it("deduplicates file paths", () => {
    const messages: Message[] = [
      assistantWithToolCall("Read 1", "tc1", "read", { file_path: "/src/a.ts" }),
      toolResultMsg("tc1", "read", "contents"),
      assistantWithToolCall("Read 2", "tc2", "read", { file_path: "/src/a.ts" }),
      toolResultMsg("tc2", "read", "contents again"),
    ];
    const details = extractFileOperations(messages);
    expect(details.readFiles).toEqual(["/src/a.ts"]);
  });

  it("merges with previous compaction details", () => {
    const messages: Message[] = [
      assistantWithToolCall("Read", "tc1", "read", { file_path: "/src/new.ts" }),
      toolResultMsg("tc1", "read", "contents"),
    ];
    const previous = { readFiles: ["/src/old.ts"], modifiedFiles: ["/src/mod.ts"] };
    const details = extractFileOperations(messages, previous);
    expect(details.readFiles).toContain("/src/old.ts");
    expect(details.readFiles).toContain("/src/new.ts");
    expect(details.modifiedFiles).toContain("/src/mod.ts");
  });

  it("returns empty for messages without file operations", () => {
    const messages: Message[] = [userMsg("hello"), assistantMsg("hi")];
    const details = extractFileOperations(messages);
    expect(details.readFiles).toEqual([]);
    expect(details.modifiedFiles).toEqual([]);
  });
});

describe("formatFileOperations", () => {
  it("formats both read and modified files", () => {
    const result = formatFileOperations({
      readFiles: ["/src/a.ts", "/src/b.ts"],
      modifiedFiles: ["/src/c.ts"],
    });
    expect(result).toContain("## Files Read");
    expect(result).toContain("- /src/a.ts");
    expect(result).toContain("- /src/b.ts");
    expect(result).toContain("## Files Modified");
    expect(result).toContain("- /src/c.ts");
  });

  it("returns empty string for no file operations", () => {
    const result = formatFileOperations({ readFiles: [], modifiedFiles: [] });
    expect(result).toBe("");
  });

  it("handles only read files", () => {
    const result = formatFileOperations({ readFiles: ["/src/a.ts"], modifiedFiles: [] });
    expect(result).toContain("## Files Read");
    expect(result).not.toContain("## Files Modified");
  });
});
