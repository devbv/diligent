// @summary ChatGPT subscription stream — HTTP/SSE for legacy models and WebSocket Responses Lite for GPT-5.6
import { arch, platform, release } from "node:os";
import { createLogger } from "@diligent/logging";
import type { OpenAIOAuthTokens } from "../../auth/types";
import { EventStream } from "../../event-stream";
import { isNetworkError } from "../errors";
import { classifyProviderHttpError } from "../provider-errors";
import { flattenSections } from "../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../types";
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "../types";
import { type ChatGPTWebSocketSession, createChatGPTWebSocketSession } from "./chatgpt-websocket-session";
import type { NativeCompactFn } from "./native-compaction";
import {
  buildResponsesRequestBody,
  isGpt56Model,
  toResponseInputItems,
  toResponsesLiteRequestBody,
} from "./openai-responses";
import {
  describeCompactionPayload,
  extractCompactionSummary,
  extractCompactionSummaryItem,
  isTransientOpenAIErrorMessage,
} from "./openai-shared";
import { handleResponsesAPIEvents } from "./openai-sse";

const webSocketLogger = createLogger({ scope: "llm:chatgpt-ws" });
const httpSseLogger = createLogger({ scope: "llm:chatgpt-sse" });

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_CODEX_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CHATGPT_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses/compact";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const CHATGPT_SESSION_HEADER = "session-id";
const CHATGPT_TURN_STATE_HEADER = "x-codex-turn-state";
const CHATGPT_JSON_CONTENT_TYPE = "application/json";
// Pinned to the Codex client version used to verify the GPT-5.6 transport contract.
const CHATGPT_CODEX_CLIENT_VERSION = "0.144.1";
const CHATGPT_WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
const CHATGPT_HTTP_HEADER_TIMEOUT_MS = 15_000;
const USER_AGENT = `diligent (${platform()} ${release()}; ${arch()})`;

export interface ChatGPTStreamOptions {
  useWebSocketForGpt56?: boolean;
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  webSocketIdleTimeoutMs?: number;
  /** Maximum wait for HTTP response headers. Does not limit SSE body streaming. */
  httpHeaderTimeoutMs?: number;
}

type ChatGPTTransportState = {
  websocketDisabled: boolean;
  consecutiveTransportFailures: number;
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<QueueWaiter<T>> = [];
  private done = false;
  private failure?: Error;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.done) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function createDefaultWebSocket(url: string, headers: Record<string, string>): WebSocket {
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new BunWebSocket(url, { headers });
}

async function webSocketMessageToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

function webSocketMessageToImmediateString(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return undefined;
}

