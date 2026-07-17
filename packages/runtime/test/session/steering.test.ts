// @summary Tests for unified session steering (single queue, event-ordered persistence)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, COMPACTION_SUMMARY_PREFIX } from "@diligent/core/agent";
import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage, UserMessage } from "@diligent/core/message-contract";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import { resolvePaths } from "@diligent/runtime/infrastructure";
import type { SessionEntry, SessionManagerConfig } from "@diligent/runtime/session";
import {
  appendEntry,
  buildSessionContext,
  createSessionFile,
  readSessionFile,
  SessionManager,
} from "@diligent/runtime/session";
import { z } from "zod";
import type { AgentEvent } from "../../src/agent-event";

const TEST_ROOT = join(tmpdir(), `diligent-steering-test-${Date.now()}`);

const TEST_MODEL: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
};

function makeAssistant(text: string = "hi"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: TEST_MODEL,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function makeToolCallAssistant(toolCallId: string, toolName: string, input: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: toolCallId, name: toolName, input }],
    model: TEST_MODEL,
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
    agent: new Agent(TEST_MODEL, [{ label: "test", content: "test" }], tools, {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    }),
  };
}

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("SessionManager.steer() — unified queue", () => {
  test("steer() message is drained into agent loop and persisted via event-ordered persistence", async () => {
    const dir = await setupDir();
    const toolCallResponse = makeToolCallAssistant("tc_1", "echo", { message: "hi" });
    const finalResponse = makeAssistant("acknowledged steering");
    const mgr = new SessionManager(
      makeManagerConfig(dir, createMockStreamFn([toolCallResponse, finalResponse]), [echoTool]),
    );
    await mgr.create();

    const events: AgentEvent[] = [];
    const unsub = mgr.subscribe((e) => events.push(e));
    // Steer before run — gets picked up after the tool call turn
    mgr.steer("change approach");
    await mgr.run({ role: "user", content: "hello", timestamp: Date.now() });
    unsub();
    await mgr.waitForWrites();

    // Should have a steering_injected event from the agent loop
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);

    // Steering message should be persisted as a regular message entry (not SteeringEntry)
    const { entries } = await readSessionFile(mgr.sessionPath!);
    const userEntries = entries.filter(
      (e) => e.type === "message" && e.message.role === "user" && typeof e.message.content === "string",
    );
    const hasSteeringContent = userEntries.some(
      (e) => e.type === "message" && ((e.message as UserMessage).content as string) === "change approach",
    );
    expect(hasSteeringContent).toBe(true);

    // No steering-type entries should exist
    const steeringEntries = entries.filter((e) => (e as { type: string }).type === "steering");
    expect(steeringEntries).toHaveLength(0);
  });

  test("hasPendingMessages() reflects queue state", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    await mgr.create();

    expect(mgr.hasPendingMessages()).toBe(false);
    mgr.steer("do something");
    expect(mgr.hasPendingMessages()).toBe(true);
  });

  test("steer() triggers additional loop iteration via pending queue", async () => {
    const dir = await setupDir();
    const mgr = new SessionManager(
      makeManagerConfig(
        dir,
        createMockStreamFn([makeAssistant("initial response"), makeAssistant("follow-up response")]),
      ),
    );
    await mgr.create();

    const events: AgentEvent[] = [];
    let messageEndCount = 0;
    const unsub = mgr.subscribe((e) => {
      events.push(e);
      // Steer on first message_end — fires before hasPendingMessages check → causes loop to continue
      if (e.type === "message_end" && ++messageEndCount === 1) {
        mgr.steer("task 2");
      }
    });
    await mgr.run({ role: "user", content: "task 1", timestamp: Date.now() });
    unsub();

    // Should have exactly 1 agent_start and 1 agent_end (outer lifecycle)
    const agentStarts = events.filter((e) => e.type === "agent_start");
    const agentEnds = events.filter((e) => e.type === "agent_end");
    expect(agentStarts).toHaveLength(1);
    expect(agentEnds).toHaveLength(1);

    // Should have multiple turn_start events (at least 2: one per loop iteration)
    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Context builder: message entries on resume", () => {
  test("message entries produce user-role messages on resume (no compaction)", () => {
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
          model: { provider: "anthropic", modelId: "test" },
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1708900000000,
        },
      },
      {
        type: "message",
        id: "s1",
        parentId: "a2",
        timestamp: "2026-02-27T10:00:02.000Z",
        message: { role: "user", content: "change focus", timestamp: 1708900000000 },
      },
      {
        type: "message",
        id: "a3",
        parentId: "s1",
        timestamp: "2026-02-27T10:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "understood" }],
          model: { provider: "anthropic", modelId: "test" },
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
    expect((ctx.messages[2] as UserMessage).content).toContain("change focus");
    expect(ctx.messages[3].role).toBe("assistant");
  });

  test("steering messages work after compaction", () => {
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
          model: { provider: "anthropic", modelId: "test" },
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
        summary: `${COMPACTION_SUMMARY_PREFIX}\n\nPrevious conversation summary`,
        recentUserMessages: [],
        tokensBefore: 50000,
        tokensAfter: 5000,
      },
      {
        type: "message",
        id: "s1",
        parentId: "c1",
        timestamp: "2026-02-27T10:01:01.000Z",
        message: { role: "user", content: "new direction", timestamp: 1708900000000 },
      },
      {
        type: "message",
        id: "a3",
        parentId: "s1",
        timestamp: "2026-02-27T10:01:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "following new direction" }],
          model: { provider: "anthropic", modelId: "test" },
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1708900000000,
        },
      },
    ];

    const ctx = buildSessionContext(entries);
    // summary + steering + assistant response
    expect(ctx.messages).toHaveLength(3);
    expect((ctx.messages[0] as UserMessage).content as string).toContain("Another language model started");
    expect(ctx.messages[1].role).toBe("user");
    expect((ctx.messages[1] as UserMessage).content).toContain("new direction");
    expect(ctx.messages[2].role).toBe("assistant");
  });
});

