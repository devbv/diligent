// @summary Tests OpenAI SDK stream idle timeouts independently from request-header timeouts
import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIStream } from "../../../../src/llm/provider/openai";
import type { ProviderEvent } from "../../../../src/llm/types";
import { collectEvents, TEST_CONTEXT, TEST_MODEL } from "../../../helpers/chatgpt-stream";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI Responses stream idle timeout", () => {
  test("aborts the SDK stream and emits a retryable network error when events stall", async () => {
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const stream = createOpenAIStream("test-key", "https://openai.test/v1", undefined, {
      streamIdleTimeoutMs: 5,
    });

    const events = await collectEvents(stream(TEST_MODEL, TEST_CONTEXT, {}));
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");

    expect(error?.error).toMatchObject({
      message: "OpenAI stream idle timeout after 5ms",
      errorType: "network",
      isRetryable: true,
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  test("keeps a long stream alive while events continue to arrive", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.enqueue(eventChunk({ type: "response.output_text.delta", delta: "a" })), 6);
          setTimeout(() => controller.enqueue(eventChunk({ type: "response.output_text.delta", delta: "b" })), 14);
          setTimeout(() => {
            controller.enqueue(
              eventChunk({
                type: "response.completed",
                response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 } },
              }),
            );
            controller.close();
          }, 22);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const stream = createOpenAIStream("test-key", "https://openai.test/v1", undefined, {
      streamIdleTimeoutMs: 12,
    });

    const events = await collectEvents(stream(TEST_MODEL, TEST_CONTEXT, {}));

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "a" },
      { type: "text_delta", delta: "b" },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(requestBody.store).toBe(false);
  });
});

function eventChunk(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}
