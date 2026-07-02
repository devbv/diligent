// @summary Tests for Anthropic provider event stream mapping
import { describe, expect, test } from "bun:test";
import { EventStream } from "../../../src/event-stream";
import { convertMessages, convertTools } from "../../../src/llm/provider/anthropic";
import type { Model, ProviderEvent, ProviderResult, ToolDefinition } from "../../../src/llm/types";
import type { AssistantMessage } from "../../../src/types";

// We test the event mapping logic by creating a mock that simulates
// what createAnthropicStream does internally, without hitting the real SDK.

const TEST_MODEL: Model = {
  id: "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 300_000,
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
});

describe("convertTools top-level schema flattening", () => {
  function fnTool(inputSchema: Record<string, unknown>): ToolDefinition {
    return { kind: "function", name: "t", description: "d", inputSchema } as ToolDefinition;
  }
  function schemaOf(inputSchema: Record<string, unknown>): Record<string, unknown> {
    const tools = convertTools([fnTool(inputSchema)]);
    return (tools?.[0] as { input_schema: Record<string, unknown> }).input_schema;
  }

  test("passes a plain object schema through unchanged", () => {
    const schema = schemaOf({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    expect(schema).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
  });

  test("flattens a top-level anyOf, dropping the forbidden keyword", () => {
    const schema = schemaOf({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(schema.anyOf).toBeUndefined();
    expect(schema.type).toBe("object");
    // Union of properties, and no key required by *every* branch.
    expect(schema.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect(schema.required).toBeUndefined();
  });

  test("anyOf keeps keys required by all branches", () => {
    const schema = schemaOf({
      anyOf: [
        { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
        { type: "object", properties: { a: { type: "string" }, c: { type: "boolean" } }, required: ["a"] },
      ],
    });
    expect(schema.required).toEqual(["a"]);
  });

  test("allOf merges branches and unions required keys", () => {
    const schema = schemaOf({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(schema.allOf).toBeUndefined();
    expect(schema.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect(schema.required).toEqual(["a", "b"]);
  });

  test("flattens a nested union inside a branch", () => {
    const schema = schemaOf({
      anyOf: [
        { oneOf: [{ type: "object", properties: { a: { type: "string" } } }] },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
  });
});

describe("Anthropic message conversion", () => {
  test("replays Anthropic provider-native web blocks as native server tool blocks", async () => {
    const converted = await convertMessages([
      {
        role: "assistant",
        content: [
          {
            type: "provider_tool_use",
            id: "ws_1",
            provider: "anthropic",
            name: "web_search",
            input: { query: "diligent" },
          },
          {
            type: "web_search_result",
            toolUseId: "ws_1",
            provider: "anthropic",
            results: [
              {
                url: "https://example.com",
                title: "Example",
                pageAge: "1 day",
                encryptedContent: "enc1",
              },
            ],
          },
          {
            type: "provider_tool_use",
            id: "wf_1",
            provider: "anthropic",
            name: "web_fetch",
            input: { url: "https://example.com/page" },
          },
          {
            type: "web_fetch_result",
            toolUseId: "wf_1",
            provider: "anthropic",
            url: "https://example.com/page",
            document: {
              mimeType: "text/plain",
              text: "Page body",
              title: "Fetched Page",
              citationsEnabled: true,
            },
            retrievedAt: "2026-04-06T00:00:00Z",
          },
        ],
        model: TEST_MODEL.id,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1,
      },
      { role: "tool_result", toolCallId: "tc_1", output: "ok", timestamp: 2 },
    ]);

    expect(converted[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "ws_1",
          name: "web_search",
          input: { query: "diligent" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "ws_1",
          caller: { type: "direct" },
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
              encrypted_content: "enc1",
              page_age: "1 day",
            },
          ],
        },
        {
          type: "server_tool_use",
          id: "wf_1",
          name: "web_fetch",
          input: { url: "https://example.com/page" },
        },
        {
          type: "web_fetch_tool_result",
          tool_use_id: "wf_1",
          caller: { type: "direct" },
          content: {
            type: "web_fetch_result",
            url: "https://example.com/page",
            retrieved_at: "2026-04-06T00:00:00Z",
            content: {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: "Page body" },
              title: "Fetched Page",
              citations: { enabled: true },
            },
          },
        },
      ],
    });
    expect(converted[1]?.role).toBe("user");
  });

  test("omits non-Anthropic provider-native blocks during Anthropic replay", async () => {
    const converted = await convertMessages([
      {
        role: "assistant",
        content: [
          { type: "provider_tool_use", id: "ws_1", provider: "openai", name: "web_search", input: { query: "x" } },
          { type: "text", text: "done" },
        ],
        model: TEST_MODEL.id,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1,
      },
    ]);

    expect(converted).toEqual([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
  });

  test("omits assistant thinking blocks without a signature from another provider", async () => {
    const converted = await convertMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning from another provider" },
          { type: "text", text: "done" },
        ],
        model: TEST_MODEL.id,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1,
      },
    ]);

    expect(converted).toEqual([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
  });
});
