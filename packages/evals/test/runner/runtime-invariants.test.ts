// @summary Tests stable mode/tool and persisted thread-read parity invariants

import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@diligent/core/message-contract";
import { checkRuntimeInvariants } from "../../src/runner/runtime-invariants";
import type { RuntimeEvalExecution, RuntimeEvalLimits } from "../../src/runtime-task";

const limits: RuntimeEvalLimits = {
  maxTurns: 2,
  maxToolCalls: 2,
  maxOutputTokens: 1_000,
  timeoutMs: 5_000,
  maxChangedFiles: 0,
  maxChangedBytes: 0,
  maxUserInputRequests: 0,
  maxChildAgents: 0,
  verifierTimeoutMs: 1_000,
};

function execution(): RuntimeEvalExecution<unknown> {
  const userMessage = { role: "user" as const, content: "hello", timestamp: 1 };
  const assistantMessage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "done" }],
    model: { provider: "anthropic" as const, modelId: "claude-sonnet-5" },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn" as const,
    timestamp: 2,
  };
  return {
    taskId: "invariant-test",
    profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
    seed: "seed",
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    turns: [],
    compactions: [],
    threadCwd: "$WORKSPACE",
    advertisedTools: [
      {
        sequence: 1,
        turnIndex: 0,
        cwd: "$WORKSPACE",
        mode: "plan",
        provider: "anthropic",
        tools: ["read", "plan"],
      },
    ],
    threadReads: [
      {
        phase: "after_turn",
        turnIndex: 0,
        response: {
          cwd: "$WORKSPACE",
          items: [
            { type: "userMessage", itemId: "user-1", message: userMessage, timestamp: 1 },
            {
              type: "agentMessage",
              itemId: "assistant-1",
              message: assistantMessage,
              timestamp: 2,
              usage: assistantMessage.usage,
              cost: 0,
            },
          ],
          errors: [],
          hasFollowUp: false,
          pendingSteers: [],
          entryCount: 2,
          isRunning: false,
          currentMode: "plan",
          currentEffort: "medium",
          currentModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
        },
      },
    ],
    protocolActions: [],
    providerCalls: [],
    toolCalls: [],
    toolOutputFiles: [],
    approvals: [],
    userInputRequests: [],
    logs: [],
    session: {
      threadId: "thread-1",
      lines: [
        { type: "session", version: 12, id: "thread-1", timestamp: new Date(0).toISOString(), cwd: "$WORKSPACE" },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: userMessage,
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: new Date(2).toISOString(),
          message: assistantMessage,
        },
      ],
    },
    childSessions: [],
    workspace: { initial: { entries: [] }, final: { entries: [] } },
    runtimeState: { initial: [], final: [], diff: [] },
    world: { protectedPaths: [], allowedChanges: [] },
  };
}

function addOuterTurnWithLifecycles(input: RuntimeEvalExecution<unknown>, lifecycleCount: number): void {
  const messages = input.session.lines
    .slice(1)
    .map((line) => (line as { message: RuntimeEvalExecution<unknown>["turns"][number]["messages"][number] }).message);
  const assistant = messages.at(-1) as AssistantMessage;
  const coreEvents = Array.from({ length: lifecycleCount }, (_, index) => {
    const suffix = index + 1;
    return [
      { sequence: suffix * 10 + 1, relativeMs: suffix, event: { type: "agent_start" as const } },
      {
        sequence: suffix * 10 + 2,
        relativeMs: suffix,
        event: { type: "turn_start" as const, turnId: `inner-${suffix}` },
      },
      {
        sequence: suffix * 10 + 3,
        relativeMs: suffix,
        event: { type: "message_start" as const, itemId: `message-${suffix}`, message: assistant },
      },
      {
        sequence: suffix * 10 + 4,
        relativeMs: suffix,
        event: {
          type: "message_delta" as const,
          itemId: `message-${suffix}`,
          message: assistant,
          delta: { type: "text_delta" as const, delta: "done" },
        },
      },
      {
        sequence: suffix * 10 + 5,
        relativeMs: suffix,
        event: { type: "message_end" as const, itemId: `message-${suffix}`, message: assistant },
      },
      {
        sequence: suffix * 10 + 6,
        relativeMs: suffix,
        event: { type: "turn_end" as const, turnId: `inner-${suffix}`, message: assistant, toolResults: [] },
      },
      { sequence: suffix * 10 + 7, relativeMs: suffix, event: { type: "agent_end" as const, messages } },
    ];
  }).flat();
  input.turns = [
    {
      index: 0,
      threadId: "thread-1",
      clientPrompt: "test prompt",
      startedAt: new Date(0).toISOString(),
      elapsedMs: 1,
      termination: "completed",
      coreEvents,
      runtimeEvents: [],
      notifications: [
        { method: "turn/started", params: { threadId: "thread-1", turnId: "outer-1" } },
        { method: "turn/completed", params: { threadId: "thread-1", turnId: "outer-1" } },
      ],
      messages,
      usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ];
}

describe("runtime evidence invariants", () => {
  test("accepts stable persisted/display identities without requiring identical presentation shapes", () => {
    expect(checkRuntimeInvariants(execution(), limits)).toEqual([]);
  });

  test("rejects a plan-mode advertised write tool before task allowlisting", () => {
    const input = execution();
    input.advertisedTools[0]!.tools.push("write");
    expect(
      checkRuntimeInvariants(input, limits).find((failure) => failure.code === "runtime_contract.mode_tool_surface"),
    ).toMatchObject({ dimension: "runtime_policy" });
  });

  test("rejects a thread/read snapshot that omits a persisted visible message", () => {
    const input = execution();
    input.threadReads[0]!.response.items = input.threadReads[0]!.response.items.filter(
      (item) => item.type !== "agentMessage",
    );
    expect(
      checkRuntimeInvariants(input, limits).some((failure) => failure.code === "runtime_contract.thread_read_parity"),
    ).toBe(true);
  });

  test("accepts two balanced and ordered internal agent lifecycles in one outer turn", () => {
    const input = execution();
    addOuterTurnWithLifecycles(input, 2);

    expect(checkRuntimeInvariants(input, limits)).toEqual([]);
  });

  test("rejects overlapping internal agent lifecycles in one outer turn", () => {
    const input = execution();
    addOuterTurnWithLifecycles(input, 2);
    const events = input.turns[0]!.coreEvents;
    const firstEnd = events.findIndex((snapshot) => snapshot.event.type === "agent_end");
    const secondStart = events.findLastIndex((snapshot) => snapshot.event.type === "agent_start");
    [events[firstEnd], events[secondStart]] = [events[secondStart]!, events[firstEnd]!];

    expect(
      checkRuntimeInvariants(input, limits).some((failure) => failure.code === "core_contract.agent_lifecycle_overlap"),
    ).toBe(true);
  });

  test("rejects a nested turn that crosses internal agent lifecycle boundaries", () => {
    const input = execution();
    addOuterTurnWithLifecycles(input, 2);
    const events = input.turns[0]!.coreEvents;
    const firstTurnEnd = events.findIndex((snapshot) => snapshot.event.type === "turn_end");
    const secondTurnEnd = events.findLastIndex((snapshot) => snapshot.event.type === "turn_end");
    [events[firstTurnEnd], events[secondTurnEnd]] = [events[secondTurnEnd]!, events[firstTurnEnd]!];

    expect(
      checkRuntimeInvariants(input, limits).some(
        (failure) => failure.code === "core_contract.agent_lifecycle_unbalanced",
      ),
    ).toBe(true);
  });
});
