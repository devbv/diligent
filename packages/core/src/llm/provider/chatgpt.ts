// @summary ChatGPT subscription stream — raw fetch to chatgpt.com/backend-api/codex/responses (no SDK)
import { arch, platform, release } from "node:os";
import type { OpenAIOAuthTokens } from "../../auth/types";
import { EventStream } from "../../event-stream";
import { isNetworkError } from "../errors";
import { flattenSections } from "../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../types";
import { ProviderError } from "../types";
import type { NativeCompactFn } from "./native-compaction";
import { buildResponsesRequestBody, toResponseInputItems } from "./openai-responses";
import {
  describeCompactionPayload,
  extractCompactionSummary,
  extractCompactionSummaryItem,
  isTransientOpenAIErrorMessage,
} from "./openai-shared";
import { handleResponsesAPIEvents } from "./openai-sse";

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses/compact";
const USER_AGENT = `diligent (${platform()} ${release()}; ${arch()})`;

function resolveChatGPTModelId(modelId: string): string {
  return modelId.startsWith("chatgpt-") ? `gpt-${modelId.slice("chatgpt-".length)}` : modelId;
}

/**
 * Create a StreamFunction for ChatGPT subscription (OAuth).
 *
 * Bypasses the OpenAI Node SDK entirely — makes raw fetch calls to
 * chatgpt.com/backend-api/codex/responses using the Responses API format.
 * This avoids SDK-specific headers that the ChatGPT endpoint rejects.
 *
 * ChatGPT subscriber endpoint limitations (store: false enforced):
 * - store: true → 400 "Store must be set to false"
 * - previous_response_id → 400 (WebSocket-only, per codex-rs)
 * - item_reference → requires store: true → impossible
 * Only prompt_cache_key is accepted for server-side prefix caching.
 *
 * @param getTokens - Called per-request to get the current (possibly refreshed) tokens
 */
export function createChatGPTStream(getTokens: () => OpenAIOAuthTokens): StreamFunction {
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
        const tokens = getTokens();

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": USER_AGENT,
          originator: "diligent",
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

        const body = await buildResponsesRequestBody({
          model: resolveChatGPTModelId(model.id),
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

        const response = await fetch(CHATGPT_CODEX_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": USER_AGENT,
      originator: "diligent",
    };
    if (tokens.account_id) headers["ChatGPT-Account-ID"] = tokens.account_id;
    if (input.sessionId) {
      headers.session_id = input.sessionId;
    }

    const body: Record<string, unknown> = {
      model: resolveChatGPTModelId(input.model.id),
      input: await toResponseInputItems({
        messages: input.messages,
        cwd: input.cwd,
        compactionSummary: input.compactionSummary,
      }),
    };
    if (input.systemPrompt.length > 0) body.instructions = flattenSections(input.systemPrompt);

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