describe("SessionManager orphaned tool-call repair", () => {
  test("resume repairs partial tool_result batches even when later user/error entries exist", async () => {
    const dir = await setupDir();
    const paths = resolvePaths(dir);
    const sessionId = `20260706124403825000-test-${Math.random().toString(36).slice(2, 6)}`;
    const { path } = await createSessionFile(paths.sessions, dir, undefined, undefined, sessionId);

    await appendEntry(path, {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-07-06T12:44:03.000Z",
      message: { role: "user", content: "start", timestamp: 1783341843000 },
    });
    await appendEntry(path, {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-07-06T12:44:34.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "tc_1", name: "bash", input: { command: "echo one" } },
          { type: "tool_call", id: "tc_2", name: "bash", input: { command: "echo two" } },
        ],
        model: TEST_MODEL,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: 1783341874000,
      },
    });
    await appendEntry(path, {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-07-06T12:44:35.000Z",
      message: {
        role: "tool_result",
        toolCallId: "tc_1",
        toolName: "bash",
        output: "one",
        isError: false,
        timestamp: 1783341875000,
      },
    });
    await appendEntry(path, {
      type: "message",
      id: "u2",
      parentId: "r1",
      timestamp: "2026-07-06T12:47:32.000Z",
      message: { role: "user", content: "continue", timestamp: 1783342052000 },
    });
    await appendEntry(path, {
      type: "error",
      id: "e1",
      parentId: "u2",
      timestamp: "2026-07-06T12:47:33.000Z",
      fatal: false,
      error: { name: "ProviderError", message: "missing tool_result", stack: "ProviderError" },
    });

    const mgr = new SessionManager(makeManagerConfig(dir, createMockStreamFn([])));
    expect(await mgr.resume({ sessionId })).toBe(true);
    await mgr.waitForWrites();

    const context = mgr.getContext();
    const toolResults = context.filter((message) => message.role === "tool_result");
    expect(toolResults.map((message) => message.toolCallId)).toEqual(["tc_1", "tc_2"]);
    expect(toolResults[1]).toMatchObject({ toolName: "bash", output: "[Cancelled]", isError: false });
    expect(context.some((message) => message.role === "user" && message.content === "continue")).toBe(false);

    const { entries } = await readSessionFile(path);
    const repaired = entries.find(
      (entry) =>
        entry.type === "message" && entry.message.role === "tool_result" && entry.message.toolCallId === "tc_2",
    );
    expect(repaired).toBeDefined();
    expect(repaired?.parentId).toBe("r1");
  });
});
