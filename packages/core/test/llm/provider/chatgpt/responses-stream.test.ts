// @summary Tests for OpenAI Responses event reduction used by ChatGPT
import { afterEach, describe, expect, test } from "bun:test";
import { toSerializableError } from "../../../../src/agent/util/errors";
import type { EventStream } from "../../../../src/event-stream";
import { handleResponsesAPIEvents } from "../../../../src/llm/provider/openai/sse";
import { ProviderError, type ProviderEvent, type ProviderResult } from "../../../../src/llm/types";
import {
  collectEvents,
  makeProviderEventStream,
  restoreChatGPTStreamTestState,
  TEST_MODEL,
} from "../../../helpers/chatgpt-stream";

afterEach(restoreChatGPTStreamTestState);

describe("handleResponsesAPIEvents", () => {
  test("correlates interleaved function-call item IDs with public call IDs", async () => {
    const stream = makeProviderEventStream();

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "item_1", type: "function_call", call_id: "call_1", name: "read" },
      };
      yield {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "item_2", type: "function_call", call_id: "call_2", name: "write" },
      };
      yield { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, delta: '{"a":' };
      yield { type: "response.function_call_arguments.delta", item_id: "item_2", output_index: 1, delta: '{"b":' };
      yield { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, delta: "1}" };
      yield { type: "response.function_call_arguments.delta", item_id: "item_2", output_index: 1, delta: "2}" };
      yield {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "item_1", type: "function_call", call_id: "call_1", name: "read", arguments: '{"a":1}' },
      };
      yield {
        type: "response.output_item.done",
        output_index: 1,
        item: { id: "item_2", type: "function_call", call_id: "call_2", name: "write", arguments: '{"b":2}' },
      };
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const events = await collectEvents(stream);
    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", id: "call_1", delta: '{"a":' },
      { type: "tool_call_delta", id: "call_2", delta: '{"b":' },
      { type: "tool_call_delta", id: "call_1", delta: "1}" },
      { type: "tool_call_delta", id: "call_2", delta: "2}" },
    ]);
    expect((await stream.result()).message.content).toEqual([
      { type: "tool_call", id: "call_1", name: "read", input: { a: 1 } },
      { type: "tool_call", id: "call_2", name: "write", input: { b: 2 } },
    ]);
  });

  test("treats response.incomplete max_output_tokens as terminal max_tokens and preserves usage", async () => {
    const stream = makeProviderEventStream();
    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield { type: "response.output_text.delta", delta: "partial" };
      yield {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 7, output_tokens: 11 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const events = await collectEvents(stream);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
    expect((await stream.result()).message.usage).toEqual({
      inputTokens: 7,
      outputTokens: 11,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("treats response.incomplete content_filter as terminal error, not a network failure", async () => {
    const stream = makeProviderEventStream();
    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const events = await collectEvents(stream);
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "Responses API response incomplete: content_filter", isRetryable: false },
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test.each([
    undefined,
    "future_reason",
  ])("rejects response.incomplete reason %p without emitting done", async (reason) => {
    const stream = makeProviderEventStream();
    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          ...(reason === undefined ? {} : { incomplete_details: { reason } }),
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual(["usage", "error"]);
    const terminalEvent = events.at(-1);
    expect(terminalEvent?.type === "error" ? terminalEvent.error.message : "").toContain(reason ?? "unknown");
  });

  test("preserves reasoning item identity and encrypted content with its plaintext summary", async () => {
    const stream = makeProviderEventStream();
    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield { type: "response.reasoning_summary_text.delta", delta: "private summary" };
      yield {
        type: "response.output_item.done",
        item: {
          id: "rs_1",
          type: "reasoning",
          encrypted_content: "opaque-reasoning",
          summary: [{ type: "summary_text", text: "private summary" }],
        },
      };
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    expect((await stream.result()).message.content).toEqual([
      {
        type: "thinking",
        thinking: "private summary",
        providerState: {
          provider: "openai",
          itemId: "rs_1",
          encryptedContent: "opaque-reasoning",
        },
      },
    ]);
  });

  test("surfaces a top-level error frame as a terminal provider error", async () => {
    const events: ProviderEvent[] = [];
    const stream = { push: (event: ProviderEvent) => events.push(event) } as unknown as EventStream<
      ProviderEvent,
      ProviderResult
    >;
    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield { type: "error", code: "server_error", message: "Upstream exploded" };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { message: "Upstream exploded" } });
  });

  test.each([
    ["context_length_exceeded", "context_overflow", false, "context_window_exceeded"],
    ["rate_limit_exceeded", "rate_limit", true, undefined],
    ["insufficient_quota", "rate_limit", false, "usage_limit_reached"],
    ["server_error", "server_error", true, undefined],
    ["bio_policy", "unknown", false, undefined],
    ["invalid_api_key", "auth", false, "credentials_rejected"],
  ] as const)("classifies streamed provider code %s before its opaque message", async (code, type, retryable, reason) => {
    const events: ProviderEvent[] = [];
    const stream = { push: (event: ProviderEvent) => events.push(event) } as unknown as EventStream<
      ProviderEvent,
      ProviderResult
    >;
    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.failed",
        response: {
          error: { code, message: "opaque provider failure" },
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const errorEvent = events.find(
      (event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error",
    );
    expect(errorEvent?.error).toMatchObject({ errorType: type, isRetryable: retryable, reason });
    expect(toSerializableError(errorEvent?.error).code).toBe(code);
  });

  test("preserves the Responses empty-object fallback for malformed tool arguments", async () => {
    const stream = makeProviderEventStream();

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_1", name: "read" },
      };
      yield {
        type: "response.function_call_arguments.delta",
        delta: "INVALID_JSON",
      };
      yield {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "read",
          arguments: "INVALID_JSON",
        },
      };
      yield {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const events = await collectEvents(stream);
    const toolEnd = events.find(
      (event): event is Extract<ProviderEvent, { type: "tool_call_end" }> => event.type === "tool_call_end",
    );

    expect(toolEnd?.input).toEqual({});
    expect((await stream.result()).message.content).toContainEqual({
      type: "tool_call",
      id: "call_1",
      name: "read",
      input: {},
    });
  });

  test("uses authoritative message completion after text deltas without duplicating text", async () => {
    const stream = makeProviderEventStream();

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield { type: "response.output_text.delta", delta: "draft" };
      yield {
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [{ type: "output_text", text: "authoritative" }],
        },
      };
      yield {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);
    const events = await collectEvents(stream);

    expect(events.filter((event) => event.type === "text_end")).toEqual([{ type: "text_end", text: "authoritative" }]);
    expect((await stream.result()).message.content).toEqual([{ type: "text", text: "authoritative" }]);
  });

  test("does not emit a successful terminal event after abort", async () => {
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield { type: "response.output_text.delta", delta: "partial" };
      controller.abort();
      yield {
        type: "response.completed",
        response: {
          status: "cancelled",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL, controller.signal);

    expect(events.map((event) => event.type)).toEqual(["text_delta"]);
  });

  test("emits retryable error when stream closes before any terminal response event", async () => {
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking only" }],
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);

    expect(events.map((event) => event.type)).toEqual(["thinking_end", "error"]);
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("stream closed before a terminal response event");
    expect(error?.error).toBeInstanceOf(ProviderError);
    if (!(error?.error instanceof ProviderError)) throw new Error("Expected ProviderError");
    expect(error.error.errorType).toBe("network");
    expect(error.error.isRetryable).toBe(true);
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("surfaces response.failed error code via cause for log serialization", async () => {
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.failed",
        response: {
          error: { code: "server_error", message: "Something went wrong" },
          usage: { input_tokens: 9, output_tokens: 2 },
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error).toBeDefined();
    const serialized = toSerializableError(error?.error);
    expect(serialized.code).toBe("server_error");
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
});
