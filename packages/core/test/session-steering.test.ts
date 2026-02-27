import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent } from "../src/agent/types";
import { EventStream } from "../src/event-stream";
import { resolvePaths } from "../src/infrastructure/diligent-dir";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "../src/provider/types";
import { buildSessionContext } from "../src/session/context-builder";
import type { SessionManagerConfig } from "../src/session/manager";
import { SessionManager } from "../src/session/manager";
import { readSessionFile } from "../src/session/persistence";
import type { SessionEntry, SteeringEntry } from "../src/session/types";
import { SESSION_VERSION } from "../src/session/types";
import type { Tool } from "../src/tool/types";
import type { AssistantMessage, Message } from "../src/types";

const TEST_ROOT = join(tmpdir(), `diligent-steering-test-${Date.now()}`);

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

function makeToolCallAssistant(toolCallId: string, toolName: string, input: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: toolCallId, name: toolName, input }],
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: Date.now(),
  };
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message",
  parameters: z.object({ message: z.string() }),
  async execute(args: { message: string }) {
    return { output: args.message };
  },
};

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
      for (const block of msg.content) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", delta: block.text });
          stream.push({ type: "text_end", text: block.text });
        } else if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({ type: "tool_call_end", id: block.id, name: block.name, input: block.input });
        }
      }
      stream.push({ type: "done", stopReason: msg.stopReason, message: msg });
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

function makeManagerConfig(dir: string, streamFn: StreamFunction, tools: Tool[] = []): SessionManagerConfig {
  return {
    cwd: dir,
    paths: resolvePaths(dir),
    agentConfig: {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools,
      streamFunction: streamFn,
    },
  };
}

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("SessionManager.steer()", () => {
  test("steer() queues a steering message and persists SteeringEntry", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([makeAssistant()])));
    await mgr.create();

    // Run initial conversation
    const userMsg: Message = { role: "user", content: "start task", timestamp: Date.now() };
    const stream = mgr.run(userMsg);

    // Steer mid-execution
    mgr.steer("focus on tests instead");

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await mgr.waitForWrites();

    // Entry count: user msg + steering + assistant response = 3+
    expect(mgr.entryCount).toBeGreaterThanOrEqual(3);

    // Persisted to disk
    const { entries } = await readSessionFile(mgr.sessionPath!);
    const steeringEntries = entries.filter((e) => e.type === "steering");
    expect(steeringEntries.length).toBeGreaterThanOrEqual(1);
    const se = steeringEntries[0] as SteeringEntry;
    expect(se.source).toBe("steer");
    expect(se.message.role).toBe("user");
    expect(typeof se.message.content === "string" && se.message.content).toContain("[Steering]");
    expect(typeof se.message.content === "string" && se.message.content).toContain("focus on tests instead");
  });

  test("steer() message is drained into agent loop", async () => {
    const dir = await setupDir();
    // Tool call response ensures the post-tool drain point is reached,
    // giving steer() time to queue before the second LLM call
    const toolCallResponse = makeToolCallAssistant("tc_1", "echo", { message: "hi" });
    const finalResponse = makeAssistant("acknowledged steering");
    const mgr = new SessionManager(
      makeManagerConfig(dir, createMockStreamFn([toolCallResponse, finalResponse]), [echoTool]),
    );
    await mgr.create();

    const stream = mgr.run({ role: "user", content: "hello", timestamp: Date.now() });
    // steer() is called synchronously after run() returns, before the mock's
    // queueMicrotask fires. The post-tool drain point picks up this message.
    mgr.steer("change approach");

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should have a steering_injected event from the agent loop
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SessionManager.followUp()", () => {
  test("followUp() queues message and persists SteeringEntry with follow_up source", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(
      makeManagerConfig(dir, createMockStreamFn([makeAssistant("first"), makeAssistant("second")])),
    );
    await mgr.create();

    const stream = mgr.run({ role: "user", content: "initial task", timestamp: Date.now() });

    // Queue follow-up while agent is running
    mgr.followUp("now do the next thing");

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await mgr.waitForWrites();

    // Should have persisted follow_up entry
    const { entries } = await readSessionFile(mgr.sessionPath!);
    const followUpEntries = entries.filter((e) => e.type === "steering" && (e as SteeringEntry).source === "follow_up");
    expect(followUpEntries.length).toBeGreaterThanOrEqual(1);
    const fue = followUpEntries[0] as SteeringEntry;
    expect(fue.message.content).toBe("now do the next thing");
  });

  test("followUp() triggers additional agent loop iteration", async () => {
    const dir = await setupDir();
    // Need enough responses: first for initial run, second for follow-up
    const mgr = new SessionManager(
      makeManagerConfig(
        dir,
        createMockStreamFn([makeAssistant("initial response"), makeAssistant("follow-up response")]),
      ),
    );
    await mgr.create();

    const stream = mgr.run({ role: "user", content: "task 1", timestamp: Date.now() });
    mgr.followUp("task 2");

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should have exactly 1 agent_start and 1 agent_end (outer lifecycle)
    const agentStarts = events.filter((e) => e.type === "agent_start");
    const agentEnds = events.filter((e) => e.type === "agent_end");
    expect(agentStarts).toHaveLength(1);
    expect(agentEnds).toHaveLength(1);

    // Should have multiple turn_start events (at least 2: one per loop iteration)
    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
  });

  test("hasFollowUp() reflects queue state", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();

    expect(mgr.hasFollowUp()).toBe(false);
    mgr.followUp("do something later");
    expect(mgr.hasFollowUp()).toBe(true);
  });
});

