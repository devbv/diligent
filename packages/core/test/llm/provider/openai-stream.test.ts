// @summary Tests for OpenAI Responses request construction, usage mapping, and streaming edge cases
import { afterEach, describe, expect, test } from "bun:test";
import { toSerializableError } from "../../../src/agent/util/errors";
import type { EventStream } from "../../../src/event-stream";
import { resolveModel } from "../../../src/llm/models";
import { createChatGPTStream, summarizeChatGPTWebSocketPayload } from "../../../src/llm/provider/chatgpt";
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
const originalConsoleDebug = console.debug;
const originalChatGPTWebSocketDebug = process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET;

type ChatGPTWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

interface FakeChatGPTWebSocketOptions {
  autoOpen?: boolean;
  onSend?: (body: Record<string, unknown>, socket: FakeChatGPTWebSocket) => void;
  sendError?: Error;
}

class FakeChatGPTWebSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState = WebSocket.CONNECTING;
  closed = false;
  terminated = false;

  constructor(private readonly options: FakeChatGPTWebSocketOptions = {}) {
    super();
    if (options.autoOpen ?? true) {
      queueMicrotask(() => this.open());
    }
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.options.sendError) throw this.options.sendError;
    const text = String(data);
    this.sent.push(text);
    this.options.onSend?.(JSON.parse(text) as Record<string, unknown>, this);
  }

  emit(payload: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  emitRaw(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
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

function createWebSocketHarness(
  onSend?: (body: Record<string, unknown>, socket: FakeChatGPTWebSocket) => void,
  options: Omit<FakeChatGPTWebSocketOptions, "onSend"> = {},
): {
  factory: ChatGPTWebSocketFactory;
  requests: Array<{ url: string; headers: Record<string, string>; socket: FakeChatGPTWebSocket }>;
} {
  const requests: Array<{ url: string; headers: Record<string, string>; socket: FakeChatGPTWebSocket }> = [];
  return {
    requests,
    factory(url, headers) {
      const socket = new FakeChatGPTWebSocket({ ...options, onSend });
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
  console.debug = originalConsoleDebug;
  if (originalChatGPTWebSocketDebug === undefined) {
    delete process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET;
  } else {
    process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET = originalChatGPTWebSocketDebug;
  }
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
  test("summarizes ChatGPT WebSocket payloads without logging content", () => {
    expect(
      summarizeChatGPTWebSocketPayload({
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [{ type: "message" }, { type: "message" }],
      }),
    ).toBe("response.create model=gpt-5.6-luna inputItems=2");
    expect(summarizeChatGPTWebSocketPayload({ type: "response.output_text.delta", delta: "sensitive text" })).toBe(
      "response.output_text.delta deltaChars=14",
    );
    expect(
      summarizeChatGPTWebSocketPayload({
        type: "error",
        status_code: 429,
        error: { code: "rate_limit", message: "try again" },
      }),
    ).toBe("error status=429 code=rate_limit message=try again");
  });

  test("uses HTTP/SSE + Lite for every ChatGPT GPT-5.6 model by default", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return chatGPTSuccessResponse();
    }) as typeof fetch;
    let webSocketCalled = false;
    const chatgptStream = createChatGPTStream(
      () => ({ access_token: "token", refresh_token: "refresh", account_id: "acct_1" }),
      {
        webSocketFactory() {
          webSocketCalled = true;
          throw new Error("GPT-5.6 must use HTTP by default");
        },
      },
    );

    for (const [modelId, effort] of [
      ["chatgpt-5.6-sol", "xhigh"],
      ["chatgpt-5.6-terra", "max"],
      ["chatgpt-5.6-luna", "medium"],
    ] as const) {
      const events = await collectEvents(
        chatgptStream(resolveModel(modelId), TEST_CONTEXT, { effort, sessionId: "session_1" }),
      );
      expect(events.some((event) => event.type === "done")).toBe(true);
    }

    expect(webSocketCalled).toBe(false);
    expect(requests.map((request) => request.headers.get("x-openai-internal-codex-responses-lite"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(requests.map((request) => request.headers.get("version"))).toEqual(["0.144.1", "0.144.1", "0.144.1"]);
    expect(requests.map((request) => request.headers.get("ChatGPT-Account-ID"))).toEqual([
      "acct_1",
      "acct_1",
      "acct_1",
    ]);
    expect(requests.map((request) => request.headers.get("session-id"))).toEqual([
      "session_1",
      "session_1",
      "session_1",
    ]);
    expect(requests.map((request) => request.headers.get("session_id"))).toEqual([null, null, null]);

    const requestBodies = requests.map((request) => request.body);
    expect(requestBodies.map((body) => body.type)).toEqual([undefined, undefined, undefined]);
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

  test("can explicitly use WebSocket + Lite for ChatGPT GPT-5.6", async () => {
    const harness = createWebSocketHarness((_body, socket) => completeWebSocketResponse(socket));
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(harness.requests[0]?.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
  });

  test("moves ChatGPT GPT-5.6 instructions, tools, and compacted history into Lite HTTP input items", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatGPTSuccessResponse();
    }) as typeof fetch;
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }));
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

    const input = requestBody.input as Array<Record<string, unknown>>;
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
      useWebSocketForGpt56: true,
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

  test("times out when a GPT-5.6 WebSocket never opens", async () => {
    const harness = createWebSocketHarness(undefined, { autoOpen: false });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 1,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT WebSocket idle timeout waiting for connection");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
    expect(harness.requests[0]?.socket.terminated).toBe(true);
  });

  test("times out after GPT-5.6 WebSocket open while waiting for response", async () => {
    const harness = createWebSocketHarness();
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 1,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(harness.requests[0]?.socket.sent.length).toBe(1);
    expect(error?.error.message).toBe("ChatGPT WebSocket idle timeout waiting for response");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("maps GPT-5.6 WebSocket send throws to retryable network errors", async () => {
    const harness = createWebSocketHarness(undefined, { sendError: new Error("send failed") });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 100,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT WebSocket send failed: send failed");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("preserves GPT-5.6 WebSocket close code and reason before completion", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() => socket.emitClose(1011, "upstream unavailable"));
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain(
      "ChatGPT WebSocket closed before response.completed (1011: upstream unavailable)",
    );
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("processes a delayed terminal WebSocket message before close", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      const payload = JSON.stringify({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      });
      const delayedBlob = new Blob([payload]);
      Object.defineProperty(delayedBlob, "text", {
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return payload;
        },
      });

      queueMicrotask(() => {
        socket.emitRaw(delayedBlob);
        socket.emitClose(1000, "normal closure");
      });
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("logs ChatGPT WebSocket frames immediately with byte sizes and summaries", async () => {
    process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET = "1";
    const logs: string[] = [];
    console.debug = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let receiveLogSeenBeforeDecode = false;
    let receivedBytes = 0;
    const harness = createWebSocketHarness((_body, socket) => {
      const payload = JSON.stringify({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
      });
      const delayedBlob = new Blob([payload]);
      Object.defineProperty(delayedBlob, "text", {
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return payload;
        },
      });

      receivedBytes = delayedBlob.size;
      socket.emitRaw(delayedBlob);
      receiveLogSeenBeforeDecode = logs.some((line) => line.includes(`<- bytes=${receivedBytes} pending_decode`));
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    expect(receiveLogSeenBeforeDecode).toBe(true);
    expect(logs.some((line) => line.includes("[llm:chatgpt-ws] -> bytes=") && line.includes("response.create"))).toBe(
      true,
    );
    expect(
      logs.some(
        (line) =>
          line.includes(`[llm:chatgpt-ws] <- bytes=${receivedBytes}`) &&
          line.includes("decoded response.completed status=completed in=3 out=2"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
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
      useWebSocketForGpt56: true,
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
      useWebSocketForGpt56: true,
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

  test("maps GPT-5.6 WebSocket usage-limit errors as non-retryable non-network", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status: 429,
          error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("AI usage limit reached. Please try again later or upgrade your plan.");
    expect((error?.error as { errorType?: string }).errorType).not.toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("maps GPT-5.6 WebSocket status_code alias as rate limit", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status_code: 429,
          error: { message: "rate limited" },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain("ChatGPT API error (429): rate limited");
    expect((error?.error as { errorType?: string }).errorType).toBe("rate_limit");
    expect((error?.error as { statusCode?: number }).statusCode).toBe(429);
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("maps GPT-5.6 WebSocket connection-limit code as retryable", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status: 400,
          error: { code: "websocket_connection_limit_reached", message: "Too many WebSocket connections" },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => ({ access_token: "token", refresh_token: "refresh" }), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, { effort: "medium" }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain("websocket_connection_limit_reached");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
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
