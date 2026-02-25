import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/agent/types";
import { EventStream } from "../src/event-stream";
import { resolvePaths } from "../src/infrastructure/diligent-dir";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "../src/provider/types";
import type { SessionManagerConfig } from "../src/session/manager";
import { SessionManager } from "../src/session/manager";
import { readSessionFile } from "../src/session/persistence";
import type { AssistantMessage, Message } from "../src/types";

const TEST_ROOT = join(tmpdir(), `diligent-sm-test-${Date.now()}`);

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

function makeAssistant(text: string = "hi"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function createMockStreamFn(responses: AssistantMessage[]): StreamFunction {
  let callIndex = 0;
  return (_model, _context, _options) => {
    const msg = responses[callIndex++] ?? makeAssistant();
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      stream.push({ type: "text_delta", delta: msg.content[0].type === "text" ? msg.content[0].text : "" });
      stream.push({ type: "done", stopReason: "end_turn", message: msg });
    });
    return stream;
  };
}

async function setupDir(): Promise<string> {
  const dir = join(TEST_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const paths = resolvePaths(dir);
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.knowledge, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  return dir;
}

function makeManagerConfig(dir: string, streamFn: StreamFunction): SessionManagerConfig {
  return {
    cwd: dir,
    paths: resolvePaths(dir),
    agentConfig: {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
    },
  };
}

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("SessionManager", () => {
  test("create() starts with empty session", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();
    expect(mgr.entryCount).toBe(0);
    expect(mgr.getContext()).toEqual([]);
  });

  test("run() calls agentLoop and persists messages", async () => {
    const dir = await setupDir();
    const response = makeAssistant("hello!");
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([response])));
    await mgr.create();

    const userMsg: Message = { role: "user", content: "test", timestamp: Date.now() };
    const stream = mgr.run(userMsg);

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Wait for async writes to complete
    await mgr.waitForWrites();

    // Should have persisted user + assistant messages
    expect(mgr.entryCount).toBeGreaterThanOrEqual(2);

    // Session file should exist (deferred write triggered by assistant message)
    expect(mgr.sessionPath).not.toBeNull();

    // Read back from disk
    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].type).toBe("message");
  });

  test("run() preserves conversation context across turns", async () => {
    const dir = await setupDir();
    const r1 = makeAssistant("first response");
    const r2 = makeAssistant("second response");
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([r1, r2])));
    await mgr.create();

    // First message
    const s1 = mgr.run({ role: "user", content: "hello", timestamp: Date.now() });
    for await (const _ of s1) {
    }
    await mgr.waitForWrites();

    // Second message
    const s2 = mgr.run({ role: "user", content: "more", timestamp: Date.now() });
    for await (const _ of s2) {
    }
    await mgr.waitForWrites();

    // Context should have all messages
    const ctx = mgr.getContext();
    expect(ctx.length).toBeGreaterThanOrEqual(4); // user, assistant, user, assistant
  });

  test("resume() loads session from disk", async () => {
    const dir = await setupDir();
    const response = makeAssistant("remembered");
    const mgr1 = new SessionManager(makeManagerConfig(dir, createMockStreamFn([response])));
    await mgr1.create();

    // Run a conversation
    const s1 = mgr1.run({ role: "user", content: "remember this", timestamp: Date.now() });
    for await (const _ of s1) {
    }
    await mgr1.waitForWrites();

    // Create new manager and resume
    const mgr2 = new SessionManager(makeManagerConfig(dir, createMockStreamFn([makeAssistant()])));
    const resumed = await mgr2.resume({ mostRecent: true });
    expect(resumed).toBe(true);

    // Should have loaded the previous entries
    const ctx = mgr2.getContext();
    expect(ctx.length).toBeGreaterThanOrEqual(2);
    expect(ctx[0].role).toBe("user");
  });

  test("resume() returns false when no sessions exist", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    const resumed = await mgr.resume({ mostRecent: true });
    expect(resumed).toBe(false);
  });

  test("list() returns available sessions", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([makeAssistant()])));
    await mgr.create();

    // Run to create a persisted session
    const s = mgr.run({ role: "user", content: "test", timestamp: Date.now() });
    for await (const _ of s) {
    }
    await mgr.waitForWrites();

    const sessions = await mgr.list();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });
});
