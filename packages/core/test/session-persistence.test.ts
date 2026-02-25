import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEntry,
  createSessionFile,
  DeferredWriter,
  listSessions,
  readSessionFile,
} from "../src/session/persistence";
import type { SessionMessageEntry } from "../src/session/types";
import { generateEntryId, SESSION_VERSION } from "../src/session/types";

const TEST_ROOT = join(tmpdir(), `diligent-session-test-${Date.now()}`);
let testDir: string;

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

async function setupDir(): Promise<string> {
  testDir = join(TEST_ROOT, `run-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  return testDir;
}

function makeUserEntry(parentId: string | null = null): SessionMessageEntry {
  return {
    type: "message",
    id: generateEntryId(),
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello", timestamp: Date.now() },
  };
}

function makeAssistantEntry(parentId: string): SessionMessageEntry {
  return {
    type: "message",
    id: generateEntryId(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn",
      timestamp: Date.now(),
    },
  };
}

describe("createSessionFile + readSessionFile", () => {
  it("creates a JSONL file with valid header", async () => {
    const dir = await setupDir();
    const { path, header } = await createSessionFile(dir, "/project");

    expect(path).toContain(".jsonl");
    expect(header.type).toBe("session");
    expect(header.version).toBe(SESSION_VERSION);
    expect(header.cwd).toBe("/project");

    const { header: readHeader, entries } = await readSessionFile(path);
    expect(readHeader).toEqual(header);
    expect(entries).toEqual([]);
  });

  it("parentSession is recorded in header", async () => {
    const dir = await setupDir();
    const { header } = await createSessionFile(dir, "/project", "parent-id");
    expect(header.parentSession).toBe("parent-id");
  });
});

describe("appendEntry + readSessionFile", () => {
  it("appends entries and reads them back", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project");

    const entry1 = makeUserEntry();
    const entry2 = makeAssistantEntry(entry1.id);

    await appendEntry(path, entry1);
    await appendEntry(path, entry2);

    const { entries } = await readSessionFile(path);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(entry1.id);
    expect(entries[1].id).toBe(entry2.id);
  });
});

describe("readSessionFile validation", () => {
  it("throws on empty file", async () => {
    const dir = await setupDir();
    const path = join(dir, "empty.jsonl");
    await Bun.write(path, "");

    expect(readSessionFile(path)).rejects.toThrow("Empty session file");
  });

  it("throws on invalid header", async () => {
    const dir = await setupDir();
    const path = join(dir, "bad.jsonl");
    await Bun.write(path, `${JSON.stringify({ type: "not_session" })}\n`);

    expect(readSessionFile(path)).rejects.toThrow("Invalid session header");
  });

  it("throws on future version", async () => {
    const dir = await setupDir();
    const path = join(dir, "future.jsonl");
    await Bun.write(path, `${JSON.stringify({ type: "session", version: 999, id: "x", timestamp: "", cwd: "/" })}\n`);

    expect(readSessionFile(path)).rejects.toThrow("newer than supported");
  });
});

describe("listSessions", () => {
  it("returns sessions sorted by modified date", async () => {
    const dir = await setupDir();

    // Create two sessions with entries
    const { path: p1 } = await createSessionFile(dir, "/project");
    const e1 = makeUserEntry();
    await appendEntry(p1, e1);

    // Small delay for distinct timestamps
    await new Promise((r) => setTimeout(r, 10));

    const { path: p2 } = await createSessionFile(dir, "/project");
    const e2 = makeUserEntry();
    await appendEntry(p2, e2);

    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(2);
    // Most recent first
    expect(sessions[0].path).toBe(p2);
  });

  it("extracts first user message preview", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project");
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "find all TODO comments", timestamp: Date.now() },
    };
    await appendEntry(path, entry);

    const sessions = await listSessions(dir);
    expect(sessions[0].firstUserMessage).toBe("find all TODO comments");
  });

  it("returns empty array when no sessions", async () => {
    const dir = await setupDir();
    const sessions = await listSessions(dir);
    expect(sessions).toEqual([]);
  });
});

describe("DeferredWriter", () => {
  it("does not write to disk on user messages only", async () => {
    const dir = await setupDir();
    const writer = new DeferredWriter(dir, "/project");

    await writer.write(makeUserEntry());

    expect(writer.isFlushed).toBe(false);
    expect(writer.path).toBeNull();
  });

  it("flushes on first assistant message", async () => {
    const dir = await setupDir();
    const writer = new DeferredWriter(dir, "/project");

    const userEntry = makeUserEntry();
    await writer.write(userEntry);
    const assistantEntry = makeAssistantEntry(userEntry.id);
    await writer.write(assistantEntry);

    expect(writer.isFlushed).toBe(true);
    expect(writer.path).not.toBeNull();

    // Verify file contents
    const { entries } = await readSessionFile(writer.path!);
    expect(entries).toHaveLength(2);
  });

  it("writes subsequent entries immediately after flush", async () => {
    const dir = await setupDir();
    const writer = new DeferredWriter(dir, "/project");

    const user1 = makeUserEntry();
    await writer.write(user1);
    const assistant1 = makeAssistantEntry(user1.id);
    await writer.write(assistant1); // triggers flush

    const user2 = makeUserEntry(assistant1.id);
    await writer.write(user2); // should write immediately

    const { entries } = await readSessionFile(writer.path!);
    expect(entries).toHaveLength(3);
  });

  it("accepts existing path for resumed sessions", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project");

    const writer = new DeferredWriter(dir, "/project", path);
    expect(writer.isFlushed).toBe(true);

    const entry = makeUserEntry();
    await writer.write(entry);

    const { entries } = await readSessionFile(path);
    expect(entries).toHaveLength(1);
  });
});