function webSocketMessageByteLength(data: unknown): number | undefined {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

function truncateWebSocketLogValue(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

export function summarizeChatGPTWebSocketPayload(payload: Record<string, unknown>): string {
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  if (type === "response.create") {
    const model = typeof payload.model === "string" ? payload.model : undefined;
    const inputItems = Array.isArray(payload.input) ? payload.input.length : undefined;
    return [type, model && `model=${model}`, inputItems !== undefined && `inputItems=${inputItems}`]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof payload.delta === "string") return `${type} deltaChars=${payload.delta.length}`;

  if (type === "response.completed" || type === "response.failed") {
    const response =
      payload.response && typeof payload.response === "object"
        ? (payload.response as Record<string, unknown>)
        : undefined;
    const status = typeof response?.status === "string" ? response.status : undefined;
    const usage =
      response?.usage && typeof response.usage === "object" ? (response.usage as Record<string, unknown>) : undefined;
    const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
    const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined;
    return [
      type,
      status && `status=${status}`,
      inputTokens !== undefined && `in=${inputTokens}`,
      outputTokens !== undefined && `out=${outputTokens}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (type === "error") {
    const rawError = payload.error;
    const error = rawError && typeof rawError === "object" ? (rawError as Record<string, unknown>) : undefined;
    const status =
      typeof payload.status === "number"
        ? payload.status
        : typeof payload.status_code === "number"
          ? payload.status_code
          : undefined;
    const code = typeof error?.code === "string" ? error.code : undefined;
    const errorType = typeof error?.type === "string" ? error.type : undefined;
    const message =
      (typeof error?.message === "string" && error.message) || (typeof rawError === "string" && rawError) || undefined;
    return [
      type,
      status !== undefined && `status=${status}`,
      code && `code=${code}`,
      errorType && `errorType=${errorType}`,
      message && `message=${truncateWebSocketLogValue(message)}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
  const itemType = typeof item?.type === "string" ? item.type : undefined;
  return itemType ? `${type} item=${itemType}` : type;
}

function debugChatGPTWebSocket(direction: "->" | "<-", byteLength: number | undefined, summary: string): void {
  if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET !== "1") return;
  webSocketLogger.debug("websocket_payload", {
    message: `ChatGPT WebSocket: [llm:chatgpt-ws] ${direction} bytes=${byteLength ?? "unknown"} ${summary}`,
    fields: { direction, ...(byteLength !== undefined && { byteLength }), summary },
  });
}

function debugChatGPTHttpSse(direction: "->" | "<-", byteLength: number, summary: string, sessionId?: string): void {
  if (process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE !== "1") return;
  httpSseLogger.debug("sse_payload", {
    message: `ChatGPT HTTP/SSE: [llm:chatgpt-sse] ${direction} bytes=${byteLength} ${summary}`,
    sessionId,
    fields: { direction, byteLength, summary },
  });
}

function debugChatGPTHttpRequest(
  state: "sending" | "sent",
  byteLength: number,
  summary: string,
  context?: { status?: number; sessionId?: string },
): void {
  if (process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE !== "1") return;
  const status = context?.status;
  httpSseLogger.debug("http_request", {
    message: `ChatGPT HTTP/SSE: [llm:chatgpt-sse] -> state=${state} bytes=${byteLength}${status !== undefined ? ` status=${status}` : ""} ${summary}`,
    sessionId: context?.sessionId,
    fields: { direction: "->", state, byteLength, ...(status !== undefined && { status }), summary },
  });
}

function toChatGPTWebSocketError(payload: Record<string, unknown>): ProviderError {
  const status =
    typeof payload.status === "number"
      ? payload.status
      : typeof payload.status_code === "number"
        ? payload.status_code
        : undefined;
  const rawError = payload.error;
  const error = rawError && typeof rawError === "object" ? (rawError as Record<string, unknown>) : undefined;
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof rawError === "string" && rawError) ||
    "ChatGPT WebSocket request failed";
  const errorType = typeof error?.type === "string" ? error.type : undefined;
  const errorCode = typeof error?.code === "string" ? error.code : undefined;
  const normalizedMessage = message.toLowerCase();
  const isUsageLimit =
    errorType?.includes("usage_limit") === true ||
    errorCode?.includes("usage_limit") === true ||
    message.includes("usage_limit_reached") ||
    normalizedMessage.includes("usage limit");
  const isConnectionLimit = errorCode === "websocket_connection_limit_reached";
  const details = [errorCode, errorType, message].filter((value): value is string => Boolean(value)).join(" | ");

  return classifyChatGPTHttpError({
    message: `ChatGPT API error${status ? ` (${status})` : ""}: ${details || message}`,
    status,
    isUsageLimit,
    isConnectionLimit,
  });
}

function classifyChatGPTHttpError(input: {
  message: string;
  status: number | undefined;
  isUsageLimit?: boolean;
  isConnectionLimit?: boolean;
  cause?: Error;
}): ProviderError {
  if (input.isUsageLimit) {
    return new ProviderError(input.message, {
      errorType: ProviderErrorType.RateLimit,
      isRetryable: false,
      statusCode: input.status,
      cause: input.cause,
      reason: ProviderErrorReason.UsageLimitReached,
    });
  }

  const httpError = classifyProviderHttpError({
    message: input.message,
    status: input.status,
    cause: input.cause,
  });
  if (httpError) return httpError;

  const isRetryable = input.isConnectionLimit === true || isTransientOpenAIErrorMessage(input.message);
  return new ProviderError(input.message, {
    errorType: ProviderErrorType.Unknown,
    isRetryable,
    statusCode: input.status,
    cause: input.cause,
  });
}

function createChatGPTWebSocketEvents(input: {
  headers: Record<string, string>;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  webSocketFactory: (url: string, headers: Record<string, string>) => WebSocket;
  idleTimeoutMs?: number;
}): { opened: Promise<void>; events: AsyncIterable<Record<string, unknown>> } {
  const queue = new AsyncEventQueue<Record<string, unknown>>();
  const socket = input.webSocketFactory(CHATGPT_CODEX_WEBSOCKET_URL, input.headers);
  const idleTimeoutMs = input.idleTimeoutMs ?? CHATGPT_WEBSOCKET_IDLE_TIMEOUT_MS;
  let opened = false;
  let settled = false;
  let terminalSeen = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingMessageCount = 0;
  let messageWork = Promise.resolve();
  let resolveOpened!: () => void;
  let rejectOpened!: (error: Error) => void;
  const openedPromise = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });

  const cleanup = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    socket.removeEventListener("open", handleOpen);
    socket.removeEventListener("message", handleMessage);
    socket.removeEventListener("error", handleError);
    socket.removeEventListener("close", handleClose);
    input.signal?.removeEventListener("abort", handleAbort);
  };

  const terminate = () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const terminatingSocket = socket as WebSocket & { terminate?: () => void };
    if (typeof terminatingSocket.terminate === "function") {
      terminatingSocket.terminate();
    } else {
      socket.close();
    }
  };

  const resetIdleTimeout = (message: string) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1") {
        webSocketLogger.debug("websocket_timeout", {
          message: `[llm:chatgpt-ws] state=timeout pendingDecode=${pendingMessageCount} message=${message}`,
          fields: { state: "timeout", pendingDecode: pendingMessageCount },
        });
      }
      fail(new ProviderError(message, ProviderErrorType.Network, true));
    }, idleTimeoutMs);
  };

  const fail = (error: Error) => {
    if (!settled) {
      settled = true;
      rejectOpened(error);
    }
    queue.fail(error);
    cleanup();
    terminate();
  };

  function handleOpen(): void {
    opened = true;
    if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1") {
      webSocketLogger.debug("websocket_open", {
        message: "[llm:chatgpt-ws] state=open",
        fields: { state: "open" },
      });
    }
    resetIdleTimeout("ChatGPT WebSocket idle timeout sending request");
    try {
      const requestText = JSON.stringify(input.request);
      if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1") {
        debugChatGPTWebSocket(
          "->",
          new TextEncoder().encode(requestText).byteLength,
          summarizeChatGPTWebSocketPayload(input.request),
        );
      }
      socket.send(requestText);
      settled = true;
      resolveOpened();
      resetIdleTimeout("ChatGPT WebSocket idle timeout waiting for response");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(new ProviderError(`ChatGPT WebSocket send failed: ${message}`, ProviderErrorType.Network, true));
    }
  }

  function handleMessage(event: MessageEvent): void {
    pendingMessageCount++;
    const debugEnabled = process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1";
    const byteLength = debugEnabled ? webSocketMessageByteLength(event.data) : undefined;
    const immediateText = debugEnabled ? webSocketMessageToImmediateString(event.data) : undefined;
    if (debugEnabled) {
      if (immediateText !== undefined) {
        try {
          const payload = JSON.parse(immediateText) as Record<string, unknown>;
          debugChatGPTWebSocket("<-", byteLength, summarizeChatGPTWebSocketPayload(payload));
        } catch {
          debugChatGPTWebSocket("<-", byteLength, "invalid_json");
        }
      } else {
        debugChatGPTWebSocket("<-", byteLength, "pending_decode");
      }
    }
    messageWork = messageWork
      .then(async () => {
        const text = await webSocketMessageToString(event.data);
        const payload = JSON.parse(text) as Record<string, unknown>;
        if (debugEnabled && immediateText === undefined) {
          debugChatGPTWebSocket("<-", byteLength, `decoded ${summarizeChatGPTWebSocketPayload(payload)}`);
        }
        resetIdleTimeout("ChatGPT WebSocket idle timeout waiting for response");
        if (payload.type === "error") {
          terminalSeen = true;
          fail(toChatGPTWebSocketError(payload));
          return;
        }

        queue.push(payload);
        if (payload.type === "response.completed" || payload.type === "response.failed") {
          terminalSeen = true;
          queue.end();
          cleanup();
          if (socket.readyState !== WebSocket.CLOSED) socket.close(1000);
        }
      })
      .finally(() => {
        pendingMessageCount--;
      })
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  }

  function handleError(): void {
    if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1") {
      webSocketLogger.debug("websocket_error", {
        message: `[llm:chatgpt-ws] state=error opened=${opened} pendingDecode=${pendingMessageCount}`,
        fields: { state: "error", opened, pendingDecode: pendingMessageCount },
      });
    }
    fail(new ProviderError("ChatGPT WebSocket connection failed", ProviderErrorType.Network, true));
  }

  function finalizeClose(code: number, reason: string): void {
    if (!opened) {
      fail(
        new ProviderError(
          `ChatGPT WebSocket connection closed before opening (${code}${reason ? `: ${reason}` : ""})`,
          ProviderErrorType.Network,
          true,
        ),
      );
      return;
    }
    if (!terminalSeen) {
      fail(
        new ProviderError(
          `ChatGPT WebSocket closed before response.completed (${code}${reason ? `: ${reason}` : ""})`,
          ProviderErrorType.Network,
          true,
        ),
      );
      return;
    }
    if (!settled) {
      settled = true;
      resolveOpened();
    }
    queue.end();
    cleanup();
  }

  function handleClose(event: CloseEvent): void {
    const code = event.code;
    const reason = event.reason;
    if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1") {
      webSocketLogger.debug("websocket_close", {
        message: `[llm:chatgpt-ws] state=close code=${code} reason=${truncateWebSocketLogValue(reason || "none")} pendingDecode=${pendingMessageCount}`,
        fields: { state: "close", code, reason: reason || "none", pendingDecode: pendingMessageCount },
      });
    }
    messageWork = messageWork
      .then(() => finalizeClose(code, reason))
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  }

  function handleAbort(): void {
    if (!settled) {
      settled = true;
      rejectOpened(new ProviderError("Aborted", ProviderErrorType.Unknown, false));
    }
    queue.end();
    cleanup();
    terminate();
  }

  socket.addEventListener("open", handleOpen);
  socket.addEventListener("message", handleMessage);
  socket.addEventListener("error", handleError);
  socket.addEventListener("close", handleClose);
  input.signal?.addEventListener("abort", handleAbort, { once: true });
  resetIdleTimeout("ChatGPT WebSocket idle timeout waiting for connection");
  if (input.signal?.aborted) handleAbort();

  return { opened: openedPromise, events: queue };
}

