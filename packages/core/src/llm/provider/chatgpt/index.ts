// @summary ChatGPT subscription stream — HTTP/SSE for legacy models and WebSocket Responses Lite for GPT-5.6
import { arch, platform, release } from "node:os";
import { createLogger } from "@diligent/logging";
import type { OpenAIOAuthTokens } from "../../../auth/types";
import { EventStream } from "../../../event-stream";
import { flattenSections } from "../../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../../types";
import { ProviderError, ProviderErrorType } from "../../types";

export { createChatGPTNativeCompaction } from "./native-compaction";

import { buildResponsesRequestBody, isGpt56Model, toResponsesLiteRequestBody } from "../openai/responses";
import { classifyOpenAIFamilyError, parseOpenAIRetryAfter } from "../openai/shared";
import { handleResponsesAPIEvents } from "../openai/sse";
import { CHATGPT_SESSION_HEADER } from "./headers";
import { iterateChatGPTJsonSse } from "./http-sse";
import { type ChatGPTWebSocketSession, createChatGPTWebSocketSession } from "./websocket-session";

const webSocketLogger = createLogger({ scope: "llm:chatgpt-ws" });
const httpSseLogger = createLogger({ scope: "llm:chatgpt-sse" });

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_CODEX_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const CHATGPT_TURN_STATE_HEADER = "x-codex-turn-state";
const CHATGPT_JSON_CONTENT_TYPE = "application/json";
// Pinned to the Codex client version used to verify the GPT-5.6 transport contract.
const CHATGPT_CODEX_CLIENT_VERSION = "0.144.1";
const CHATGPT_WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
const CHATGPT_HTTP_HEADER_TIMEOUT_MS = 15_000;
const CHATGPT_HTTP_STREAM_IDLE_TIMEOUT_MS = 300_000;
const USER_AGENT = `diligent (${platform()} ${release()}; ${arch()})`;

export interface ChatGPTStreamOptions {
  useWebSocketForGpt56?: boolean;
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  webSocketIdleTimeoutMs?: number;
  /** Maximum wait for HTTP response headers. Does not limit SSE body streaming. */
  httpHeaderTimeoutMs?: number;
  /** Maximum idle wait between HTTP body chunks. Resets whenever bytes arrive. */
  httpStreamIdleTimeoutMs?: number;
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

  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
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
  const details = [errorCode, errorType, message].filter((value): value is string => Boolean(value)).join(" | ");

  return classifyOpenAIFamilyError({
    message: `ChatGPT API error${status ? ` (${status})` : ""}: ${details || message}`,
    status,
    code: errorCode ?? errorType,
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
      onReceive(payload, byteLength) {
        debugChatGPTWebSocket("<-", byteLength, summarizeChatGPTWebSocketPayload(payload));
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

    const work = (async () => {
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
          provider: "chatgpt",
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
            await handleResponsesAPIEvents(connection.events, stream, model, options.signal);
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
          const structuredError = decodeChatGPTHttpError(errText);
          const message = `ChatGPT API error (${response.status}): ${errText || "no body"}`;
          throw classifyOpenAIFamilyError({
            message,
            status: response.status,
            code: structuredError.code,
            cause: structuredError.cause,
            retryAfterMs: parseOpenAIRetryAfter(response.headers),
          });
        }

        // Capture sticky routing token on first successful response
        const turnStateHeader = response.headers.get(CHATGPT_TURN_STATE_HEADER);
        if (turnStateHeader && options.turnStateRef && options.turnStateRef.value === undefined) {
          options.turnStateRef.value = turnStateHeader;
        }

        stream.push({ type: "start" });

        const debugEnabled = process.env.DILIGENT_DEBUG_CHATGPT_HTTP_SSE === "1";
        const responseEvents = iterateChatGPTJsonSse(response.body, {
          signal: options.signal,
          idleTimeoutMs: Math.max(1, providerOptions.httpStreamIdleTimeoutMs ?? CHATGPT_HTTP_STREAM_IDLE_TIMEOUT_MS),
          onJson: (event, _data, byteLength) => {
            if (!debugEnabled) return;
            debugChatGPTHttpSse("<-", byteLength, summarizeChatGPTWebSocketPayload(event), options.sessionId);
          },
          onInvalidJson: (_data, byteLength) => {
            if (!debugEnabled) return;
            debugChatGPTHttpSse("<-", byteLength, "invalid_json", options.sessionId);
          },
        });

        await handleResponsesAPIEvents(responseEvents, stream, model, options.signal);
      } catch (err) {
        if (useChatGPTWebSocketTransportFailure(err, providerOptions, model)) {
          transportState.consecutiveTransportFailures += 1;
          if (transportState.consecutiveTransportFailures >= 2) transportState.websocketDisabled = true;
        }
        if (err instanceof ProviderError) {
          stream.push({ type: "error", error: err });
        } else {
          stream.push({
            type: "error",
            error: classifyOpenAIFamilyError({
              message: err instanceof Error ? err.message : String(err),
              cause: err instanceof Error ? err : undefined,
            }),
          });
        }
      }
    })();
    stream.setInnerWork(work);

    return stream;
  };
}

function decodeChatGPTHttpError(text: string): { code?: string; cause?: Error } {
  if (!text) return {};
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object") return { cause: new Error(text) };
    const rawError = (payload as Record<string, unknown>).error;
    if (!rawError || typeof rawError !== "object") return { cause: new Error(text) };
    const error = rawError as Record<string, unknown>;
    const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : undefined;
    return { code, cause: Object.assign(new Error(text), { error: rawError, ...(code ? { code } : {}) }) };
  } catch {
    return { cause: new Error(text) };
  }
}
