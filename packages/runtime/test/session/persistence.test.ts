// @summary Tests for session file persistence and entry management
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppendedEntryInfo, SessionMessageEntry } from "@diligent/runtime/session";
import {
  appendEntry,
  createSessionFile,
  deleteSession,
  generateEntryId,
  listSessions,
  readSessionFile,
  SESSION_VERSION,
  SessionPersistence,
  SessionWriter,
} from "@diligent/runtime/session";

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

  it("reads version-9 sessions and accepts appended internal metadata", async () => {
    const dir = await setupDir();
    const path = join(dir, "legacy.jsonl");
    await Bun.write(
      path,
      `${JSON.stringify({ type: "session", version: 9, id: "legacy", timestamp: new Date().toISOString(), cwd: "/" })}\n`,
    );
    const internal = { ...makeUserEntry(), visibility: "internal" as const, source: "test-hook" };
    await appendEntry(path, internal);
    const { header, entries } = await readSessionFile(path);
    expect(header.version).toBe(9);
    expect(entries[0]).toMatchObject({ visibility: "internal", source: "test-hook" });
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

  it("excludes internal entries but keeps legacy reminder entries visible", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project");
    const internal = { ...makeUserEntry(), visibility: "internal" as const, source: "plan-reminder" };
    internal.message = { role: "user", content: "internal", timestamp: Date.now() };
    const legacy = makeUserEntry(internal.id);
    legacy.message = {
      role: "user",
      content: "<system-reminder>\nlegacy\n</system-reminder>",
      timestamp: Date.now(),
    };
    const visible = makeUserEntry(legacy.id);
    visible.message = { role: "user", content: "visible", timestamp: Date.now() };
    await appendEntry(path, internal);
    await appendEntry(path, legacy);
    await appendEntry(path, visible);

    const [session] = await listSessions(dir);
    expect(session.messageCount).toBe(2);
    expect(session.firstUserMessage).toBe("<system-reminder>\nlegacy\n</system-reminder>");
  });

  it("returns empty array when no sessions", async () => {
    const dir = await setupDir();
    const sessions = await listSessions(dir);
    expect(sessions).toEqual([]);
  });
});

describe("deleteSession", () => {
  it("returns true and removes the file for an existing session", async () => {
    const dir = await setupDir();
    const { header } = await createSessionFile(dir, "/project");

    const result = await deleteSession(dir, header.id);
    expect(result).toBe(true);

    const sessions = await listSessions(dir);
    expect(sessions).toEqual([]);
  });

  it("returns false for a non-existent session", async () => {
    const dir = await setupDir();
    const result = await deleteSession(dir, "nonexistent-id");
    expect(result).toBe(false);
  });
});

describe("listSessions parentSession", () => {
  it("includes parentSession when set in header", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project", "parent-123");
    await appendEntry(path, makeUserEntry());
    const sessions = await listSessions(dir);
    expect(sessions[0].parentSession).toBe("parent-123");
  });

  it("parentSession is undefined for top-level sessions", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project");
    await appendEntry(path, makeUserEntry());
    const sessions = await listSessions(dir);
    expect(sessions[0].parentSession).toBeUndefined();
  });
});

describe("SessionWriter", () => {
  it("creates the session file immediately", async () => {
    const dir = await setupDir();
    const writer = new SessionWriter(dir, "/project");

    const path = await writer.create();

    expect(writer.path).toBe(path);
    const { entries } = await readSessionFile(path);
    expect(entries).toEqual([]);
  });

  it("writes entries immediately", async () => {
    const dir = await setupDir();
    const writer = new SessionWriter(dir, "/project");

    const userEntry = makeUserEntry();
    await writer.write(userEntry);
    const assistantEntry = makeAssistantEntry(userEntry.id);
    await writer.write(assistantEntry);

    expect(writer.path).not.toBeNull();
    const { entries } = await readSessionFile(writer.path!);
    expect(entries).toHaveLength(2);
  });

  it("accepts existing path for resumed sessions", async () => {
    const dir = await setupDir();
    const { path } = await createSessionFile(dir, "/project");

    const writer = new SessionWriter(dir, "/project", path);

    const entry = makeUserEntry();
    await writer.write(entry);

    const { entries } = await readSessionFile(path);
    expect(entries).toHaveLength(1);
  });

  it("passes parentSession to session header on create", async () => {
    const dir = await setupDir();
    const writer = new SessionWriter(dir, "/project", undefined, "parent-abc");

    await writer.create();

    const { header } = await readSessionFile(writer.path!);
    expect(header.parentSession).toBe("parent-abc");
  });
});

describe("SessionPersistence onEntryAppended", () => {
  // Observers dispatch on a setImmediate macrotask (off the write tick), so wait one round.
  const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

  it("fires once per append with a monotonic seq", async () => {
    const dir = await setupDir();
    const seen: AppendedEntryInfo[] = [];
    const persistence = new SessionPersistence({
      sessionsDir: dir,
      cwd: dir,
      onEntryAppended: (info) => seen.push(info),
    });
    await persistence.create();

    const user = makeUserEntry();
    persistence.append(user, () => {});
    persistence.append(makeAssistantEntry(user.id), () => {});
    await persistence.waitForWrites();
    await flushImmediate();

    expect(seen.map((s) => s.seq)).toEqual([1, 2]);
    expect(seen[0].entry.id).toBe(user.id);
    expect(seen[0].sessionId).toBe(persistence.sessionId);
    expect(seen[0].sessionPath).toBe(persistence.sessionPath);
  });

  it("seeds seq from existing entries on resume so it never collides", async () => {
    const dir = await setupDir();
    const first = new SessionPersistence({ sessionsDir: dir, cwd: dir });
    await first.create();
    const user = makeUserEntry();
    first.append(user, () => {});
    first.append(makeAssistantEntry(user.id), () => {});
    await first.waitForWrites();
    const sessionId = first.sessionId;

    const seen: AppendedEntryInfo[] = [];
    const resumed = new SessionPersistence({
      sessionsDir: dir,
      cwd: dir,
      onEntryAppended: (info) => seen.push(info),
    });
    await resumed.resume({ sessionId });
    resumed.append(makeUserEntry(), () => {});
    await resumed.waitForWrites();
    await flushImmediate();

    // Two entries already on disk → next append is seq 3, not 1.
    expect(seen.map((s) => s.seq)).toEqual([3]);
  });

  it("does not break the write path when the observer throws", async () => {
    const dir = await setupDir();
    const persistence = new SessionPersistence({
      sessionsDir: dir,
      cwd: dir,
      onEntryAppended: () => {
        throw new Error("observer boom");
      },
    });
    await persistence.create();

    let writeError: unknown;
    persistence.append(makeUserEntry(), (err) => {
      writeError = err;
    });
    await persistence.waitForWrites();
    await flushImmediate();

    expect(writeError).toBeUndefined();
    const { entries } = await readSessionFile(persistence.sessionPath!);
    expect(entries).toHaveLength(1);
  });
});
