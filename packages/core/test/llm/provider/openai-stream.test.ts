// @summary Tests for OpenAI Responses request construction, usage mapping, and streaming edge cases
import { afterEach, describe, expect, test } from "bun:test";
import { toSerializableError } from "../../../src/agent/util/errors";
import type { EventStream } from "../../../src/event-stream";
import { resolveModel } from "../../../src/llm/models";
import { createChatGPTStream } from "../../../src/llm/provider/chatgpt";
import {
  buildResponsesRequestBody,
  isGpt56Model,
  mapUsage,
  toResponsesReasoningEffort,
} from "../../../src/llm/provider/openai-responses";
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

type ChatGPTWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

class FakeChatGPTWebSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState = WebSocket.CONNECTING;
  closed = false;
  terminated = false;

  constructor(private readonly onSend?: (body: Record<string, unknown>, socket: FakeChatGPTWebSocket) => void) {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    const text = String(data);
    this.sent.push(text);
    this.onSend?.(JSON.parse(text) as Record<string, unknown>, this);
  }

  emit(payload: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  emitClose(code = 1006, reason = "connection closed"): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

function createWebSocketHarness(onSend?: (body: Record<string, unknown>, socket: FakeChatGPTWebSocket) => void): {
  factory: ChatGPTWebSocketFactory;
  requests: Array<{ url: string; headers: Record<string, string>; socket: FakeChatGPTWebSocket }>;
} {
  const requests: Array<{ url: string; headers: Record<string, string>; socket: FakeChatGPTWebSocket }> = [];
  return {
    requests,
    factory(url, headers) {
      const socket = new FakeChatGPTWebSocket(onSend);
      requests.push({ url, headers, socket });
      return socket as unknown as WebSocket;
    },
  };
}

function completeWebSocketResponse(socket: FakeChatGPTWebSocket, text = "ok"): void {
  queueMicrotask(() => {
    socket.emit({ type: "response.output_text.delta", delta: text });
    socket.emit({
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    });
  });
}

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
  test("uses Responses WebSocket + Lite for every ChatGPT GPT-5.6 model", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("GPT-5.6 must not use HTTP");
    }) as typeof fetch;
    const harness = createWebSocketHarness((_body, socket) => completeWebSocketResponse(socket));
    const chatgptStream = createChatGPTStream(
      () => ({ access_token: "token", refresh_token: "refresh", account_id: "acct_1" }),
      { webSocketFactory: harness.factory },
    );

    for (const [modelId, effort] of [
      ["chatgpt-5.6-sol", "xhigh"],
      ["chatgpt-5.6-terra", "max"],
      ["chatgpt-5.6-luna", "medium"],
    ] as const) {
      const events = await collectEvents(chatgptStream(resolveModel(modelId), TEST_CONTEXT, { effort }));
      expect(events.some((event) => event.type === "done")).toBe(true);
    }

    expect(fetchCalled).toBe(false);
    expect(harness.requests.map((request) => request.url)).toEqual([
      "wss://chatgpt.com/backend-api/codex/responses",
      "wss://chatgpt.com/backend-api/codex/responses",
      "wss://chatgpt.com/backend-api/codex/responses",
    ]);
    expect(harness.requests.map((request) => request.headers["x-openai-internal-codex-responses-lite"])).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(harness.requests.map((request) => request.headers.version)).toEqual(["0.144.1", "0.144.1", "0.144.1"]);
    expect(harness.requests.map((request) => request.headers["ChatGPT-Account-ID"])).toEqual([
      "acct_1",
      "acct_1",
      "acct_1",
    ]);

    const requestBodies = harness.requests.map(
      (request) => JSON.parse(request.socket.sent[0] ?? "{}") as Record<string, unknown>,
    );
    expect(requestBodies.map((body) => body.type)).toEqual(["response.create", "response.create", "response.create"]);
    expect(requestBodies.map((body) => body.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(requestBodies.map((body) => (body.reasoning as { effort: string }).effort)).toEqual([
      "xhigh",
      "max",
      "medium",
    ]);
    for (const body of requestBodies) {
      expect(body.instructions).toBeUndefined();
      expect(body.tools).toBeUndefined();
      expect(body.parallel_tool_calls).toBe(false);
      expect((body.reasoning as { context: string }).context).toBe("all_turns");
      expect((body.input as Array<Record<string, unknown>>)[0]).toEqual({
        type: "additional_tools",
        role: "developer",
        tools: [],
      });
    }
  });

  test("moves ChatGPT GPT-5.6 instructions, tools, and compacted history into Lite input items", async () => {
    const harness = createWebSocketHarness((_body, socket) => completeWebSocketResponse(socket));
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      webSocketFactory: harness.factory,
    });
    const context: StreamContext = {
      systemPrompt: [{ label: "base", content: "System instructions" }],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      compactionSummary: { type: "compaction", encrypted_content: "summary" },
      tools: [
        {
          kind: "function",
          name: "read",
          description: "Read a file",
          inputSchema: { properties: { path: { type: "string" } }, required: ["path"] },
        },
        { kind: "provider_builtin", capability: "web" },
      ],
    };

    const events = await collectEvents(chatgptStream(resolveModel("chatgpt-5.6-luna"), context, { effort: "low" }));
    expect(events.some((event) => event.type === "done")).toBe(true);

    const body = JSON.parse(harness.requests[0]?.socket.sent[0] ?? "{}") as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        { type: "web_search" },
      ],
    });
    expect(input[1]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "System instructions" }],
    });
    expect(input[2]).toEqual({ type: "compaction", encrypted_content: "summary" });
    expect(input[3]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
  });

  test("keeps existing ChatGPT models on HTTP/SSE", async () => {
    let webSocketCalled = false;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatGPTSuccessResponse();
    }) as typeof fetch;
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      webSocketFactory() {
        webSocketCalled = true;
        throw new Error("Legacy ChatGPT models must not use WebSocket");
      },
    });

    const events = await collectEvents(chatgptStream(resolveModel("chatgpt-5.5"), TEST_CONTEXT, { effort: "medium" }));

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(webSocketCalled).toBe(false);
    expect(requestBodies[0]?.model).toBe("gpt-5.5");
    expect(requestBodies[0]?.type).toBeUndefined();
  });

  test("surfaces a retryable error when a GPT-5.6 WebSocket closes before completion", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() => socket.emitClose());
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error).toBeInstanceOf(Error);
    expect(error?.error.message).toContain("response.completed");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("maps top-level GPT-5.6 WebSocket errors and terminates on abort", async () => {
    const errorHarness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: "invalid request" },
        }),
      );
    });
    const errorStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      webSocketFactory: errorHarness.factory,
    });
    const errorEvents = await collectEvents(
      errorStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );
    const error = errorEvents.find(
      (event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error",
    );
    expect(error?.error.message).toContain("invalid request");

    const abortHarness = createWebSocketHarness();
    const abortController = new AbortController();
    const abortStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      webSocketFactory: abortHarness.factory,
    })(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
      effort: "medium",
      signal: abortController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    await abortStream.result().catch(() => {});

    expect(abortHarness.requests[0]?.socket.terminated).toBe(true);
  });

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