function resolveChatGPTModelId(modelId: string): string {
  return modelId.startsWith("chatgpt-") ? `gpt-${modelId.slice("chatgpt-".length)}` : modelId;
}

function useChatGPTWebSocketTransportFailure(
  error: unknown,
  providerOptions: ChatGPTStreamOptions,
  model: Model,
): boolean {
  if (providerOptions.useWebSocketForGpt56 !== true || !isGpt56Model(resolveChatGPTModelId(model.id))) return false;
  return error instanceof ProviderError && error.errorType === ProviderErrorType.Network;
}

/**
 * Create a StreamFunction for ChatGPT subscription (OAuth).
 *
 * Bypasses the OpenAI Node SDK entirely. Models use raw HTTP/SSE by default,
 * while GPT-5.6 can opt into the ChatGPT Codex WebSocket Responses Lite transport.
 *
 * ChatGPT subscriber endpoint limitations (store: false enforced):
 * - store: true → 400 "Store must be set to false"
 * - previous_response_id → 400 (WebSocket-only, per codex-rs)
 * - item_reference → requires store: true → impossible
 * Only prompt_cache_key is accepted for server-side prefix caching.
 *
 * @param getTokens - Called per-request to get the current (possibly refreshed) tokens
 */
export function createChatGPTStream(
  getTokens: () => OpenAIOAuthTokens,
  providerOptions: ChatGPTStreamOptions = {},
): StreamFunction {
  const transportState: ChatGPTTransportState = { websocketDisabled: false, consecutiveTransportFailures: 0 };
  const turnSessionKey = Symbol("chatgpt-websocket-turn-session");
  return (model: Model, context: StreamContext, options: StreamOptions): EventStream<ProviderEvent, ProviderResult> => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    if (options.signal) stream.attachSignal(options.signal);

    (async () => {
      try {
        if (options.signal?.aborted) return;
        const resolveHeaders = async (): Promise<Record<string, string>> => {
          const tokens = getTokens();
          const headers: Record<string, string> = {
            Authorization: `Bearer ${tokens.access_token}`,
            "User-Agent": USER_AGENT,
            originator: "diligent",
            version: CHATGPT_CODEX_CLIENT_VERSION,
          };
          if (tokens.account_id) headers["ChatGPT-Account-ID"] = tokens.account_id;
          if (options.sessionId) headers[CHATGPT_SESSION_HEADER] = options.sessionId;
          if (options.turnStateRef?.value !== undefined)
            headers[CHATGPT_TURN_STATE_HEADER] = options.turnStateRef.value;
          return headers;
        };
        const headers = await resolveHeaders();

        const effort = options.effort;
        const useReasoning = model.supportsThinking;
        const upstreamModelId = resolveChatGPTModelId(model.id);
        const useResponsesLite = isGpt56Model(upstreamModelId);
        const useWebSocket =
          useResponsesLite && providerOptions.useWebSocketForGpt56 === true && !transportState.websocketDisabled;

        const standardBody = await buildResponsesRequestBody({
          model: upstreamModelId,
          systemInstructions: flattenSections(context.systemPrompt),
          messages: context.messages,
          compactionSummary: context.compactionSummary,
          tools: context.tools,
          sessionId: options.sessionId,
          useReasoning,
          effort,
          store: false,
          localImageLoader: context.localImageLoader,
        });

        const requestBody = useResponsesLite ? toResponsesLiteRequestBody(standardBody) : standardBody;
        if (useResponsesLite) {
          headers[RESPONSES_LITE_HEADER] = "true";
        }

        if (useWebSocket) {
          const request = { type: "response.create", ...requestBody };
          const session: ChatGPTWebSocketSession | undefined = options.turnScope?.getOrCreate(turnSessionKey, () => {
            const value = createChatGPTWebSocketSession({
              url: CHATGPT_CODEX_WEBSOCKET_URL,
              resolveHeaders,
              webSocketFactory: providerOptions.webSocketFactory ?? createDefaultWebSocket,
              idleTimeoutMs: providerOptions.webSocketIdleTimeoutMs ?? CHATGPT_WEBSOCKET_IDLE_TIMEOUT_MS,
            });
            return { value, dispose: () => value.dispose() };
          });
          const connection = session
            ? session.streamRequest(request, options.signal)
            : createChatGPTWebSocketEvents({
                headers,
                request,
                signal: options.signal,
                webSocketFactory: providerOptions.webSocketFactory ?? createDefaultWebSocket,
                idleTimeoutMs: providerOptions.webSocketIdleTimeoutMs,
              });
          await connection.opened;
          stream.push({ type: "start" });
          await handleResponsesAPIEvents(
            connection.events,
            stream,
            model,
            options.signal,
            context.messages.length,
            options.sessionId,
          );
          transportState.consecutiveTransportFailures = 0;
          return;
        }

        const requestText = JSON.stringify(requestBody);
        const debugHttpSse = process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE === "1";
        const requestByteLength = debugHttpSse ? new TextEncoder().encode(requestText).byteLength : 0;
        const requestSummary = debugHttpSse
          ? summarizeChatGPTWebSocketPayload({ ...requestBody, type: "response.create" })
          : "";
        if (debugHttpSse) {
          debugChatGPTHttpRequest("sending", requestByteLength, requestSummary, { sessionId: options.sessionId });
        }
        const headerTimeoutMs = Math.max(1, providerOptions.httpHeaderTimeoutMs ?? CHATGPT_HTTP_HEADER_TIMEOUT_MS);
        const headerTimeoutController = new AbortController();
        const fetchSignal = options.signal
          ? AbortSignal.any([options.signal, headerTimeoutController.signal])
          : headerTimeoutController.signal;
        let headerTimedOut = false;
        const headerTimeout = setTimeout(() => {
          headerTimedOut = true;
          headerTimeoutController.abort();
        }, headerTimeoutMs);
        let response: Response;
        try {
          response = await fetch(CHATGPT_CODEX_URL, {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": CHATGPT_JSON_CONTENT_TYPE,
              Accept: "text/event-stream",
            },
            body: requestText,
            signal: fetchSignal,
          });
        } catch (error) {
          if (headerTimedOut) {
            throw new ProviderError(
              `ChatGPT HTTP response header timeout after ${headerTimeoutMs}ms`,
              ProviderErrorType.Network,
              true,
              undefined,
              undefined,
              error instanceof Error ? error : undefined,
            );
          }
          throw error;
        } finally {
          clearTimeout(headerTimeout);
        }
        if (debugHttpSse) {
          debugChatGPTHttpRequest("sent", requestByteLength, requestSummary, {
            status: response.status,
            sessionId: options.sessionId,
          });
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          const isUsageLimit = errText.includes("usage_limit_reached");
          const message = `ChatGPT API error (${response.status}): ${errText || "no body"}`;
          throw classifyChatGPTHttpError({ message, status: response.status, isUsageLimit });
        }

        // Capture sticky routing token on first successful response
        const turnStateHeader = response.headers.get(CHATGPT_TURN_STATE_HEADER);
        if (turnStateHeader && options.turnStateRef && options.turnStateRef.value === undefined) {
          options.turnStateRef.value = turnStateHeader;
        }

        stream.push({ type: "start" });

        // Parse SSE lines into an async iterable of event objects
        async function* parseSse(): AsyncIterable<Record<string, unknown>> {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          const debugEnabled = process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE === "1";
          let buffer = "";

          while (true) {
            if (options.signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!; // keep incomplete line

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (!data || data === "[DONE]") continue;

              let event: Record<string, unknown>;
              try {
                event = JSON.parse(data) as Record<string, unknown>;
              } catch {
                if (debugEnabled) {
                  debugChatGPTHttpSse(
                    "<-",
                    new TextEncoder().encode(data).byteLength,
                    "invalid_json",
                    options.sessionId,
                  );
                }
                continue;
              }
              if (debugEnabled) {
                debugChatGPTHttpSse(
                  "<-",
                  new TextEncoder().encode(data).byteLength,
                  summarizeChatGPTWebSocketPayload(event),
                  options.sessionId,
                );
              }
              yield event;
            }
          }
        }

        await handleResponsesAPIEvents(
          parseSse(),
          stream,
          model,
          options.signal,
          context.messages.length,
          options.sessionId,
        );
      } catch (err) {
        if (useChatGPTWebSocketTransportFailure(err, providerOptions, model)) {
          transportState.consecutiveTransportFailures += 1;
          if (transportState.consecutiveTransportFailures >= 2) transportState.websocketDisabled = true;
        }
        if (err instanceof ProviderError) {
          stream.push({ type: "error", error: err });
        } else if (isNetworkError(err)) {
          stream.push({ type: "error", error: new ProviderError(String(err), ProviderErrorType.Network, true) });
        } else if (err instanceof Error && isTransientOpenAIErrorMessage(err.message)) {
          stream.push({
            type: "error",
            error: new ProviderError(err.message, ProviderErrorType.ServerError, true, undefined, undefined, err),
          });
        } else {
          stream.push({
            type: "error",
            error: new ProviderError(
              err instanceof Error ? err.message : String(err),
              ProviderErrorType.Unknown,
              false,
              undefined,
              undefined,
              err instanceof Error ? err : undefined,
            ),
          });
        }
      }
    })();

    return stream;
  };
}

