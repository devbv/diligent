// @summary z.ai Coding Plan provider using the OpenAI-compatible Chat Completions endpoint
import { EventStream } from "../../event-stream";
import { isNetworkError } from "../errors";
import { flattenSections } from "../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError } from "../types";
import {
  buildOpenAICompatibleMessages,
  buildOpenAICompatibleTools,
  handleChatCompletionsEvents,
} from "./openai-compatible";
import { isContextOverflow } from "./openai-responses";

const DEFAULT_ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export function createZaiCodingPlanStream(apiKey?: string, baseUrl?: string): StreamFunction {
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
        const resolvedApiKey = resolveZaiCodingPlanApiKey(apiKey);
        const body: Record<string, unknown> = {
          model: model.id,
          messages: await buildOpenAICompatibleMessages(context.messages, context.cwd),
          stream: true,
          stream_options: { include_usage: true },
        };
        if (model.supportsThinking && options.effort && options.effort !== "none") {
          body.thinking = { type: "enabled" };
          body.reasoning_effort = options.effort;
        }
        const instructions = flattenSections(context.systemPrompt);
        if (instructions.length > 0) {
          body.messages = [{ role: "system", content: instructions }, ...(body.messages as unknown[])];
        }
        const tools = buildOpenAICompatibleTools(context.tools);
        if (tools.length > 0) {
          body.tools = tools;
          body.tool_choice = "auto";
        }
        if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
        if (options.temperature !== undefined) body.temperature = options.temperature;

        const response = await fetch(`${resolveZaiCodingPlanBaseUrl(baseUrl)}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${resolvedApiKey}`,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!response.ok) {
          const errorBody = (await response.text().catch(() => "")).trim();
          throw classifyZaiCodingPlanError({
            status: response.status,
            message: errorBody || `z.ai Coding Plan API error (${response.status})`,
          });
        }

        stream.push({ type: "start" });

        async function* parseSse(): AsyncIterable<Record<string, unknown>> {
          const reader = response.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            if (options.signal?.aborted) return;
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                yield JSON.parse(data) as Record<string, unknown>;
              } catch {}
            }
          }
        }

        await handleChatCompletionsEvents(parseSse(), stream, model, options.signal);
      } catch (err) {
        stream.push({ type: "error", error: classifyZaiCodingPlanError(err) });
      }
    })();

    return stream;
  };
}

export function classifyZaiCodingPlanError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isNetworkError(err)) {
    return new ProviderError(
      String(err),
      "network",
      true,
      undefined,
      undefined,
      err instanceof Error ? err : undefined,
    );
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const status = typeof record.status === "number" ? record.status : undefined;
    const message =
      typeof record.message === "string" ? record.message : err instanceof Error ? err.message : String(err);
    if (status === 429) return new ProviderError(message, "rate_limit", false, undefined, status);
    if (status === 401 || status === 403)
      return new ProviderError(message, {
        errorType: "auth",
        isRetryable: false,
        statusCode: status,
        reason: "credentials_rejected",
      });
    if (status !== undefined && status >= 500)
      return new ProviderError(message, "server_error", true, undefined, status);
    if (status === 400 && isContextOverflow(message)) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, {
        errorType: "context_overflow",
        isRetryable: false,
        statusCode: status,
        reason: "context_window_exceeded",
      });
    }
    return new ProviderError(message, "unknown", false, undefined, status, err instanceof Error ? err : undefined);
  }
  return new ProviderError(
    err instanceof Error ? err.message : String(err),
    "unknown",
    false,
    undefined,
    undefined,
    err instanceof Error ? err : undefined,
  );
}

function resolveZaiCodingPlanApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.ZAI_CODING_PLAN_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error(
    "z.ai Coding Plan API key is required. Set ZAI_CODING_PLAN_API_KEY or pass apiKey to createZaiCodingPlanStream().",
  );
}

export function resolveZaiCodingPlanBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_ZAI_CODING_PLAN_BASE_URL).replace(/\/+$/, "");
}