describe("GPT-5.6 Responses API compatibility", () => {
  test("matches only the official GPT-5.6 model IDs and family alias", () => {
    expect(isGpt56Model("gpt-5.6")).toBe(true);
    expect(isGpt56Model("gpt-5.6-sol")).toBe(true);
    expect(isGpt56Model("gpt-5.6-terra")).toBe(true);
    expect(isGpt56Model("gpt-5.6-luna")).toBe(true);
    expect(isGpt56Model("gpt-5.6-unknown")).toBe(false);
  });

  test("keeps xhigh and max distinct for GPT-5.6", () => {
    expect(toResponsesReasoningEffort("xhigh", "gpt-5.6-sol")).toBe("xhigh");
    expect(toResponsesReasoningEffort("max", "gpt-5.6-sol")).toBe("max");
    expect(toResponsesReasoningEffort("max", "gpt-5.6-terra")).toBe("max");
    expect(toResponsesReasoningEffort("max", "gpt-5.6-luna")).toBe("max");
  });

  test("preserves the legacy OpenAI max to xhigh mapping", () => {
    expect(toResponsesReasoningEffort("max", "gpt-5.5")).toBe("xhigh");
    expect(toResponsesReasoningEffort("max", "gpt-5.4")).toBe("xhigh");
  });

  test("uses GPT-5.6 reasoning and prompt cache request fields", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.6-sol",
      messages: [],
      useReasoning: true,
      effort: "max",
      enablePromptCaching: true,
    });

    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(body.prompt_cache_options).toEqual({ ttl: "30m" });
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  test("keeps the legacy prompt cache retention field on GPT-5.5", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.5",
      messages: [],
      useReasoning: true,
      effort: "max",
      enablePromptCaching: true,
    });

    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.prompt_cache_retention).toBe("24h");
    expect(body.prompt_cache_options).toBeUndefined();
  });

  test("separates uncached input, cache reads, and cache writes", () => {
    expect(
      mapUsage({
        input_tokens: 1_000,
        output_tokens: 80,
        input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
      }),
    ).toEqual({
      inputTokens: 500,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
    });
  });

  test("never reports negative uncached input for inconsistent upstream usage", () => {
    expect(
      mapUsage({
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 40 },
      }).inputTokens,
    ).toBe(0);
  });
});
