import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  buildTree,
  detectEntryType,
  extractSessionMeta,
  IncrementalParser,
  pairToolCalls,
  parseSessionFile,
  parseSessionText,
} from "../src/server/parser.js";

const SAMPLE_DIR = join(import.meta.dir, "../src/server/sample-data/sessions");

describe("detectEntryType", () => {
  test("detects user message by role", () => {
    const entry = detectEntryType({ id: "m1", role: "user", content: "hi", timestamp: 1 });
    expect(entry).not.toBeNull();
    expect(entry!.role).toBe("user");
  });

  test("detects assistant message by role", () => {
    const entry = detectEntryType({
      id: "m2",
      role: "assistant",
      content: [],
      model: "test",
      usage: {},
      stopReason: "end_turn",
      timestamp: 1,
    });
    expect(entry).not.toBeNull();
    expect((entry as { role: string }).role).toBe("assistant");
  });

  test("detects tool_result by role", () => {
    const entry = detectEntryType({
      id: "m3",
      role: "tool_result",
      toolCallId: "tc1",
      toolName: "read",
      output: "",
      isError: false,
      timestamp: 1,
    });
    expect(entry).not.toBeNull();
    expect((entry as { role: string }).role).toBe("tool_result");
  });

  test("detects session_header by type", () => {
    const entry = detectEntryType({
      type: "session_header",
      id: "s1",
      timestamp: 1,
      cwd: "/",
      version: "0.0.1",
    });
    expect(entry).not.toBeNull();
    expect((entry as { type: string }).type).toBe("session_header");
  });

  test("detects compaction by type", () => {
    const entry = detectEntryType({
      id: "c1",
      type: "compaction",
      summary: "test",
      details: { readFiles: [], modifiedFiles: [] },
      timestamp: 1,
    });
    expect(entry).not.toBeNull();
    expect((entry as { type: string }).type).toBe("compaction");
  });

  test("returns null for unknown entry type", () => {
    const entry = detectEntryType({ foo: "bar" });
    expect(entry).toBeNull();
  });

  // Core envelope format tests
  test("detects core session header (type: session)", () => {
    const entry = detectEntryType({
      type: "session",
      version: 1,
      id: "20260225045827-f33876",
      timestamp: "2026-02-25T04:58:27.696Z",
      cwd: "/home/user/project",
    });
    expect(entry).not.toBeNull();
    expect((entry as { type: string }).type).toBe("session_header");
    expect((entry as { id: string }).id).toBe("20260225045827-f33876");
    expect((entry as { cwd: string }).cwd).toBe("/home/user/project");
    expect((entry as { timestamp: number }).timestamp).toBe(new Date("2026-02-25T04:58:27.696Z").getTime());
  });

  test("detects core message envelope (user)", () => {
    const entry = detectEntryType({
      type: "message",
      id: "a54ceb01",
      parentId: null,
      timestamp: "2026-02-25T04:58:30.000Z",
      message: { role: "user", content: "hello", timestamp: 1771995505590 },
    });
    expect(entry).not.toBeNull();
    expect((entry as { role: string }).role).toBe("user");
    expect((entry as { id: string }).id).toBe("a54ceb01");
    expect((entry as { content: string }).content).toBe("hello");
    expect((entry as { timestamp: number }).timestamp).toBe(1771995505590);
  });

  test("detects core message envelope (assistant)", () => {
    const entry = detectEntryType({
      type: "message",
      id: "b12def02",
      parentId: "a54ceb01",
      timestamp: "2026-02-25T04:58:31.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1771995506000,
      },
    });
    expect(entry).not.toBeNull();
    expect((entry as { role: string }).role).toBe("assistant");
    expect((entry as { id: string }).id).toBe("b12def02");
    expect((entry as { parentId: string }).parentId).toBe("a54ceb01");
    expect((entry as { model: string }).model).toBe("claude-sonnet-4-20250514");
  });

  test("detects core message envelope (tool_result)", () => {
    const entry = detectEntryType({
      type: "message",
      id: "c34fab03",
      parentId: "b12def02",
      timestamp: "2026-02-25T04:58:32.000Z",
      message: {
        role: "tool_result",
        toolCallId: "tc-001",
        toolName: "read",
        output: "file contents",
        isError: false,
        timestamp: 1771995507000,
      },
    });
    expect(entry).not.toBeNull();
    expect((entry as { role: string }).role).toBe("tool_result");
    expect((entry as { toolName: string }).toolName).toBe("read");
  });

  test("skips model_change and session_info without warning", () => {
    expect(
      detectEntryType({ type: "model_change", id: "x", parentId: null, timestamp: "t", provider: "a", modelId: "b" }),
    ).toBeNull();
    expect(detectEntryType({ type: "session_info", id: "x", parentId: null, timestamp: "t", name: "test" })).toBeNull();
  });
});

