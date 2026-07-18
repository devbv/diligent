// @summary Tests for ChatGPT HTTP/SSE transport behavior
import { afterEach, describe, expect, test } from "bun:test";
import { type LogRecord, setDefaultLogSink } from "@diligent/logging";
import { resolveModel } from "../../../../src/llm/models";
import { createChatGPTStream, summarizeChatGPTWebSocketPayload } from "../../../../src/llm/provider/chatgpt";
import type { ProviderEvent } from "../../../../src/llm/types";
import {
  chatGPTSuccessResponse,
  collectEvents,
  restoreChatGPTStreamTestState,
  TEST_CONTEXT,
  testTokens,
} from "../../../helpers/chatgpt-stream";

afterEach(restoreChatGPTStreamTestState);

describe("ChatGPT HTTP transport", () => {
  test("summarizes ChatGPT WebSocket payloads without logging content", () => {
    expect(
      summarizeChatGPTWebSocketPayload({
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [{ type: "message" }, { type: "message" }],
      }),
    ).toBe("response.create model=gpt-5.6-luna inputItems=2");
    expect(
      summarizeChatGPTWebSocketPayload({
        type: "response.output_text.delta",
        delta: "sensitive text",
      }),
    ).toBe("response.output_text.delta deltaChars=14");
    expect(
      summarizeChatGPTWebSocketPayload({
        type: "error",
        status_code: 429,
        error: { code: "rate_limit", message: "try again" },
      }),
    ).toBe("error status=429 code=rate_limit message=try again");
  });

  test("uses HTTP/SSE + Lite by default for a compatible ChatGPT model", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;
    let webSocketCalled = false;
    const chatgptStream = createChatGPTStream(() => testTokens("acct_1"), {
      webSocketFactory() {
        webSocketCalled = true;
        throw new Error("GPT-5.6 must use HTTP by default");
      },
    });

    const events = await collectEvents(
      chatgptStream(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }), TEST_CONTEXT, {
        effort: "medium",
        sessionId: "session_1",
      }),
    );
    expect(events.some((event) => event.type === "done")).toBe(true);

    expect(webSocketCalled).toBe(false);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("Expected one ChatGPT HTTP request");
    expect(request.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(request.headers.get("version")).toBe("0.144.1");
    expect(request.headers.get("ChatGPT-Account-ID")).toBe("acct_1");
    expect(request.headers.get("session-id")).toBe("session_1");
    expect(request.headers.get("session_id")).toBeNull();

    const body = request.body;
    expect(body.type).toBeUndefined();
    expect(body.model).toBe("gpt-5.6-luna");
    expect((body.reasoning as { effort: string }).effort).toBe("medium");
    expect(body.instructions).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);
    expect((body.reasoning as { context: string }).context).toBe("all_turns");
    expect((body.input as Array<Record<string, unknown>>)[0]).toEqual({
      type: "additional_tools",
      role: "developer",
      tools: [],
    });
  });

  test("preserves raw HTTP/SSE incomplete terminal classification", async () => {
    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":8}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;

    const events = await collectEvents(
      createChatGPTStream(() => testTokens())(
        resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }),
        TEST_CONTEXT,
        {
          effort: "medium",
        },
      ),
    );

    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("surfaces a content-filter incomplete response as an error while preserving usage", async () => {
    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;

    const events = await collectEvents(
      createChatGPTStream(() => testTokens())(
        resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }),
        TEST_CONTEXT,
        {
          effort: "medium",
        },
      ),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "usage", "error"]);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { isRetryable: false } });
  });

  test("logs ChatGPT HTTP/SSE payloads with byte sizes and content-safe summaries", async () => {
    process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE = "1";
    const logs: LogRecord[] = [];
    setDefaultLogSink((record) => {
      logs.push(record);
    });
    let requestBytes = 0;
    const completedPayload =
      '{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}';
    const receivedBytes = new TextEncoder().encode(completedPayload).byteLength;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBytes = new TextEncoder().encode(String(init?.body)).byteLength;
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"sensitive text"}',
          "",
          `data: ${completedPayload}`,
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const chatgptStream = createChatGPTStream(() => testTokens());

    const events = await collectEvents(
      chatgptStream(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }), TEST_CONTEXT, {
        effort: "medium",
        sessionId: "session-http-debug",
      }),
    );

    const transportLogs = logs.filter((record) => record.scope === "llm:chatgpt-sse");
    expect(transportLogs.every((record) => record.sessionId === "session-http-debug")).toBe(true);
    const outgoingLogs = transportLogs.map((record) => record.message).filter((line) => line.includes("->"));
    expect(outgoingLogs).toHaveLength(2);
    expect(outgoingLogs[0]).toContain(`state=sending bytes=${requestBytes}`);
    expect(outgoingLogs[1]).toContain(`state=sent bytes=${requestBytes} status=200`);
    expect(outgoingLogs.every((line) => line.includes("response.create model=gpt-5.6-luna"))).toBe(true);
    expect(outgoingLogs.every((line) => !line.includes("sensitive text"))).toBe(true);
    expect(
      transportLogs.some(
        (record) =>
          record.message.includes("<-") &&
          record.message.includes("response.output_text.delta deltaChars=14") &&
          !record.message.includes("sensitive text"),
      ),
    ).toBe(true);
    expect(
      transportLogs.some(
        (record) =>
          record.message.includes(`<- bytes=${receivedBytes}`) &&
          record.message.includes("response.completed status=completed in=3 out=2"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("times out while waiting for ChatGPT HTTP response headers", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const fallback = setTimeout(() => reject(new Error("fetch was not aborted")), 50);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback);
            reject(signal.reason);
          },
          { once: true },
        );
      })) as unknown as typeof fetch;
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      httpHeaderTimeoutMs: 5,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT HTTP response header timeout after 5ms");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("clears the ChatGPT HTTP header timeout before streaming the SSE body", async () => {
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n',
              ),
            );
            controller.close();
          }, 15);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      httpHeaderTimeoutMs: 5,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("times out a stalled ChatGPT SSE body after response headers", async () => {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      httpHeaderTimeoutMs: 50,
      httpStreamIdleTimeoutMs: 5,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-luna" }), TEST_CONTEXT, { effort: "medium" }),
    );
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");

    expect(error?.error).toMatchObject({
      message: "ChatGPT HTTP stream idle timeout after 5ms",
      errorType: "network",
      isRetryable: true,
    });
    expect(cancelled).toBe(true);
  });
});
