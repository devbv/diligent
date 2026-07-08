// @summary Tests for OpenAI Responses event handling edge cases like aborts
import { afterEach, describe, expect, test } from "bun:test";
import { toSerializableError } from "../../../src/agent/util/errors";
import type { EventStream } from "../../../src/event-stream";
import { createChatGPTStream } from "../../../src/llm/provider/chatgpt";
import { handleResponsesAPIEvents } from "../../../src/llm/provider/openai-sse";
import { withRetry } from "../../../src/llm/retry";
import type { Model, ProviderEvent, ProviderResult, StreamContext } from "../../../src/llm/types";

const TEST_MODEL: Model = {
  id: "gpt-test",
  provider: "openai",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
};

const TEST_CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

const originalFetch = globalThis.fetch;

function chatGPTSuccessResponse(text = "ok"): Response {
  return new Response(
    [
      `data: {"type":"response.output_text.delta","delta":"${text}"}`,
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function collectEvents(stream: EventStream<ProviderEvent, ProviderResult>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  await stream.result().catch(() => {});
  return events;
}

function createRetriedChatGPTStream(): EventStream<ProviderEvent, ProviderResult> {
  const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }));
  const retried = withRetry(chatgptStream, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
  return retried({ ...TEST_MODEL, id: "chatgpt-5", provider: "chatgpt" }, TEST_CONTEXT, {});
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleResponsesAPIEvents", () => {
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
        response: { status: "cancelled", usage: { input_tokens: 10, output_tokens: 5 } },
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
        item: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking only" }] },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);

    expect(events.map((event) => event.type)).toEqual(["thinking_end", "error"]);
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("stream closed before response.completed");
    expect(error?.error.errorType).toBe("network");
    expect(error?.error.isRetryable).toBe(true);
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
        response: { error: { code: "server_error", message: "Something went wrong" } },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, TEST_MODEL);

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error).toBeDefined();
    const serialized = toSerializableError(error?.error);
    expect(serialized.code).toBe("server_error");
  });
});

describe("createChatGPTStream retry classification", () => {
  test("does not retry HTTP 429 without usage limit body", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return chatGPTSuccessResponse();
    }) as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(1);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.type === "error" ? errorEvent.error.message : "").toContain("429");
  });

  test("retries ChatGPT HTTP 500 and recovers", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: { message: "server had an error" } }), { status: 500 });
      }
      return chatGPTSuccessResponse();
    }) as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("retries transient ChatGPT response.failed before visible output", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(
          [
            'data: {"type":"response.failed","response":{"error":{"message":"ChatGPT is temporarily unavailable. Please try again."}}}',
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return chatGPTSuccessResponse();
    }) as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("retries generic OpenAI 'you can retry your request' response.failed", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(
          [
            'data: {"type":"response.failed","response":{"error":{"message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists."}}}',
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return chatGPTSuccessResponse();
    }) as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("retries ChatGPT stream EOF before response.completed and recovers", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return chatGPTSuccessResponse();
    }) as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("retries ChatGPT stream EOF after visible delta and emits retry signal", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(['data: {"type":"response.output_text.delta","delta":"partial"}', ""].join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return chatGPTSuccessResponse();
    }) as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.some((event) => event.type === "retry")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });
});
