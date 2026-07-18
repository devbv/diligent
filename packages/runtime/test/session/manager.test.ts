// @summary Tests for session manager creation, persistence, and resumption
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopHook } from "@diligent/core/agent";
import { Agent } from "@diligent/core/agent";
import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage, Message } from "@diligent/core/message-contract";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "@diligent/core/provider-contract";
import { ProviderError } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import { type LogRecord, resetDefaultLogSinkForTests, setDefaultLogSink } from "@diligent/logging";
import { resolvePaths } from "@diligent/runtime/infrastructure";
import type { SessionManagerConfig } from "@diligent/runtime/session";
import { readSessionFile, SessionManager } from "@diligent/runtime/session";
import { z } from "zod";
import type { AgentEvent } from "../../src/agent-event";

const TEST_ROOT = join(tmpdir(), `diligent-sm-test-${Date.now()}`);

const TEST_MODEL: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
};

function makeAssistant(text: string = "hi"): AssistantMessage {
  return makeAssistantMessage([{ type: "text", text }]);
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function createProviderEventStream(outcome: AssistantMessage | Error): EventStream<ProviderEvent, ProviderResult> {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );

  queueMicrotask(() => {
    stream.push({ type: "start" });
    if (outcome instanceof Error) {
      stream.push({ type: "error", error: outcome });
      return;
    }
    const firstText = outcome.content[0];
    if (firstText?.type === "text") {
      stream.push({ type: "text_delta", delta: firstText.text });
    }
    stream.push({ type: "done", stopReason: outcome.stopReason, message: outcome });
  });

  return stream;
}

function createMockStreamFn(responses: AssistantMessage[]): StreamFunction {
  let callIndex = 0;
  return (_model, _context, _options) => createProviderEventStream(responses[callIndex++] ?? makeAssistant());
}

async function setupDir(): Promise<string> {
  const dir = join(TEST_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const paths = resolvePaths(dir);
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.knowledge, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  return dir;
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeManagerConfig(dir: string, streamFn: StreamFunction): SessionManagerConfig {
  return {
    cwd: dir,
    paths: resolvePaths(dir),
    agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    }),
  };
}

/** Collect events via subscribe, run, return events. */
async function runCollecting(mgr: SessionManager, userMsg: Message): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const unsub = mgr.subscribe((e) => events.push(e));
  await mgr.run(userMsg).catch(() => {});
  unsub();
  return events;
}

