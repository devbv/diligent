import { describe, expect, it } from "bun:test";
import type { AgentEvent, SerializableError } from "../src/agent/types";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../src/types";

function assertJsonRoundtrip<T>(value: T): void {
  const serialized = JSON.stringify(value);
  const deserialized = JSON.parse(serialized);
  expect(deserialized).toEqual(value);
}

function makeAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1708900000000,
  };
}

function makeUser(): UserMessage {
  return { role: "user", content: "hi", timestamp: 1708900000000 };
}

function makeToolResult(): ToolResultMessage {
  return {
    role: "tool_result",
    toolCallId: "tc-1",
    toolName: "bash",
    output: "hello\n",
    isError: false,
    timestamp: 1708900000000,
  };
}

describe("D086: JSON serialization contract", () => {
  it("AgentEvent variants roundtrip", () => {
    const assistant = makeAssistant();
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "agent_end", messages: [makeUser(), assistant] },
      { type: "turn_start", turnId: "turn-1" },
      { type: "turn_end", turnId: "turn-1", message: assistant, toolResults: [makeToolResult()] },
      { type: "message_start", itemId: "msg-1", message: assistant },
      { type: "message_delta", itemId: "msg-1", message: assistant, delta: { type: "text_delta", delta: "Hi" } },
      {
        type: "message_delta",
        itemId: "msg-1",
        message: assistant,
        delta: { type: "thinking_delta", delta: "thinking..." },
      },
      { type: "message_end", itemId: "msg-1", message: assistant },
      { type: "tool_start", itemId: "tool-1", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
      { type: "tool_update", itemId: "tool-1", toolCallId: "tc-1", toolName: "bash", partialResult: "partial" },
      {
        type: "tool_end",
        itemId: "tool-1",
        toolCallId: "tc-1",
        toolName: "bash",
        output: "hello\n",
        isError: false,
      },
      { type: "status_change", status: "idle" },
      { type: "status_change", status: "retry", retry: { attempt: 2, delayMs: 4000 } },
      {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0.001,
      },
      { type: "error", error: { message: "something broke", name: "Error", stack: "at line 1" }, fatal: true },
      { type: "error", error: { message: "non-fatal", name: "TypeError" }, fatal: false },
    ];

    for (const event of events) {
      assertJsonRoundtrip(event);
    }
  });

  it("SerializableError roundtrips without data loss", () => {
    const errors: SerializableError[] = [
      { message: "msg", name: "Error" },
      { message: "msg", name: "TypeError", stack: "Error: msg\n  at foo (bar.ts:1:1)" },
    ];
    for (const err of errors) {
      assertJsonRoundtrip(err);
    }
  });

  it("Message types roundtrip", () => {
    const messages: Message[] = [
      makeUser(),
      { role: "user", content: [{ type: "text", text: "complex" }], timestamp: 1708900000000 },
      makeAssistant(),
      makeToolResult(),
    ];
    for (const msg of messages) {
      assertJsonRoundtrip(msg);
    }
  });

  it("AssistantMessage with all content block types roundtrips", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Let me think..." },
        { type: "tool_call", id: "tc-1", name: "bash", input: { command: "ls" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
      ],
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn",
      timestamp: 1708900000000,
    };
    assertJsonRoundtrip(msg);
  });
});
