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

  test("emits retryable error when stream closes before response.completed", async () => {
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
    expect(error?.error.message).toBe("stream closed before response.completed");
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
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error).toBeDefined();
    const serialized = toSerializableError(error?.error);
    expect(serialized.code).toBe("server_error");
  });
});