function truncateErrorBody(value: string, maxLen = 400): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

function stringifyErrorPayload(payload: Record<string, unknown>): string {
  const errorValue = payload.error;
  if (typeof errorValue === "string") {
    return truncateErrorBody(errorValue);
  }
  if (errorValue && typeof errorValue === "object") {
    const err = errorValue as Record<string, unknown>;
    const code = typeof err.code === "string" ? err.code : undefined;
    const type = typeof err.type === "string" ? err.type : undefined;
    const message = typeof err.message === "string" ? err.message : undefined;
    const fields = [code, type, message].filter((field): field is string => Boolean(field));
    if (fields.length > 0) {
      return truncateErrorBody(fields.join(" | "));
    }
  }
  return truncateErrorBody(JSON.stringify(payload));
}

async function readCompactErrorBody(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as unknown;
      if (payload && typeof payload === "object") {
        return stringifyErrorPayload(payload as Record<string, unknown>);
      }
    } catch {
      // fall through to text path
    }
  }

  const text = await response.text().catch(() => "");
  return truncateErrorBody(text.trim());
}

export function createChatGPTNativeCompaction(getTokens: () => OpenAIOAuthTokens): NativeCompactFn {
  return async (input) => {
    const tokens = getTokens();
    const upstreamModelId = resolveChatGPTModelId(input.model.id);
    const useResponsesLite = isGpt56Model(upstreamModelId);
    const headers: Record<string, string> = {
      "Content-Type": CHATGPT_JSON_CONTENT_TYPE,
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": USER_AGENT,
      originator: "diligent",
      version: CHATGPT_CODEX_CLIENT_VERSION,
    };
    if (tokens.account_id) headers["ChatGPT-Account-ID"] = tokens.account_id;
    if (input.sessionId) {
      headers.session_id = input.sessionId;
    }
    if (useResponsesLite) headers[RESPONSES_LITE_HEADER] = "true";

    const standardBody: Record<string, unknown> = {
      model: upstreamModelId,
      input: await toResponseInputItems({
        messages: input.messages,
        compactionSummary: input.compactionSummary,
        localImageLoader: input.localImageLoader,
      }),
    };
    if (input.systemPrompt.length > 0) standardBody.instructions = flattenSections(input.systemPrompt);
    const body = useResponsesLite ? toResponsesLiteRequestBody(standardBody) : standardBody;

    const response = await fetch(CHATGPT_COMPACT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const errorBody = await readCompactErrorBody(response);
      if (response.status === 404 || response.status === 405) {
        return { status: "unsupported", reason: `status_${response.status}` };
      }
      const suffix = errorBody ? ` body=${errorBody}` : "";
      throw new Error(`ChatGPT native compaction failed (${response.status})${suffix}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const summary = extractCompactionSummary(payload);
    const compactionSummary = extractCompactionSummaryItem(payload);
    if (!summary?.trim() && !compactionSummary) {
      return { status: "unsupported", reason: `missing_summary ${describeCompactionPayload(payload)}` };
    }
    return { status: "ok", summary, compactionSummary };
  };
}
