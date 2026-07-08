// @summary Tests for agent loop with steering injection and tool execution
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import type { CoreAgentEvent } from "../../src/agent/types";
import { EventStream } from "../../src/event-stream";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction } from "../../src/llm/types";
import type { Tool } from "../../src/tool/types";
import type { AssistantMessage, Message } from "../../src/types";

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

function makeAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMockStreamFunction(responses: AssistantMessage[]): StreamFunction & { contexts: StreamContext[] } {
  let callIndex = 0;
  const contexts: StreamContext[] = [];

  const fn: StreamFunction = (_model, context, _options) => {
    contexts.push(context);
    const msg = responses[callIndex++];
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    setTimeout(() => {
      stream.push({ type: "start" });
      for (const block of msg.content) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", delta: block.text });
          stream.push({ type: "text_end", text: block.text });
        } else if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({
            type: "tool_call_end",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      stream.push({ type: "done", stopReason: msg.stopReason, message: msg });
    }, 0);

    return stream;
  };

  return Object.assign(fn, { contexts });
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message",
  parameters: z.object({ message: z.string() }),
  async execute(args: { message: string }) {
    return { output: args.message };
  },
};

function makeAgent(streamFn: StreamFunction, toolOverride?: Tool[]): Agent {
  return new Agent(TEST_MODEL, [{ label: "test", content: "test" }], toolOverride ?? [echoTool], {
    effort: "medium",
    llmMsgStreamFn: streamFn,
  });
}

async function runAgent(agent: Agent, userMessage: Message): Promise<{ events: CoreAgentEvent[]; result: Message[] }> {
  const events: CoreAgentEvent[] = [];
  const unsub = agent.subscribe((e) => events.push(e));
  const result = await agent.prompt(userMessage);
  unsub();
  return { events, result };
}

describe("agent steering", () => {
  test("steering messages injected before LLM call are visible in context", async () => {
    // First call: tool call. Second call: text response.
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "hi" } }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = makeAgent(streamFn);

    // Queue a steering message BEFORE prompt() — gets drained at turn 1 start
    agent.steer({ role: "user", content: "change direction", timestamp: Date.now() });

    const { events } = await runAgent(agent, { role: "user", content: "hello", timestamp: Date.now() });

    // Should have emitted steering_injected event with messages
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);
    const firstSteer = steeringEvents[0] as { type: "steering_injected"; messageCount: number; messages: Message[] };
    expect(firstSteer.messageCount).toBe(1);
    expect(firstSteer.messages).toHaveLength(1);
    expect(firstSteer.messages[0].content).toBe("change direction");

    // The steering message should be visible in the first LLM call's context
    expect(streamFn.contexts[0].messages.length).toBeGreaterThanOrEqual(2); // user + steering
    const firstCallMsgs = streamFn.contexts[0].messages;
    const hasSteeringMsg = firstCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("change direction"),
    );
    expect(hasSteeringMsg).toBe(true);
  });

  test("cancelPendingMessage removes queued steering before injection", async () => {
    const streamFn = createMockStreamFunction([makeAssistant([{ type: "text", text: "done" }])]);
    const agent = makeAgent(streamFn);

    const dropId = agent.steer({ role: "user", content: "drop me", timestamp: Date.now() });
    agent.steer({ role: "user", content: "keep me", timestamp: Date.now() });

    expect(agent.cancelPendingMessage(dropId)).toBe(true);

    const { events } = await runAgent(agent, { role: "user", content: "hello", timestamp: Date.now() });
    const steering = events.find((e) => e.type === "steering_injected") as
      | { type: "steering_injected"; messages: Message[] }
      | undefined;

    expect(steering?.messages.map((m) => m.content)).toEqual(["keep me"]);
  });

  test("cancelPendingMessage uses steer id when queue index shifted", () => {
    const agent = makeAgent(createMockStreamFunction([makeAssistant([{ type: "text", text: "done" }])]));

    const keepId = agent.steer({ role: "user", content: "keep me", timestamp: Date.now() });

    expect(agent.cancelPendingMessage(keepId)).toBe(true);
    expect(agent.hasPendingMessages()).toBe(false);
  });

  test("updatePendingMessage edits queued steering before injection", async () => {
    const streamFn = createMockStreamFunction([makeAssistant([{ type: "text", text: "done" }])]);
    const agent = makeAgent(streamFn);

    const steerId = agent.steer({ role: "user", content: "old", timestamp: Date.now() });

    expect(agent.updatePendingMessage(steerId, "new")).toBe(true);

    const { events } = await runAgent(agent, { role: "user", content: "hello", timestamp: Date.now() });
    const steering = events.find((e) => e.type === "steering_injected") as
      | { type: "steering_injected"; messages: Message[] }
      | undefined;

    expect(steering?.messages.map((m) => m.content)).toEqual(["new"]);
  });

  test("updatePendingMessage uses steer id when queue index shifted", async () => {
    const streamFn = createMockStreamFunction([makeAssistant([{ type: "text", text: "done" }])]);
    const agent = makeAgent(streamFn);

    const steerId = agent.steer({ role: "user", content: "old", timestamp: Date.now() });

    expect(agent.updatePendingMessage(steerId, "new")).toBe(true);

    const { events } = await runAgent(agent, { role: "user", content: "hello", timestamp: Date.now() });
    const steering = events.find((e) => e.type === "steering_injected") as
      | { type: "steering_injected"; messages: Message[] }
      | undefined;

    expect(steering?.messages.map((m) => m.content)).toEqual(["new"]);
  });

  test("steering messages injected before next LLM call (drain at loop top)", async () => {
    // Two tool call rounds, then text response
    const toolCallMsg1 = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "first" } }],
      "tool_use",
    );
    const toolCallMsg2 = makeAssistant(
      [{ type: "tool_call", id: "tc_2", name: "echo", input: { message: "second" } }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg1, toolCallMsg2, responseMsg]);

    const agent = makeAgent(streamFn);

    let turnCount = 0;
    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((e) => {
      events.push(e);
      if (e.type === "turn_end" && turnCount === 0) {
        // Steer after turn 1 ends — tool-call turns always continue,
        // so this will be drained at the start of turn 2
        turnCount++;
        agent.steer({ role: "user", content: "redirect after tools", timestamp: Date.now() });
      }
    });
    await agent.prompt({ role: "user", content: "go", timestamp: Date.now() });
    unsub();

    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);

    // The second LLM call should see the steering message in its context
    expect(streamFn.contexts.length).toBeGreaterThanOrEqual(2);
    const secondCallMsgs = streamFn.contexts[1].messages;
    const hasSteeringMsg = secondCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("redirect after tools"),
    );
    expect(hasSteeringMsg).toBe(true);
  });

  test("empty steering queue is a no-op", async () => {
    const responseMsg = makeAssistant([{ type: "text", text: "hello" }]);
    const streamFn = createMockStreamFunction([responseMsg]);

    const agent = makeAgent(streamFn);
    // Don't steer anything

    const { events } = await runAgent(agent, { role: "user", content: "hi", timestamp: Date.now() });

    // No steering_injected events should be emitted
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents).toHaveLength(0);
  });

  test("hasPendingMessages causes loop to continue after text-only response", async () => {
    // Scenario: text-only response, but pending steering messages → loop continues
    const firstMsg = makeAssistant([{ type: "text", text: "initial thoughts" }]);
    const secondMsg = makeAssistant([{ type: "text", text: "addressed steer" }]);
    const streamFn = createMockStreamFunction([firstMsg, secondMsg]);

    const agent = makeAgent(streamFn);

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((e) => {
      events.push(e);
      // Steer on message_end of first response — this fires BEFORE hasPendingMessages check
      if (e.type === "message_end" && streamFn.contexts.length === 1) {
        agent.steer({ role: "user", content: "please focus on X", timestamp: Date.now() });
      }
    });
    await agent.prompt({ role: "user", content: "hello", timestamp: Date.now() });
    unsub();

    // steering_injected should fire (from drain at turn 2 top)
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBe(1);
    expect((steeringEvents[0] as { type: "steering_injected"; messageCount: number }).messageCount).toBe(1);

    // Loop continued — 2 LLM calls
    expect(streamFn.contexts.length).toBe(2);

    // Second LLM call should see the steer message
    const secondCallMsgs = streamFn.contexts[1].messages;
    const hasSteer = secondCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content === "please focus on X",
    );
    expect(hasSteer).toBe(true);
  });

  test("steering during turn_end event continues the loop (PlanCompletionGuard invariant)", async () => {
    // Invariant the runtime PlanCompletionGuard depends on: turn_end is emitted
    // synchronously BEFORE the loop's break check, so a steer queued from a
    // turn_end subscriber increments pendingSteeringCount() and keeps the loop
    // going. Mirrors the message_end test above but for the turn_end hook point.
    const firstMsg = makeAssistant([{ type: "text", text: "premature done" }]);
    const secondMsg = makeAssistant([{ type: "text", text: "kept going" }]);
    const streamFn = createMockStreamFunction([firstMsg, secondMsg]);

    const agent = makeAgent(streamFn);

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((e) => {
      events.push(e);
      // Steer on the first turn_end — fires BEFORE the break check at loop.ts:153
      if (e.type === "turn_end" && streamFn.contexts.length === 1) {
        agent.steer({ role: "user", content: "keep working on the plan", timestamp: Date.now() });
      }
    });
    await agent.prompt({ role: "user", content: "start", timestamp: Date.now() });
    unsub();

    // The loop continued — 2 LLM calls, one steering injection.
    expect(streamFn.contexts.length).toBe(2);
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBe(1);
    const secondCallMsgs = streamFn.contexts[1].messages;
    expect(
      secondCallMsgs.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content === "keep working on the plan",
      ),
    ).toBe(true);
  });

  test("steering during thinking with no tool calls continues loop (codex-rs pattern)", async () => {
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "working" } }],
      "tool_use",
    );
    // Second response: no tool calls (text-only)
    const textOnlyMsg = makeAssistant([{ type: "text", text: "thinking done" }]);
    // Third response: LLM addresses the steers
    const finalMsg = makeAssistant([{ type: "text", text: "addressed steers" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, textOnlyMsg, finalMsg]);

    const agent = makeAgent(streamFn);

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((e) => {
      events.push(e);
      // Steer on message_end of second response (text-only) — fires before hasPendingMessages check
      if (e.type === "message_end" && streamFn.contexts.length === 2) {
        agent.steer({ role: "user", content: "steer A", timestamp: Date.now() });
        agent.steer({ role: "user", content: "steer B", timestamp: Date.now() });
      }
    });
    await agent.prompt({ role: "user", content: "start", timestamp: Date.now() });
    unsub();

    // steering_injected should have been emitted for the 2 steers
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);
    const injectedCount = steeringEvents.reduce(
      (sum, e) => sum + (e as { type: "steering_injected"; messageCount: number }).messageCount,
      0,
    );
    expect(injectedCount).toBe(2);

    // The loop should have continued — 3 LLM calls total
    expect(streamFn.contexts.length).toBe(3);

    // Third LLM call should see both steer messages
    const thirdCallMsgs = streamFn.contexts[2].messages;
    const steerA = thirdCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content === "steer A",
    );
    const steerB = thirdCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content === "steer B",
    );
    expect(steerA).toBe(true);
    expect(steerB).toBe(true);
  });

  test("no tool calls and no pending steers ends loop normally", async () => {
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([responseMsg]);

    const agent = makeAgent(streamFn, []);
    const { events } = await runAgent(agent, { role: "user", content: "hi", timestamp: Date.now() });

    // Only 1 LLM call — loop broke normally
    expect(streamFn.contexts.length).toBe(1);
    expect(events.some((e) => e.type === "steering_injected")).toBe(false);
  });
});
