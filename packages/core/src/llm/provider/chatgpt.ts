// @summary ChatGPT subscription stream — HTTP/SSE for legacy models and WebSocket Responses Lite for GPT-5.6
import { arch, platform, release } from "node:os";
import type { OpenAIOAuthTokens } from "../../auth/types";
import { EventStream } from "../../event-stream";
import { isNetworkError } from "../errors";
import { flattenSections } from "../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../types";
import { ProviderError } from "../types";
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

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_CODEX_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CHATGPT_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses/compact";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
// Pinned to the Codex client version used to verify the GPT-5.6 transport contract.
const CHATGPT_CODEX_CLIENT_VERSION = "0.144.1";
const USER_AGENT = `diligent (${platform()} ${release()}; ${arch()})`;

export interface ChatGPTStreamOptions {
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

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

function toChatGPTWebSocketError(payload: Record<string, unknown>): ProviderError {
  const status = typeof payload.status === "number" ? payload.status : undefined;
  const rawError = payload.error;
  const error = rawError && typeof rawError === "object" ? (rawError as Record<string, unknown>) : undefined;
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof rawError === "string" && rawError) ||
    "ChatGPT WebSocket request failed";
  const errorType = typeof error?.type === "string" ? error.type : "";
  const isUsageLimit = errorType.includes("usage_limit") || message.includes("usage_limit_reached");
  const displayMessage =
    status === 429 && isUsageLimit
      ? "AI usage limit reached. Please try again later or upgrade your plan."
      : `ChatGPT API error${status ? ` (${status})` : ""}: ${message}`;

  return new ProviderError(
    displayMessage,
    status === 429 && isUsageLimit
      ? "unknown"
      : status === 429
        ? "rate_limit"
        : status !== undefined && status >= 500
          ? "server_error"
          : status === 401 || status === 403
            ? "auth"
            : "unknown",
    status !== 429 && ((status !== undefined && status >= 500) || isTransientOpenAIErrorMessage(displayMessage)),
    undefined,
    status,
  );
}