describe("Context builder: SteeringEntry", () => {
  test("SteeringEntry produces user-role message on resume (no compaction)", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-02-27T10:00:00.000Z",
        message: { role: "user", content: "hello", timestamp: 1708900000000 },
      },
      {
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-02-27T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          model: "test",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1708900000000,
        },
      },
      {
        type: "steering",
        id: "s1",
        parentId: "a2",
        timestamp: "2026-02-27T10:00:02.000Z",
        message: { role: "user", content: "[Steering] change focus", timestamp: 1708900000000 },
        source: "steer",
      },
      {
        type: "message",
        id: "a3",
        parentId: "s1",
        timestamp: "2026-02-27T10:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "understood" }],
          model: "test",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1708900000000,
        },
      },
    ];

    const ctx = buildSessionContext(entries);
    expect(ctx.messages).toHaveLength(4);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[1].role).toBe("assistant");
    expect(ctx.messages[2].role).toBe("user");
    expect(ctx.messages[2].content).toContain("[Steering]");
    expect(ctx.messages[3].role).toBe("assistant");
  });

  test("SteeringEntry works after compaction", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-02-27T10:00:00.000Z",
        message: { role: "user", content: "old", timestamp: 1708900000000 },
      },
      {
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-02-27T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old response" }],
          model: "test",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1708900000000,
        },
      },
      {
        type: "compaction",
        id: "c1",
        parentId: "a2",
        timestamp: "2026-02-27T10:01:00.000Z",
        summary: "Previous conversation summary",
        firstKeptEntryId: "s1",
        tokensBefore: 50000,
        tokensAfter: 5000,
      },
      {
        type: "steering",
        id: "s1",
        parentId: "c1",
        timestamp: "2026-02-27T10:01:01.000Z",
        message: { role: "user", content: "[Steering] new direction", timestamp: 1708900000000 },
        source: "steer",
      },
      {
        type: "message",
        id: "a3",
        parentId: "s1",
        timestamp: "2026-02-27T10:01:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "following new direction" }],
          model: "test",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1708900000000,
        },
      },
    ];

    const ctx = buildSessionContext(entries);
    // summary + steering + assistant response
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0].content as string).toContain("[Session Summary]");
    expect(ctx.messages[1].role).toBe("user");
    expect(ctx.messages[1].content).toContain("[Steering]");
    expect(ctx.messages[2].role).toBe("assistant");
  });
});

describe("Session version", () => {
  test("SESSION_VERSION is 4", () => {
    expect(SESSION_VERSION).toBe(4);
  });
});
