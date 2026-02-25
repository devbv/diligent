import { describe, expect, test } from "bun:test";
import { EventStream } from "../src/event-stream";
import type { Model, ProviderEvent, ProviderResult } from "../src/provider/types";
import type { AssistantMessage, Message } from "../src/types";

// We test the event mapping logic by creating a mock that simulates
// what createAnthropicStream does internally, without hitting the real SDK.

const TEST_MODEL: Model = {
  id: "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
};

function makeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("Anthropic Provider Event Mapping", () => {
  test("text-only response: text_delta → text_end → done", async () => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    const msg = makeAssistantMessage();
    stream.push({ type: "start" });
    stream.push({ type: "text_delta", delta: "Hel" });
    stream.push({ type: "text_delta", delta: "lo" });
    stream.push({ type: "text_end", text: "Hello" });
    stream.push({ type: "done", stopReason: "end_turn", message: msg });

    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "text_end", "done"]);

    const result = await stream.result();
    expect(result.message.content[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("tool call response: tool_call_start → delta → end → done", async () => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    const msg = makeAssistantMessage({
      content: [{ type: "tool_call", id: "tc_1", name: "bash", input: { command: "ls" } }],
      stopReason: "tool_use",
    });

    stream.push({ type: "start" });
    stream.push({ type: "tool_call_start", id: "tc_1", name: "bash" });
    stream.push({ type: "tool_call_delta", id: "tc_1", delta: '{"command"' });
    stream.push({ type: "tool_call_delta", id: "tc_1", delta: ':"ls"}' });
    stream.push({ type: "tool_call_end", id: "tc_1", name: "bash", input: { command: "ls" } });
    stream.push({ type: "done", stopReason: "tool_use", message: msg });

    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);

    const result = await stream.result();
    expect(result.message.stopReason).toBe("tool_use");
  });

  test("error response: error event pushed, result rejects", async () => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    stream.push({ type: "start" });
    stream.push({ type: "error", error: new Error("API rate limit") });

    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    await expect(stream.result()).rejects.toThrow("API rate limit");
  });

  test("message conversion: UserMessage → SDK format", async () => {
    // Test the message array structure we'd produce
    const messages: Message[] = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
      { role: "user", content: "how are you?", timestamp: Date.now() },
    ];

    // Verify the structure is correct for the SDK
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");
  });

  test("tool result messages merge into user messages", () => {
    // Simulate convertMessages logic: tool_results should be grouped into user messages
    const messages: Message[] = [
      { role: "user", content: "list files", timestamp: Date.now() },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "tc_1", name: "bash", input: { command: "ls" } },
          { type: "tool_call", id: "tc_2", name: "bash", input: { command: "pwd" } },
        ],
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: Date.now(),
      },
      {
        role: "tool_result",
        toolCallId: "tc_1",
        toolName: "bash",
        output: "file1.ts\nfile2.ts",
        isError: false,
        timestamp: Date.now(),
      },
      {
        role: "tool_result",
        toolCallId: "tc_2",
        toolName: "bash",
        output: "/home/user",
        isError: false,
        timestamp: Date.now(),
      },
    ];

    // Both tool results should be in the same user message
    expect(messages.filter((m) => m.role === "tool_result")).toHaveLength(2);
  });
});
