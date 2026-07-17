// @summary Contract tests for openai-compatible.ts shared helpers used by zai-coding-plan, vertex, and openai providers
import { describe, expect, test } from "bun:test";
import { EventStream } from "../../../src/event-stream";
import {
  buildOpenAICompatibleMessages,
  buildOpenAICompatibleTools,
  handleChatCompletionsEvents,
  mapChatCompletionsStopReason,
  mapChatCompletionsUsage,
} from "../../../src/llm/provider/openai-compatible";
import type { Model, ProviderEvent, ProviderResult } from "../../../src/llm/types";
import type { AssistantMessage } from "../../../src/types";

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "openai",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsThinking: true,
};

function makeStream(): EventStream<ProviderEvent, ProviderResult> {
  return new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );
}

async function collectEvents(stream: EventStream<ProviderEvent, ProviderResult>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function* makeAsyncIter(payloads: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const payload of payloads) {
    yield payload;
  }
}

// ---------------------------------------------------------------------------
// buildOpenAICompatibleMessages
// ---------------------------------------------------------------------------

describe("buildOpenAICompatibleMessages", () => {
  test("converts a simple string user message", async () => {
    const messages = await buildOpenAICompatibleMessages([{ role: "user", content: "hello world", timestamp: 1 }]);
    expect(messages).toEqual([{ role: "user", content: "hello world" }]);
  });

  test("converts a user message with text content block", async () => {
    const messages = await buildOpenAICompatibleMessages([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(Array.isArray(messages[0].content)).toBe(true);
    const content = messages[0].content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: "text", text: "hello" });
  });

  test("converts an assistant message with text only", async () => {
    const messages = await buildOpenAICompatibleMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "I can help" }],
        model: TEST_MODEL.id,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
    ]);
    expect(messages).toEqual([{ role: "assistant", content: "I can help" }]);
  });

  test("converts an assistant message with a tool call", async () => {
    const messages = await buildOpenAICompatibleMessages([
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "tc_1", name: "bash", input: { command: "ls" } }],
        model: TEST_MODEL.id,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: Date.now(),
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBeNull();
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls![0]).toMatchObject({
      id: "tc_1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
    });
  });

  test("converts an assistant message with both text and a tool call", async () => {
    const messages = await buildOpenAICompatibleMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure, running it now." },
          { type: "tool_call", id: "tc_2", name: "bash", input: { command: "pwd" } },
        ],
        model: TEST_MODEL.id,
        usage: { inputTokens: 5, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: Date.now(),
      },
    ]);
    expect(messages[0].content).toBe("Sure, running it now.");
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls![0].function.name).toBe("bash");
  });

  test("skips empty assistant messages (no text, no tool calls)", async () => {
    const messages = await buildOpenAICompatibleMessages([
      {
        role: "assistant",
        content: [],
        model: TEST_MODEL.id,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
    ]);
    expect(messages).toHaveLength(0);
  });

  test("converts a tool result message", async () => {
    const messages = await buildOpenAICompatibleMessages([
      {
        role: "tool_result",
        toolCallId: "tc_1",
        toolName: "bash",
        output: "total 12\ndrwxr-xr-x",
        isError: false,
        timestamp: 1,
      },
    ]);
    expect(messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tc_1",
        name: "bash",
        content: "total 12\ndrwxr-xr-x",
      },
    ]);
  });

  test("converts a multi-turn conversation", async () => {
    const now = Date.now();
    const messages = await buildOpenAICompatibleMessages([
      { role: "user", content: "run ls", timestamp: now },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "tc_3", name: "bash", input: { command: "ls" } }],
        model: TEST_MODEL.id,
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: now,
      },
      {
        role: "tool_result",
        toolCallId: "tc_3",
        toolName: "bash",
        output: "file.txt",
        isError: false,
        timestamp: now,
      },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// buildOpenAICompatibleTools
// ---------------------------------------------------------------------------

describe("buildOpenAICompatibleTools", () => {
  test("converts a function tool definition", () => {
    const tools = buildOpenAICompatibleTools([
      {
        kind: "function",
        name: "bash",
        description: "Run a shell command",
        inputSchema: {
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    });
  });

  test("filters out non-function tool kinds", () => {
    const tools = buildOpenAICompatibleTools([
      { kind: "provider_builtin", capability: "web" },
      {
        kind: "function",
        name: "read",
        description: "Read a file",
        inputSchema: { properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("read");
  });

  test("returns empty array for empty input", () => {
    expect(buildOpenAICompatibleTools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapChatCompletionsStopReason
// ---------------------------------------------------------------------------

describe("mapChatCompletionsStopReason", () => {
  test.each([
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
    ["content_filter", "error"],
    ["stop", "end_turn"],
    ["unknown_value", "end_turn"],
    [null, "end_turn"],
    [undefined, "end_turn"],
  ])("maps %s → %s", (input, expected) => {
    expect(mapChatCompletionsStopReason(input as string | null | undefined)).toBe(
      expected as ReturnType<typeof mapChatCompletionsStopReason>,
    );
  });
});

// ---------------------------------------------------------------------------
// mapChatCompletionsUsage
// ---------------------------------------------------------------------------

describe("mapChatCompletionsUsage", () => {
  test("maps normal usage without cached tokens", () => {
    expect(mapChatCompletionsUsage({ prompt_tokens: 100, completion_tokens: 50 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("subtracts cached tokens from inputTokens", () => {
    expect(
      mapChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 50,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });
  });

  test("clamps inputTokens to 0 when cached exceeds prompt tokens", () => {
    const result = mapChatCompletionsUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    expect(result.inputTokens).toBe(0);
  });

  test("returns zeros for undefined input", () => {
    expect(mapChatCompletionsUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// handleChatCompletionsEvents
// ---------------------------------------------------------------------------

describe("handleChatCompletionsEvents", () => {
  test("text-only response: emits text_delta, text_end, usage, done", async () => {
    const stream = makeStream();

    const payloads = [
      {
        choices: [{ delta: { content: "Hello, " }, finish_reason: null }],
      },
      {
        choices: [{ delta: { content: "world!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      },
    ];

    await handleChatCompletionsEvents(makeAsyncIter(payloads), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    expect(events.map((e) => e.type)).toEqual(["text_delta", "text_delta", "text_end", "usage", "done"]);

    const textEnd = events.find((e) => e.type === "text_end") as { type: "text_end"; text: string };
    expect(textEnd.text).toBe("Hello, world!");

    const result = await stream.result();
    expect((result.message as AssistantMessage).stopReason).toBe("end_turn");
    expect((result.message as AssistantMessage).content[0]).toEqual({
      type: "text",
      text: "Hello, world!",
    });
  });

  test("reasoning_content response: emits thinking events before text", async () => {
    const stream = makeStream();

    const payloads = [
      {
        choices: [{ delta: { reasoning_content: "Think " }, finish_reason: null }],
      },
      {
        choices: [{ delta: { reasoning_content: "step." }, finish_reason: null }],
      },
      {
        choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      },
    ];

    await handleChatCompletionsEvents(makeAsyncIter(payloads), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    expect(events.map((e) => e.type)).toEqual([
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_delta",
      "text_end",
      "usage",
      "done",
    ]);

    const thinkingEnd = events.find((e) => e.type === "thinking_end") as { type: "thinking_end"; thinking: string };
    expect(thinkingEnd.thinking).toBe("Think step.");

    const result = await stream.result();
    expect((result.message as AssistantMessage).content[0]).toEqual({ type: "thinking", thinking: "Think step." });
    expect((result.message as AssistantMessage).content[1]).toEqual({ type: "text", text: "Answer." });
  });

  test("tool call response: emits tool_call_start, deltas, tool_call_end, done", async () => {
    const stream = makeStream();

    const payloads = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "tc_abc", function: { name: "bash", arguments: '{"command"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 20 },
      },
    ];

    await handleChatCompletionsEvents(makeAsyncIter(payloads), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "usage",
      "done",
    ]);

    const callStart = events.find((e) => e.type === "tool_call_start") as {
      type: "tool_call_start";
      id: string;
      name: string;
    };
    expect(callStart.name).toBe("bash");
    expect(callStart.id).toBe("tc_abc");

    const callEnd = events.find((e) => e.type === "tool_call_end") as {
      type: "tool_call_end";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    expect(callEnd.input).toEqual({ command: "ls" });

    const result = await stream.result();
    expect((result.message as AssistantMessage).stopReason).toBe("tool_use");
  });

  test("fragmented tool arguments with malformed JSON fallback", async () => {
    const stream = makeStream();

    const payloads = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "tc_x", function: { name: "read", arguments: "INVALID_JSON" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      },
    ];

    await handleChatCompletionsEvents(makeAsyncIter(payloads), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    const callEnd = events.find((e) => e.type === "tool_call_end") as {
      type: "tool_call_end";
      input: Record<string, unknown>;
    };
    expect(callEnd.input).toEqual({ _raw: "INVALID_JSON" });
  });

  test("abort mid-stream: stops emitting events after abort", async () => {
    const controller = new AbortController();
    const stream = makeStream();
    const events: ProviderEvent[] = [];

    stream.subscribe((event) => events.push(event));

    async function* abortingIter(): AsyncIterable<Record<string, unknown>> {
      yield { choices: [{ delta: { content: "partial" }, finish_reason: null }] };
      controller.abort();
      yield {
        choices: [{ delta: { content: " more" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
    }

    await handleChatCompletionsEvents(abortingIter(), stream, TEST_MODEL, controller.signal);
    expect(events.map((e) => e.type)).toEqual(["text_delta"]);
  });

  test("usage in a standalone payload (not attached to choices) is captured", async () => {
    const stream = makeStream();

    const payloads = [
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    await handleChatCompletionsEvents(makeAsyncIter(payloads), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    const usageEvent = events.find((e) => e.type === "usage") as {
      type: "usage";
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(usageEvent.usage.outputTokens).toBe(5);
  });

  test("mixed text and tool call in same response", async () => {
    const stream = makeStream();

    const payloads = [
      {
        choices: [{ delta: { content: "Let me check." }, finish_reason: null }],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "tc_y", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 12 },
      },
    ];

    await handleChatCompletionsEvents(makeAsyncIter(payloads), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_end");
    expect(types).toContain("done");

    const result = await stream.result();
    const msg = result.message as AssistantMessage;
    expect(msg.content.some((b) => b.type === "text")).toBe(true);
    expect(msg.content.some((b) => b.type === "tool_call")).toBe(true);
  });
});