describe("parseSessionFile", () => {
  test("parses sample-001 (simple 2-turn)", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    expect(entries.length).toBe(9);

    // First entry is session header
    const header = entries[0];
    expect("type" in header && header.type).toBe("session_header");

    // Should have user messages
    const users = entries.filter((e) => "role" in e && e.role === "user");
    expect(users.length).toBe(2);

    // Should have assistant messages
    const assistants = entries.filter((e) => "role" in e && e.role === "assistant");
    expect(assistants.length).toBe(4);

    // Should have tool results
    const tools = entries.filter((e) => "role" in e && e.role === "tool_result");
    expect(tools.length).toBe(2);
  });

  test("parses sample-002 (complex with error)", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-002.jsonl"));
    expect(entries.length).toBe(12);

    // Should have an error tool result
    const errors = entries.filter((e) => "role" in e && e.role === "tool_result" && e.isError);
    expect(errors.length).toBe(1);

    // Should have thinking blocks in assistant messages
    const assistants = entries.filter((e) => "role" in e && e.role === "assistant") as Array<{
      role: "assistant";
      content: Array<{ type: string }>;
    }>;
    const hasThinking = assistants.some((a) => a.content.some((b) => b.type === "thinking"));
    expect(hasThinking).toBe(true);
  });

  test("parses sample-003 (compaction + fork)", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-003.jsonl"));
    expect(entries.length).toBe(11);

    // Should have compaction entry
    const compactions = entries.filter((e) => "type" in e && e.type === "compaction");
    expect(compactions.length).toBe(1);
  });
});

describe("parseSessionText", () => {
  test("handles empty lines gracefully", () => {
    const entries = parseSessionText('\n\n{"id":"m1","role":"user","content":"hi","timestamp":1}\n\n');
    expect(entries.length).toBe(1);
  });

  test("skips malformed JSON lines", () => {
    const entries = parseSessionText(
      '{"id":"m1","role":"user","content":"hi","timestamp":1}\nnot json\n{"id":"m2","role":"user","content":"bye","timestamp":2}\n',
    );
    expect(entries.length).toBe(2);
  });

  test("skips unknown entry types", () => {
    const entries = parseSessionText('{"foo":"bar"}\n{"id":"m1","role":"user","content":"hi","timestamp":1}\n');
    expect(entries.length).toBe(1);
  });
});

describe("buildTree", () => {
  test("builds tree from sample-001", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const tree = buildTree(entries);

    // Session header + first user message are roots (no parentId)
    expect(tree.roots.length).toBe(2);

    // msg-001-01 has one child (msg-001-02)
    const children01 = tree.children.get("msg-001-01");
    expect(children01).toContain("msg-001-02");
  });

  test("detects forking in sample-003", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-003.jsonl"));
    const tree = buildTree(entries);

    // msg-003-06 has two children (msg-003-07 and msg-003-10 — the fork)
    const children06 = tree.children.get("msg-003-06");
    expect(children06?.length).toBe(2);
    expect(children06).toContain("msg-003-07");
    expect(children06).toContain("msg-003-10");
  });
});