afterEach(async () => {
  resetDefaultLogSinkForTests();
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
    const events = await runCollecting(mgr, userMsg);

    // Wait for async writes to complete
    await mgr.waitForWrites();

    // Should have persisted user + assistant messages
    expect(mgr.entryCount).toBeGreaterThanOrEqual(2);

    // Session file should exist after session creation
    expect(mgr.sessionPath).not.toBeNull();

    // Read back from disk
    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].type).toBe("message");

    // Events should include turn lifecycle
    expect(events.some((e) => e.type === "turn_start")).toBe(true);
  });

  test("persists loop-hook context internally without publishing or exposing it", async () => {
    const dir = await setupDir();
    const providerContexts: Message[][] = [];
    const hook: AgentLoopHook = {
      id: "test-context",
      beforeTurn: () => [{ source: "test-context", content: "internal policy" }],
    };
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        loopHooks: [hook],
        llmMsgStreamFn: (_model, context) => {
          providerContexts.push([...context.messages]);
          return createProviderEventStream(makeAssistant("done"));
        },
      }),
    });
    await mgr.create();

    const events = await runCollecting(mgr, { role: "user", content: "visible", timestamp: Date.now() });
    await mgr.waitForWrites();
    const { entries } = await readSessionFile(mgr.sessionPath!);
    const internal = entries.find(
      (entry) => entry.type === "message" && entry.visibility === "internal" && entry.source === "test-context",
    );

    expect(internal?.type === "message" ? internal.message.content : undefined).toBe("internal policy");
    expect(
      providerContexts[0].some((message) => message.role === "user" && message.content === "internal policy"),
    ).toBe(true);
    expect(mgr.getContext().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(events.some((event) => (event as { type: string }).type === "context_injected")).toBe(false);
  });

  test("run() preserves conversation context across turns", async () => {
    const dir = await setupDir();
    const r1 = makeAssistant("first response");
    const r2 = makeAssistant("second response");
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([r1, r2])));
    await mgr.create();

    // First message
    await mgr.run({ role: "user", content: "hello", timestamp: Date.now() });
    await mgr.waitForWrites();

    // Second message
    await mgr.run({ role: "user", content: "more", timestamp: Date.now() });
    await mgr.waitForWrites();

    // Context should have all messages
    const ctx = mgr.getContext();
    expect(ctx.length).toBeGreaterThanOrEqual(4); // user, assistant, user, assistant
  });

  test("run() persists staged user message and non-fatal error when the turn fails before streaming", async () => {
    const dir = await setupDir();
    const logs: LogRecord[] = [];
    setDefaultLogSink((record) => logs.push(record));
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: () => {
          throw new Error("provider failed");
        },
      }),
    });
    await mgr.create();

    await mgr.run({ role: "user", content: "will fail", timestamp: Date.now() });
    await mgr.waitForWrites();

    expect(mgr.entryCount).toBe(2);
    expect(mgr.getContext()).toEqual([{ role: "user", content: "will fail", timestamp: expect.any(Number) }]);
    expect(mgr.getErrors()).toHaveLength(1);

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.type === "message" ? entries[0].message.role : null).toBe("user");
    expect(entries[1]?.type).toBe("error");
    if (entries[1]?.type === "error") {
      expect(entries[1].fatal).toBe(false);
      expect(entries[1].error.message).toBe("provider failed");
    }
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        scope: "runtime.session",
        event: "run_failed",
        sessionId: mgr.sessionId,
        message: expect.stringContaining("[SessionManager] Run error"),
        error: expect.objectContaining({ message: "provider failed" }),
      }),
    );
  });

  test("run() persists user message before provider response completes", async () => {
    const dir = await setupDir();
    let releaseProvider: (() => void) | undefined;
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: () => {
          const stream = new EventStream<ProviderEvent, ProviderResult>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return { message: event.message };
              throw (event as { type: "error"; error: Error }).error;
            },
          );
          stream.push({ type: "start" });
          releaseProvider = () => stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant("done") });
          return stream;
        },
      }),
    });
    await mgr.create();

    const runPromise = mgr.run({ role: "user", content: "visible immediately", timestamp: Date.now() });

    await waitFor(() => mgr.entryCount === 1);
    await mgr.waitForWrites();
    const beforeCompletion = await readSessionFile(mgr.sessionPath!);
    expect(beforeCompletion.entries).toHaveLength(1);
    expect(beforeCompletion.entries[0]?.type === "message" ? beforeCompletion.entries[0].message : null).toMatchObject({
      role: "user",
      content: "visible immediately",
    });

    releaseProvider?.();
    await runPromise;
  });

  test("run() persists staged user message and non-fatal error when provider fails after streaming starts", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: () => {
          const stream = new EventStream<ProviderEvent, ProviderResult>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return { message: event.message };
              throw (event as { type: "error"; error: Error }).error;
            },
          );

          queueMicrotask(() => {
            stream.push({ type: "start" });
            stream.push({ type: "text_delta", delta: "partial" });
            stream.push({ type: "error", error: new Error("stream exploded") });
          });

          return stream;
        },
      }),
    });
    await mgr.create();

    const events = await runCollecting(mgr, { role: "user", content: "will partly fail", timestamp: Date.now() });
    await mgr.waitForWrites();

    const context = mgr.getContext();
    expect(context).toHaveLength(1);
    expect(context[0]?.role).toBe("user");
    expect(context[0]?.content).toBe("will partly fail");
    expect(mgr.getErrors()).toHaveLength(1);
    expect(mgr.getErrors()[0]?.fatal).toBe(false);
    expect(events.some((event) => event.type === "message_start")).toBe(true);
    expect(events.some((event) => event.type === "message_end")).toBe(false);

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.type === "message" ? entries[0].message.role : null).toBe("user");
    expect(entries[1]?.type).toBe("error");
    if (entries[1]?.type === "error") {
      expect(entries[1].fatal).toBe(false);
      expect(entries[1].error.message).toBe("stream exploded");
    }
  });

  test("run() persists structured provider error information from agent error events", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: () => {
          throw new ProviderError(
            "provider overloaded",
            "overloaded",
            false,
            undefined,
            529,
            Object.assign(new Error("provider overloaded"), { code: "overloaded_error" }),
          );
        },
      }),
    });
    await mgr.create();

    await mgr.run({ role: "user", content: "show details", timestamp: Date.now() });
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    const errorEntry = entries.find((entry) => entry.type === "error");
    expect(errorEntry).toBeDefined();
    if (errorEntry?.type === "error") {
      expect(errorEntry.fatal).toBe(false);
      expect(errorEntry.error.message).toBe("provider overloaded");
      expect(errorEntry.error.code).toBe("overloaded_error");
      expect(errorEntry.error.providerErrorType).toBe("overloaded");
      expect(errorEntry.error.isRetryable).toBe(false);
      expect(errorEntry.error.statusCode).toBe(529);
    }
  });

  test("run() logs provider error code when available", async () => {
    const dir = await setupDir();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: () => {
          throw new ProviderError(
            "provider failed",
            "overloaded",
            false,
            undefined,
            529,
            Object.assign(new Error("provider failed"), { code: "overloaded_error" }),
          );
        },
      }),
    });
    await mgr.create();

    try {
      await mgr.run({ role: "user", content: "show code", timestamp: Date.now() });
      await mgr.waitForWrites();

      const joinedLogs = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(joinedLogs).toContain("code=overloaded_error");
      expect(joinedLogs).toContain("status=529");
      expect(joinedLogs).toContain("type=overloaded");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("getContext() exposes staged turn messages while a turn is running", async () => {
    const dir = await setupDir();
    let releaseDone: (() => void) | null = null;
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: () => {
          const stream = new EventStream<ProviderEvent, ProviderResult>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return { message: event.message };
              throw (event as { type: "error"; error: Error }).error;
            },
          );
          queueMicrotask(() => {
            stream.push({ type: "start" });
            stream.push({ type: "text_delta", delta: "partial" });
          });
          releaseDone = () => {
            stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant("completed") });
          };
          return stream;
        },
      }),
    });
    await mgr.create();

    const runPromise = mgr.run({ role: "user", content: "in flight", timestamp: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mgr.getContext().map((msg) => msg.role)).toEqual(["user"]);
    expect(mgr.entryCount).toBe(1);

    if (releaseDone) releaseDone();
    await runPromise;
    await mgr.waitForWrites();

    expect(mgr.getContext().map((msg) => msg.role)).toEqual(["user", "assistant"]);
    expect(mgr.entryCount).toBe(2);
  });

  test("run() persists assistant tool requests before tool execution finishes", async () => {
    const dir = await setupDir();
    let releaseTool: (() => void) | null = null;
    const blockingTool: Tool = {
      name: "hold",
      description: "Block until released",
      parameters: z.object({}),
      async execute() {
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        return { output: "released" };
      },
    };

    let providerCallCount = 0;
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [blockingTool], {
        effort: "medium",
        llmMsgStreamFn: ((_model, _context, _options) => {
          if (providerCallCount++ === 0) {
            return createProviderEventStream(
              makeAssistantMessage([{ type: "tool_call", id: "tc_hold", name: "hold", input: {} }], "tool_use"),
            );
          }

          return createProviderEventStream(makeAssistant("done"));
        }) as StreamFunction,
      }),
    });
    await mgr.create();

    const runPromise = mgr.run({ role: "user", content: "run hold", timestamp: Date.now() });

    await waitFor(() => releaseTool !== null);
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("message");
    expect(entries[0]?.type === "message" ? entries[0].message.role : null).toBe("user");
    expect(entries[1]?.type === "message" ? entries[1].message.role : null).toBe("assistant");
    if (entries[1]?.type === "message" && entries[1].message.role === "assistant") {
      expect(entries[1].message.stopReason).toBe("tool_use");
      expect(entries[1].message.content.some((block) => block.type === "tool_call")).toBe(true);
    }

    releaseTool?.();
    await runPromise;
    await mgr.waitForWrites();
  });

  test("run() persists tool results before the final assistant message completes", async () => {
    const dir = await setupDir();
    const fastTool: Tool = {
      name: "echo",
      description: "Return a fixed result",
      parameters: z.object({}),
      async execute() {
        return { output: "tool-finished" };
      },
    };

    let releaseFinalAssistant: (() => void) | null = null;
    let providerCallCount = 0;
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [fastTool], {
        effort: "medium",
        llmMsgStreamFn: ((_model, _context, _options) => {
          if (providerCallCount++ === 0) {
            return createProviderEventStream(
              makeAssistantMessage([{ type: "tool_call", id: "tc_echo", name: "echo", input: {} }], "tool_use"),
            );
          }

          const stream = new EventStream<ProviderEvent, ProviderResult>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return { message: event.message };
              throw (event as { type: "error"; error: Error }).error;
            },
          );

          queueMicrotask(() => {
            stream.push({ type: "start" });
            stream.push({ type: "text_delta", delta: "waiting" });
          });

          releaseFinalAssistant = () => {
            stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant("final answer") });
          };
          return stream;
        }) as StreamFunction,
      }),
    });
    await mgr.create();

    const runPromise = mgr.run({ role: "user", content: "run echo", timestamp: Date.now() });

    await waitFor(() => releaseFinalAssistant !== null);
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.type === "message" ? entries[0].message.role : null).toBe("user");
    expect(entries[1]?.type === "message" ? entries[1].message.role : null).toBe("assistant");
    expect(entries[2]?.type === "message" ? entries[2].message.role : null).toBe("tool_result");
    if (entries[2]?.type === "message" && entries[2].message.role === "tool_result") {
      expect(entries[2].message.toolName).toBe("echo");
      expect(entries[2].message.output).toBe("tool-finished");
    }

    releaseFinalAssistant?.();
    await runPromise;
    await mgr.waitForWrites();

    const finalSession = await readSessionFile(mgr.sessionPath!);
    expect(finalSession.entries).toHaveLength(4);
    expect(finalSession.entries[3]?.type === "message" ? finalSession.entries[3].message.role : null).toBe("assistant");
  });

  test("resume() loads session from disk", async () => {
    const dir = await setupDir();
    const response = makeAssistant("remembered");
    const mgr1 = new SessionManager(makeManagerConfig(dir, createMockStreamFn([response])));
    await mgr1.create();

    // Run a conversation
    await mgr1.run({ role: "user", content: "remember this", timestamp: Date.now() });
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
    await mgr.run({ role: "user", content: "test", timestamp: Date.now() });
    await mgr.waitForWrites();

    const sessions = await mgr.list();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("appendModeChange() persists mode_change entry", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();

    mgr.appendModeChange("plan", "cli");
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries.find((entry) => entry.type === "mode_change")).toMatchObject({
      type: "mode_change",
      mode: "plan",
      changedBy: "cli",
    });
  });

  test("appendModeChange() defaults changedBy to 'command'", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();

    mgr.appendModeChange("execute");
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries.find((entry) => entry.type === "mode_change")).toMatchObject({
      type: "mode_change",
      mode: "execute",
      changedBy: "command",
    });
  });

  test("appendModelChange() persists model_change entry payload", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();

    mgr.appendModelChange("openai", "gpt-5");
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    const modelEntry = entries.find((entry) => entry.type === "model_change");
    expect(modelEntry).toBeDefined();
    if (modelEntry && modelEntry.type === "model_change") {
      expect(modelEntry.provider).toBe("openai");
      expect(modelEntry.modelId).toBe("gpt-5");
    }
  });

  test("appendEffortChange() persists effort_change entry payload", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();

    mgr.appendEffortChange("high", "command");
    await mgr.waitForWrites();

    const { entries } = await readSessionFile(mgr.sessionPath!);
    const effortEntry = entries.find((entry) => entry.type === "effort_change");
    expect(effortEntry).toBeDefined();
    if (effortEntry && effortEntry.type === "effort_change") {
      expect(effortEntry.effort).toBe("high");
      expect(effortEntry.changedBy).toBe("command");
    }
  });

  test("compactNow() appends compaction entry", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(
      makeManagerConfig(dir, createMockStreamFn([makeAssistant("hello"), makeAssistant("## Goal\ncompact")])),
    );
    await mgr.create();

    await mgr.run({ role: "user", content: "please compact this thread", timestamp: Date.now() });
    await mgr.waitForWrites();

    const result = await mgr.compactNow();
    expect(result.compacted).toBe(true);
    expect(result.entryCount).toBeGreaterThanOrEqual(3);

    const { entries } = await readSessionFile(mgr.sessionPath!);
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
  });

  test("aborted signal settles run() without hanging", async () => {
    const dir = await setupDir();
    const controller = new AbortController();
    controller.abort();

    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
        effort: "medium",
        llmMsgStreamFn: createMockStreamFn([makeAssistant("should not run")]),
      }),
    });
    await mgr.create();

    // Keep pending queue non-empty: this used to trigger re-entry with an already-aborted signal.
    mgr.steer("queued while aborting");

    // run() should throw (aborted), not hang
    await mgr
      .run({ role: "user", content: "hi", timestamp: Date.now() }, { signal: controller.signal })
      .catch(() => {});

    const settled = await Promise.race([
      mgr.waitForWrites().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);

    expect(settled).toBe(true);
  });

  test("run() compacts between tool turn and next LLM call (proactive via Agent)", async () => {
    const dir = await setupDir();
    const compactingTool: Tool = {
      name: "inflate",
      description: "Inflate context",
      parameters: z.object({}),
      async execute() {
        return { output: `tool-result-${"x".repeat(400)}` };
      },
    };

    let providerCallCount = 0;
    const providerContexts: Message[][] = [];
    const mgr = new SessionManager({
      cwd: dir,
      paths: resolvePaths(dir),
      compaction: { enabled: true, reservePercent: 20, keepRecentTokens: 200 },
      agent: new Agent({ ...TEST_MODEL, contextWindow: 120 }, [{ label: "test", content: "test" }], [compactingTool], {
        effort: "medium",
        llmMsgStreamFn: ((_model, context, _options) => {
          if (context.systemPrompt.some((section) => section.label === "test")) {
            providerContexts.push([...context.messages]);
          }
          if (providerCallCount++ === 0) {
            return createProviderEventStream(
              makeAssistantMessage([{ type: "tool_call", id: "tc_1", name: "inflate", input: {} }], "tool_use"),
            );
          }
          return createProviderEventStream(makeAssistant("after compaction"));
        }) as StreamFunction,
      }),
    });
    await mgr.create();

    const events: AgentEvent[] = [];
    const unsub = mgr.subscribe((e) => events.push(e));
    await mgr.run({ role: "user", content: "start compacting", timestamp: Date.now() });
    await mgr.waitForWrites();
    unsub();

    const compactionStartIndex = events.findIndex((event) => event.type === "compaction_start");
    const firstTurnEndIndex = events.findIndex((event) => event.type === "turn_end");
    expect(compactionStartIndex).toBeGreaterThan(firstTurnEndIndex);

    const result = mgr.getContext();
    const summaryIndex = result.findIndex(
      (msg) =>
        msg.role === "user" &&
        typeof msg.content === "string" &&
        msg.content.includes("Another language model started to solve this problem"),
    );
    expect(providerContexts).toHaveLength(2);
    expect(providerContexts[0].some((msg) => msg.role === "tool_result")).toBe(false);
    expect(providerContexts[1].some((msg) => msg.role === "tool_result")).toBe(false);
    expect(
      providerContexts[1].some(
        (msg) =>
          msg.role === "user" &&
          typeof msg.content === "string" &&
          msg.content.includes("Another language model started to solve this problem"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(summaryIndex).toBeGreaterThan(-1);
  });

  test("logs usage prefix compare on second turn when cacheReadTokens is zero", async () => {
    const dir = await setupDir();
    const logs: LogRecord[] = [];
    setDefaultLogSink((record) => logs.push(record));

    const response1 = makeAssistantMessage([{ type: "text", text: "turn one" }]);
    response1.usage.cacheReadTokens = 5000;

    const response2 = makeAssistantMessage([{ type: "text", text: "turn two" }]);
    response2.usage.cacheReadTokens = 0;

    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([response1, response2])));
    await mgr.create();

    await mgr.run({ role: "user", content: "first", timestamp: Date.now() });
    await mgr.run({ role: "user", content: "second", timestamp: Date.now() });
    await mgr.waitForWrites();

    const prefixLogs = logs.filter((record) => record.event === "usage_prefix_compare");

    expect(prefixLogs).toHaveLength(2);
    expect(prefixLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          scope: "runtime.session.cache",
          sessionId: mgr.sessionId,
          fields: expect.objectContaining({ reason: "turn_ge_2_cache_read_zero", turn: 2, currCacheRead: 0 }),
        }),
        expect.objectContaining({
          sessionId: mgr.sessionId,
          fields: expect.objectContaining({ reason: "cache_read_decreased", turn: 2, currCacheRead: 0 }),
        }),
      ]),
    );
  });

  test("does not log usage prefix compare when cacheReadTokens stays zero", async () => {
    const dir = await setupDir();
    const logs: LogRecord[] = [];
    setDefaultLogSink((record) => logs.push(record));

    const response1 = makeAssistantMessage([{ type: "text", text: "turn one" }]);
    response1.usage.cacheReadTokens = 0;

    const response2 = makeAssistantMessage([{ type: "text", text: "turn two" }]);
    response2.usage.cacheReadTokens = 0;

    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([response1, response2])));
    await mgr.create();

    await mgr.run({ role: "user", content: "first", timestamp: Date.now() });
    await mgr.run({ role: "user", content: "second", timestamp: Date.now() });
    await mgr.waitForWrites();

    expect(logs.filter((record) => record.event === "usage_prefix_compare")).toHaveLength(0);
  });
});
