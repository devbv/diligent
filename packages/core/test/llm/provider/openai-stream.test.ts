// @summary Tests for OpenAI Responses event handling edge cases like aborts
import { afterEach, describe, expect, test } from "bun:test";
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

    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }));
    const retried = withRetry(chatgptStream, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const stream = retried({ ...TEST_MODEL, id: "chatgpt-5", provider: "chatgpt" }, TEST_CONTEXT, {});
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

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

    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }));
    const retried = withRetry(chatgptStream, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const stream = retried({ ...TEST_MODEL, id: "chatgpt-5", provider: "chatgpt" }, TEST_CONTEXT, {});
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

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

    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }));
    const retried = withRetry(chatgptStream, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const stream = retried({ ...TEST_MODEL, id: "chatgpt-5", provider: "chatgpt" }, TEST_CONTEXT, {});
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});
