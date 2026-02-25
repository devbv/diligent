import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { SessionWatcher } from "../src/server/watcher.js";
import type { SessionEntry } from "../src/shared/types.js";

const TMP_DIR = join(import.meta.dir, "tmp-watcher-test");
const SESSIONS_DIR = join(TMP_DIR, "sessions");

beforeEach(() => {
  mkdirSync(SESSIONS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("SessionWatcher", () => {
  test("detects new entries appended to a file", async () => {
    // Create initial file
    const filePath = join(SESSIONS_DIR, "test-session.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({ type: "session_header", id: "test-session", timestamp: 1, cwd: "/", version: "0.0.1" })}\n`,
    );

    const receivedEntries: SessionEntry[] = [];
    const watcher = new SessionWatcher(SESSIONS_DIR, {
      onNewEntries(_sessionId, entries) {
        receivedEntries.push(...entries);
      },
      onNewSession() {},
    });

    watcher.start();

    // Wait for initial scan
    await new Promise((r) => setTimeout(r, 200));

    // Append a new entry
    appendFileSync(filePath, `${JSON.stringify({ id: "msg-01", role: "user", content: "hello", timestamp: 2 })}\n`);

    // Wait for watcher to pick up changes (poll interval is 2s, but we're testing the mechanism)
    await new Promise((r) => setTimeout(r, 3000));

    watcher.stop();

    expect(receivedEntries.length).toBeGreaterThanOrEqual(1);
    const userEntry = receivedEntries.find((e) => "role" in e && e.role === "user");
    expect(userEntry).toBeDefined();
  });

  test("detects new session files", async () => {
    const newSessions: string[] = [];
    const watcher = new SessionWatcher(SESSIONS_DIR, {
      onNewEntries() {},
      onNewSession(sessionId) {
        newSessions.push(sessionId);
      },
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create a new session file
    const filePath = join(SESSIONS_DIR, "new-session.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({ type: "session_header", id: "new-session", timestamp: 1, cwd: "/", version: "0.0.1" })}\n`,
    );

    // Wait for poll
    await new Promise((r) => setTimeout(r, 3000));

    watcher.stop();

    expect(newSessions).toContain("new-session");
  });
});
