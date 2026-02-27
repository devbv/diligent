import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { agentLoop } from "../src/agent/loop";
import type { AgentEvent, AgentLoopConfig } from "../src/agent/types";
import { EventStream } from "../src/event-stream";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction } from "../src/provider/types";
import type { Tool } from "../src/tool/types";
import type { AssistantMessage, Message } from "../src/types";

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

describe("agentLoop steering", () => {
  test("steering messages injected before LLM call are visible in context", async () => {
    // First call: LLM makes a tool call. Second call: LLM responds with text.
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "hi" } }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    let callCount = 0;
    const steeringMessages: Message[] = [];

    // Queue a steering message that will be drained before the first LLM call
    steeringMessages.push({
      role: "user",
      content: "[Steering] change direction",
      timestamp: Date.now(),
    });

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [echoTool],
      streamFunction: streamFn,
      getSteeringMessages: () => {
        callCount++;
        // Only return messages on first drain
        if (callCount === 1) {
          return steeringMessages.splice(0);
        }
        return [];
      },
    };

    const messages: Message[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    // Should have emitted steering_injected event
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);
    expect((steeringEvents[0] as { type: "steering_injected"; messageCount: number }).messageCount).toBe(1);

    // The steering message should be visible in the second LLM call's context
    // (first call sees original + steering, tool result; second call sees all)
    expect(streamFn.contexts[0].messages.length).toBeGreaterThanOrEqual(2); // user + steering
    const secondCallMsgs = streamFn.contexts[0].messages;
    const hasSteeringMsg = secondCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[Steering]"),
    );
    expect(hasSteeringMsg).toBe(true);
  });

  test("steering messages injected after tool execution", async () => {
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

    let drainCount = 0;

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [echoTool],
      streamFunction: streamFn,
      getSteeringMessages: () => {
        drainCount++;
        // Inject a steering message after the first tool execution (drain #2: after tools in turn 1)
        if (drainCount === 2) {
          return [
            {
              role: "user" as const,
              content: "[Steering] redirect after tools",
              timestamp: Date.now(),
            },
          ];
        }
        return [];
      },
    };

    const messages: Message[] = [{ role: "user", content: "go", timestamp: Date.now() }];
    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents.length).toBeGreaterThanOrEqual(1);

    // The second LLM call should see the steering message in its context
    expect(streamFn.contexts.length).toBeGreaterThanOrEqual(2);
    const secondCallMsgs = streamFn.contexts[1].messages;
    const hasSteeringMsg = secondCallMsgs.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[Steering] redirect after tools"),
    );
    expect(hasSteeringMsg).toBe(true);
  });

  test("empty steering queue is a no-op", async () => {
    const responseMsg = makeAssistant([{ type: "text", text: "hello" }]);
    const streamFn = createMockStreamFunction([responseMsg]);

    let drainCount = 0;

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      getSteeringMessages: () => {
        drainCount++;
        return []; // Always empty
      },
    };

    const messages: Message[] = [{ role: "user", content: "hi", timestamp: Date.now() }];
    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    // No steering_injected events should be emitted
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents).toHaveLength(0);

    // getSteeringMessages was called (at least once: before LLM)
    expect(drainCount).toBeGreaterThanOrEqual(1);
  });

  test("no getSteeringMessages callback is a no-op", async () => {
    const responseMsg = makeAssistant([{ type: "text", text: "hello" }]);
    const streamFn = createMockStreamFunction([responseMsg]);

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      // No getSteeringMessages
    };

    const messages: Message[] = [{ role: "user", content: "hi", timestamp: Date.now() }];
    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    // No steering_injected events
    const steeringEvents = events.filter((e) => e.type === "steering_injected");
    expect(steeringEvents).toHaveLength(0);
  });
});
