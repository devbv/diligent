// @summary ChatGPT subscription stream — HTTP/SSE for legacy models and WebSocket Responses Lite for GPT-5.6
import { arch, platform, release } from "node:os";
import { createLogger } from "@diligent/logging";
import type { OpenAIOAuthTokens } from "../../../auth/types";
import { EventStream } from "../../../event-stream";
import { isNetworkError } from "../../errors";
import { classifyProviderHttpError } from "../../provider-errors";
import { flattenSections } from "../../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../../types";
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";
import type { NativeCompactFn } from "../native-compaction";
import {
  buildResponsesRequestBody,
  isGpt56Model,
  toResponseInputItems,
  toResponsesLiteRequestBody,
} from "../openai/responses";
import {
  describeCompactionPayload,
  extractCompactionSummary,
  extractCompactionSummaryItem,
  isTransientOpenAIErrorMessage,
} from "../openai/shared";
import { handleResponsesAPIEvents } from "../openai/sse";
import { iterateOpenAIJsonSse } from "../openai-compatible/json-sse";
import { type ChatGPTWebSocketSession, createChatGPTWebSocketSession } from "./websocket-session";

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

function createDefaultWebSocket(url: string, headers: Record<string, string>): WebSocket {
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new BunWebSocket(url, { headers });
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
    fields: {
      direction,
      ...(byteLength !== undefined && { byteLength }),
      summary,
    },
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
    fields: {
      direction: "->",
      state,
      byteLength,
      ...(status !== undefined && { status }),
      summary,
    },
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

function createChatGPTWebSocketSessionForProvider(input: {
  resolveHeaders: () => Promise<Record<string, string>>;
  webSocketFactory: (url: string, headers: Record<string, string>) => WebSocket;
  idleTimeoutMs: number;
}): ChatGPTWebSocketSession {
  return createChatGPTWebSocketSession({
    url: CHATGPT_CODEX_WEBSOCKET_URL,
    resolveHeaders: input.resolveHeaders,
    webSocketFactory: input.webSocketFactory,
    idleTimeoutMs: input.idleTimeoutMs,
    classifyError: toChatGPTWebSocketError,
    diagnostics: {
      onOpen() {
        if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET !== "1") return;
        webSocketLogger.debug("websocket_open", {
          message: "[llm:chatgpt-ws] state=open",
          fields: { state: "open" },
        });
      },
      onSend(data, payload) {
        debugChatGPTWebSocket(
          "->",
          new TextEncoder().encode(data).byteLength,
          summarizeChatGPTWebSocketPayload(payload),
        );
      },
      onReceive(data) {
        if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET !== "1") return;
        const byteLength = webSocketMessageByteLength(data);
        const immediateText = webSocketMessageToImmediateString(data);
        if (immediateText === undefined) {
          debugChatGPTWebSocket("<-", byteLength, "pending_decode");
          return;
        }
        try {
          debugChatGPTWebSocket(
            "<-",
            byteLength,
            summarizeChatGPTWebSocketPayload(JSON.parse(immediateText) as Record<string, unknown>),
          );
        } catch {
          debugChatGPTWebSocket("<-", byteLength, "invalid_json");
        }
      },
      onDecoded(data, payload) {
        if (
          process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET === "1" &&
          webSocketMessageToImmediateString(data) === undefined
        ) {
          debugChatGPTWebSocket(
            "<-",
            webSocketMessageByteLength(data),
            `decoded ${summarizeChatGPTWebSocketPayload(payload)}`,
          );
        }
      },
      onClose(code, reason, pendingDecode) {
        if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET !== "1") return;
        webSocketLogger.debug("websocket_close", {
          message: `[llm:chatgpt-ws] state=close code=${code} reason=${truncateWebSocketLogValue(
            reason || "none",
          )} pendingDecode=${pendingDecode}`,
          fields: {
            state: "close",
            code,
            reason: reason || "none",
            pendingDecode,
          },
        });
      },
      onError(opened, pendingDecode) {
        if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET !== "1") return;
        webSocketLogger.debug("websocket_error", {
          message: `[llm:chatgpt-ws] state=error opened=${opened} pendingDecode=${pendingDecode}`,
          fields: { state: "error", opened, pendingDecode },
        });
      },
      onTimeout(message, pendingDecode) {
        if (process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET !== "1") return;
        webSocketLogger.debug("websocket_timeout", {
          message: `[llm:chatgpt-ws] state=timeout pendingDecode=${pendingDecode} message=${message}`,
          fields: { state: "timeout", pendingDecode },
        });
      },
    },
  });
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
  const transportState: ChatGPTTransportState = {
    websocketDisabled: false,
    consecutiveTransportFailures: 0,
  };
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
        const upstreamModelId = resolveChatGPTModelId(model.id);
        const useResponsesLite = isGpt56Model(upstreamModelId);
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
          if (useResponsesLite) headers[RESPONSES_LITE_HEADER] = "true";
          return headers;
        };

        const effort = options.effort;
        const useReasoning = model.supportsThinking;
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

        if (useWebSocket) {
          const request = { type: "response.create", ...requestBody };
          const createSession = () =>
            createChatGPTWebSocketSessionForProvider({
              resolveHeaders,
              webSocketFactory: providerOptions.webSocketFactory ?? createDefaultWebSocket,
              idleTimeoutMs: providerOptions.webSocketIdleTimeoutMs ?? CHATGPT_WEBSOCKET_IDLE_TIMEOUT_MS,
            });
          let ephemeralSession: ChatGPTWebSocketSession | undefined;
          const session = options.turnScope
            ? options.turnScope.getOrCreate(turnSessionKey, () => {
                const value = createSession();
                return { value, dispose: () => value.dispose() };
              })
            : (ephemeralSession = createSession());
          try {
            const connection = session.streamRequest(request, options.signal);
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
          } finally {
            await ephemeralSession?.dispose();
          }
          return;
        }

        const headers = await resolveHeaders();
        const requestText = JSON.stringify(requestBody);
        const debugHttpSse = process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE === "1";
        const requestByteLength = debugHttpSse ? new TextEncoder().encode(requestText).byteLength : 0;
        const requestSummary = debugHttpSse
          ? summarizeChatGPTWebSocketPayload({
              ...requestBody,
              type: "response.create",
            })
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
          throw classifyChatGPTHttpError({
            message,
            status: response.status,
            isUsageLimit,
          });
        }

        // Capture sticky routing token on first successful response
        const turnStateHeader = response.headers.get(CHATGPT_TURN_STATE_HEADER);
        if (turnStateHeader && options.turnStateRef && options.turnStateRef.value === undefined) {
          options.turnStateRef.value = turnStateHeader;
        }

        stream.push({ type: "start" });

        const debugEnabled = process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE === "1";
        const responseEvents = iterateOpenAIJsonSse(response.body, {
          signal: options.signal,
          onJson: (event, _data, byteLength) => {
            if (!debugEnabled) return;
            debugChatGPTHttpSse("<-", byteLength, summarizeChatGPTWebSocketPayload(event), options.sessionId);
          },
          onInvalidJson: (_data, byteLength) => {
            if (!debugEnabled) return;
            debugChatGPTHttpSse("<-", byteLength, "invalid_json", options.sessionId);
          },
        });

        await handleResponsesAPIEvents(
          responseEvents,
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
          stream.push({
            type: "error",
            error: new ProviderError(String(err), ProviderErrorType.Network, true),
          });
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
      return {
        status: "unsupported",
        reason: `missing_summary ${describeCompactionPayload(payload)}`,
      };
    }
    return { status: "ok", summary, compactionSummary };
  };
}
