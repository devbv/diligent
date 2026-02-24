import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { agentLoop } from "../src/agent/loop";
import { EventStream } from "../src/event-stream";
import type { AgentEvent, AgentLoopConfig } from "../src/agent/types";
import type {
  StreamFunction,
  ProviderEvent,
  ProviderResult,
  Model,
} from "../src/provider/types";
import type { Message, AssistantMessage, UserMessage } from "../src/types";
import type { Tool } from "../src/tool/types";

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

function makeAssistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMockStreamFunction(responses: AssistantMessage[]): StreamFunction {
  let callIndex = 0;
  return () => {
    const msg = responses[callIndex++];
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    // Simulate async streaming
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
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message",
  parameters: z.object({ message: z.string() }),
  async execute(args: { message: string }) {
    return { output: args.message };
  },
};

describe("agentLoop", () => {
  test("text-only response: single turn", async () => {
    const msg = makeAssistant([{ type: "text", text: "Hello!" }]);
    const streamFn = createMockStreamFunction([msg]);

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      apiKey: "test-key",
    };

    const messages: Message[] = [
      { role: "user", content: "hi", timestamp: Date.now() },
    ];

    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("turn_start");
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
    expect(types).toContain("turn_end");
    expect(types).toContain("agent_end");

    const result = await loop.result();
    expect(result.length).toBeGreaterThan(1); // user + assistant
  });

  test("tool call: two turns (LLM → tool → LLM → response)", async () => {
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "hello" } }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "The echo returned: hello" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [echoTool],
      streamFunction: streamFn,
      apiKey: "test-key",
    };

    const messages: Message[] = [
      { role: "user", content: "echo hello", timestamp: Date.now() },
    ];

    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");

    // Should have two turn_start events
    expect(types.filter((t) => t === "turn_start")).toHaveLength(2);

    const toolEnd = events.find((e) => e.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }>;
    expect(toolEnd.toolName).toBe("echo");
    expect(toolEnd.output).toBe("hello");
  });

  test("maxTurns safety: loop exits after max turns", async () => {
    // Create an infinite tool call loop
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "loop" } }],
      "tool_use",
    );
    const streamFn = createMockStreamFunction([
      toolCallMsg,
      toolCallMsg,
      toolCallMsg,
    ]);

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [echoTool],
      streamFunction: streamFn,
      apiKey: "test-key",
      maxTurns: 2,
    };

    const messages: Message[] = [
      { role: "user", content: "loop", timestamp: Date.now() },
    ];

    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    // Should have exactly 2 turn_starts
    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(2);
  });

  test("unknown tool: error result fed back to LLM", async () => {
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "nonexistent", input: {} }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "Sorry, that tool doesn't exist" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      systemPrompt: "test",
      tools: [echoTool],
      streamFunction: streamFn,
      apiKey: "test-key",
    };

    const messages: Message[] = [
      { role: "user", content: "use fake tool", timestamp: Date.now() },
    ];

    const loop = agentLoop(messages, config);
    const events: AgentEvent[] = [];
    for await (const event of loop) {
      events.push(event);
    }

    const toolEnd = events.find((e) => e.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }>;
    expect(toolEnd.isError).toBe(true);
    expect(toolEnd.output).toContain("Unknown tool");
  });
});