describe("pairToolCalls", () => {
  test("pairs tool calls with results in sample-001", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const pairs = pairToolCalls(entries);

    expect(pairs.length).toBe(2);

    // First pair: read tool
    expect(pairs[0].call.name).toBe("read");
    expect(pairs[0].result).toBeDefined();
    expect(pairs[0].result!.toolName).toBe("read");

    // Second pair: bash tool
    expect(pairs[1].call.name).toBe("bash");
    expect(pairs[1].result).toBeDefined();
  });

  test("pairs multiple tool calls in single message (sample-002)", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-002.jsonl"));
    const pairs = pairToolCalls(entries);

    // 5 tool calls total in sample-002
    expect(pairs.length).toBe(5);

    // tc-002-03 (bash) should have error result
    const errorPair = pairs.find((p) => p.call.id === "tc-002-03");
    expect(errorPair?.result?.isError).toBe(true);
  });

  test("pairs multiple tool calls in sample-003", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-003.jsonl"));
    const pairs = pairToolCalls(entries);

    expect(pairs.length).toBe(3);
  });
});

describe("extractSessionMeta", () => {
  test("extracts metadata from sample-001", async () => {
    const path = join(SAMPLE_DIR, "sample-001.jsonl");
    const entries = await parseSessionFile(path);
    const meta = extractSessionMeta(path, entries);

    expect(meta.id).toBe("sample-001");
    expect(meta.messageCount).toBe(6); // 2 user + 4 assistant
    expect(meta.toolCallCount).toBe(2);
    expect(meta.hasErrors).toBe(false);
    expect(meta.timestamp).toBe(1708900000000);
  });

  test("detects errors in sample-002", async () => {
    const path = join(SAMPLE_DIR, "sample-002.jsonl");
    const entries = await parseSessionFile(path);
    const meta = extractSessionMeta(path, entries);

    expect(meta.id).toBe("sample-002");
    expect(meta.hasErrors).toBe(true);
    expect(meta.toolCallCount).toBe(5);
  });
});

describe("IncrementalParser", () => {
  test("reads file incrementally", async () => {
    const tmpPath = join(import.meta.dir, "tmp-incremental.jsonl");

    // Write initial content
    await Bun.write(tmpPath, '{"id":"m1","role":"user","content":"hi","timestamp":1}\n');

    const parser = new IncrementalParser();
    const first = await parser.readNew(tmpPath);
    expect(first.length).toBe(1);

    // Append more content
    const file = Bun.file(tmpPath);
    const existing = await file.text();
    await Bun.write(tmpPath, `${existing}{"id":"m2","role":"user","content":"bye","timestamp":2}\n`);

    const second = await parser.readNew(tmpPath);
    expect(second.length).toBe(1);
    expect((second[0] as { id: string }).id).toBe("m2");

    // No new content
    const third = await parser.readNew(tmpPath);
    expect(third.length).toBe(0);

    // Cleanup
    const { unlinkSync } = await import("fs");
    unlinkSync(tmpPath);
  });

  test("handles partial lines", async () => {
    const tmpPath = join(import.meta.dir, "tmp-partial.jsonl");

    // Write complete line + partial line
    await Bun.write(tmpPath, '{"id":"m1","role":"user","content":"hi","timestamp":1}\n{"id":"m2","ro');

    const parser = new IncrementalParser();
    const first = await parser.readNew(tmpPath);
    expect(first.length).toBe(1);

    // Complete the partial line
    const file = Bun.file(tmpPath);
    const existing = await file.text();
    await Bun.write(tmpPath, `${existing}le":"user","content":"bye","timestamp":2}\n`);

    const second = await parser.readNew(tmpPath);
    expect(second.length).toBe(1);
    expect((second[0] as { id: string }).id).toBe("m2");

    // Cleanup
    const { unlinkSync } = await import("fs");
    unlinkSync(tmpPath);
  });
});