function createChatGPTWebSocketEvents(input: {
  headers: Record<string, string>;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  webSocketFactory: (url: string, headers: Record<string, string>) => WebSocket;
}): { opened: Promise<void>; events: AsyncIterable<Record<string, unknown>> } {
  const queue = new AsyncEventQueue<Record<string, unknown>>();
  const socket = input.webSocketFactory(CHATGPT_CODEX_WEBSOCKET_URL, input.headers);
  let opened = false;
  let settled = false;
  let messageWork = Promise.resolve();
  let resolveOpened!: () => void;
  let rejectOpened!: (error: Error) => void;
  const openedPromise = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });

  const cleanup = () => {
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
    try {
      socket.send(JSON.stringify(input.request));
      settled = true;
      resolveOpened();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function handleMessage(event: MessageEvent): void {
    messageWork = messageWork
      .then(async () => {
        const text = await webSocketMessageToString(event.data);
        const payload = JSON.parse(text) as Record<string, unknown>;
        if (payload.type === "error") {
          fail(toChatGPTWebSocketError(payload));
          return;
        }

        queue.push(payload);
        if (payload.type === "response.completed" || payload.type === "response.failed") {
          queue.end();
          cleanup();
          if (socket.readyState !== WebSocket.CLOSED) socket.close(1000);
        }
      })
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  }

  function handleError(): void {
    fail(new ProviderError("ChatGPT WebSocket connection failed", "network", true));
  }

  function handleClose(event: CloseEvent): void {
    if (!opened) {
      fail(
        new ProviderError(
          `ChatGPT WebSocket connection closed before opening (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
          "network",
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

  function handleAbort(): void {
    if (!settled) {
      settled = true;
      rejectOpened(new ProviderError("Aborted", "unknown", false));
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
  if (input.signal?.aborted) handleAbort();

  return { opened: openedPromise, events: queue };
}

function resolveChatGPTModelId(modelId: string): string {
  return modelId.startsWith("chatgpt-") ? `gpt-${modelId.slice("chatgpt-".length)}` : modelId;
}

/**
 * Create a StreamFunction for ChatGPT subscription (OAuth).
 *
 * Bypasses the OpenAI Node SDK entirely. Legacy models use raw HTTP/SSE,
 * while GPT-5.6 models use the ChatGPT Codex WebSocket Responses Lite contract.
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
        const tokens = getTokens();

        const headers: Record<string, string> = {
          Authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": USER_AGENT,
          originator: "diligent",
          version: CHATGPT_CODEX_CLIENT_VERSION,
        };
        if (tokens.account_id) {
          headers["ChatGPT-Account-ID"] = tokens.account_id;
        }
        if (options.sessionId) {
          headers.session_id = options.sessionId;
        }
        if (options.turnStateRef?.value !== undefined) {
          headers["x-codex-turn-state"] = options.turnStateRef.value;
        }

        const effort = options.effort;
        const useReasoning = model.supportsThinking;
        const upstreamModelId = resolveChatGPTModelId(model.id);
        const useResponsesLite = isGpt56Model(upstreamModelId);

        const standardBody = await buildResponsesRequestBody({
          model: upstreamModelId,
          systemInstructions: flattenSections(context.systemPrompt),
          messages: context.messages,
          cwd: context.cwd,
          compactionSummary: context.compactionSummary,
          tools: context.tools,
          sessionId: options.sessionId,
          useReasoning,
          effort,
          store: false,
        });

        if (useResponsesLite) {
          headers[RESPONSES_LITE_HEADER] = "true";
          const body = toResponsesLiteRequestBody(standardBody);
          const connection = createChatGPTWebSocketEvents({
            headers,
            request: { type: "response.create", ...body },
            signal: options.signal,
            webSocketFactory: providerOptions.webSocketFactory ?? createDefaultWebSocket,
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
          return;
        }

        const response = await fetch(CHATGPT_CODEX_URL, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(standardBody),
          signal: options.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          const isUsageLimit = errText.includes("usage_limit_reached");
          const is429 = response.status === 429;
          const message =
            is429 && isUsageLimit
              ? "AI usage limit reached. Please try again later or upgrade your plan."
              : `ChatGPT API error (${response.status}): ${errText || "no body"}`;
          throw new ProviderError(
            message,
            is429 && isUsageLimit
              ? "unknown"
              : is429
                ? "rate_limit"
                : response.status >= 500
                  ? "server_error"
                  : response.status === 401 || response.status === 403
                    ? "auth"
                    : "unknown",
            !is429 && (response.status >= 500 || isTransientOpenAIErrorMessage(message)),
            undefined,
            response.status,
          );
        }

        // Capture sticky routing token on first successful response
        const turnStateHeader = response.headers.get("x-codex-turn-state");
        if (turnStateHeader && options.turnStateRef && options.turnStateRef.value === undefined) {
          options.turnStateRef.value = turnStateHeader;
        }

        stream.push({ type: "start" });

        // Parse SSE lines into an async iterable of event objects
        async function* parseSse(): AsyncIterable<Record<string, unknown>> {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
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
                continue;
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
        if (err instanceof ProviderError) {
          stream.push({ type: "error", error: err });
        } else if (isNetworkError(err)) {
          stream.push({ type: "error", error: new ProviderError(String(err), "network", true) });
        } else if (err instanceof Error && isTransientOpenAIErrorMessage(err.message)) {
          stream.push({
            type: "error",
            error: new ProviderError(err.message, "server_error", true, undefined, undefined, err),
          });
        } else {
          stream.push({
            type: "error",
            error: new ProviderError(
              err instanceof Error ? err.message : String(err),
              "unknown",
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
      "Content-Type": "application/json",
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
        cwd: input.cwd,
        compactionSummary: input.compactionSummary,
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
