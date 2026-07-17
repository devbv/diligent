// @summary Shared fixtures and cleanup for ChatGPT provider stream tests
import { resetDefaultLogSinkForTests } from "@diligent/logging";
import type { OpenAIOAuthTokens } from "../../src/auth/types";
import { EventStream } from "../../src/event-stream";
import { resolveModel } from "../../src/llm/models";
import { createChatGPTStream } from "../../src/llm/provider/chatgpt";
import { withRetry } from "../../src/llm/retry";
import { createStreamTurnScope } from "../../src/llm/turn-scope";
import type { Model, ProviderEvent, ProviderResult, StreamContext } from "../../src/llm/types";

export const TEST_MODEL: Model = {
  id: "gpt-test",
  provider: "openai",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsThinking: true,
};

export function testTokens(accountId?: string): OpenAIOAuthTokens {
  return {
    access_token: "token",
    refresh_token: "refresh",
    id_token: "id-token",
    expires_at: Date.now() + 60_000,
    ...(accountId ? { account_id: accountId } : {}),
  };
}

export const TEST_CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

const originalFetch = globalThis.fetch;
const originalConsoleDebug = console.debug;
const originalChatGPTWebSocketDebug = process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET;
const originalChatGPTHttpSseDebug = process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE;

type ChatGPTWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

interface FakeChatGPTWebSocketOptions {
  autoOpen?: boolean;
  onSend?: (body: Record<string, unknown>, socket: FakeChatGPTWebSocket) => void;
  sendError?: Error;
}

export class FakeChatGPTWebSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState: number = WebSocket.CONNECTING;
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

export function createWebSocketHarness(
  onSend?: (body: Record<string, unknown>, socket: FakeChatGPTWebSocket) => void,
  options: Omit<FakeChatGPTWebSocketOptions, "onSend"> = {},
): {
  factory: ChatGPTWebSocketFactory;
  requests: Array<{
    url: string;
    headers: Record<string, string>;
    socket: FakeChatGPTWebSocket;
  }>;
} {
  const requests: Array<{
    url: string;
    headers: Record<string, string>;
    socket: FakeChatGPTWebSocket;
  }> = [];
  return {
    requests,
    factory(url, headers) {
      const socket = new FakeChatGPTWebSocket({ ...options, onSend });
      requests.push({ url, headers, socket });
      return socket as unknown as WebSocket;
    },
  };
}

export function completeWebSocketResponse(socket: FakeChatGPTWebSocket, text = "ok"): void {
  queueMicrotask(() => {
    socket.emit({ type: "response.output_text.delta", delta: text });
    socket.emit({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  });
}

export function chatGPTSuccessResponse(text = "ok"): Response {
  return new Response(
    [
      `data: {"type":"response.output_text.delta","delta":"${text}"}`,
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export async function collectEvents(stream: EventStream<ProviderEvent, ProviderResult>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  await stream.result().catch(() => {});
  return events;
}

export function makeProviderEventStream(): EventStream<ProviderEvent, ProviderResult> {
  return new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );
}

export async function collectScopedChatGPTEvents(
  stream: ReturnType<typeof createChatGPTStream>,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderEvent[]> {
  const scope = createStreamTurnScope();
  try {
    return await collectEvents(
      stream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
        turnScope: scope,
        ...options,
      }),
    );
  } finally {
    await scope.dispose();
  }
}

export function createRetriedChatGPTStream(): EventStream<ProviderEvent, ProviderResult> {
  const chatgptStream = createChatGPTStream(() => testTokens());
  const retried = withRetry(chatgptStream, {
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 1,
  });
  return retried({ ...TEST_MODEL, id: "chatgpt-5", provider: "chatgpt" }, TEST_CONTEXT, {});
}

export function restoreChatGPTStreamTestState(): void {
  globalThis.fetch = originalFetch;
  console.debug = originalConsoleDebug;
  resetDefaultLogSinkForTests();
  if (originalChatGPTWebSocketDebug === undefined) {
    delete process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET;
  } else {
    process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET = originalChatGPTWebSocketDebug;
  }
  if (originalChatGPTHttpSseDebug === undefined) {
    delete process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE;
  } else {
    process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE = originalChatGPTHttpSseDebug;
  }
}
