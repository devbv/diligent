// @summary Tests for ChatGPT retry and provider error classification
import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../../../../src/llm/types";
import {
  chatGPTSuccessResponse,
  collectEvents,
  createRetriedChatGPTStream,
  restoreChatGPTStreamTestState,
} from "../../../helpers/chatgpt-stream";

afterEach(restoreChatGPTStreamTestState);

describe("ChatGPT retry classification", () => {
  test("retries a coded transient rate limit even when the message is opaque", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
          status: 429,
        });
      }
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("does not retry HTTP 429 without usage limit body", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(1);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.type === "error" ? errorEvent.error.message : "").toContain("429");
  });

  test("preserves HTTP usage-limit diagnostics with a stable reason", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "opaque quota failure",
          },
        }),
        { status: 429 },
      )) as unknown as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");

    expect(error?.error.message).toContain("opaque quota failure");
    expect(error?.error.message).not.toContain("upgrade your plan");
    expect((error?.error as { errorType?: string }).errorType).toBe("rate_limit");
    expect((error?.error as { reason?: string }).reason).toBe("usage_limit_reached");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("retries ChatGPT HTTP 500 and recovers", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: { message: "server had an error" } }), { status: 500 });
      }
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

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
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

    const events = await collectEvents(createRetriedChatGPTStream());

    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.some((event) => event.type === "retry")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });
});
