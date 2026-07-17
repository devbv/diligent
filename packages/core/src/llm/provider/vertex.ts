// @summary Vertex AI provider using the OpenAI-compatible Chat Completions endpoint
import { EventStream } from "../../event-stream";
import { isNetworkError } from "../errors";
import { classifyProviderHttpError } from "../provider-errors";
import { flattenSections } from "../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../types";
import {
  buildOpenAICompatibleMessages,
  buildOpenAICompatibleTools,
  handleChatCompletionsEvents,
} from "./openai-compatible";
import { isContextOverflow } from "./openai-responses";

export interface VertexStreamConfig {
  baseUrl?: string;
  modelMap?: Record<string, string>;
}

const DEFAULT_OPENAPI_MODEL_MAP: Record<string, string> = {
  "vertex-gemma-4-26b-it": "google/gemma-4-26b-a4b-it-maas",
};

export function createVertexStream(getAccessToken: () => string, config?: VertexStreamConfig): StreamFunction {
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
        const token = getAccessToken().trim();
        if (!token) throw new Error("Vertex access token is empty");
        const baseUrl = resolveVertexBaseUrl(config?.baseUrl);
        const body: Record<string, unknown> = {
          model: resolveVertexModelId(model.id, baseUrl, config?.modelMap),
          messages: await buildOpenAICompatibleMessages(context.messages, context.localImageLoader),
          stream: true,
          stream_options: { include_usage: true },
        };
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

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!response.ok) {
          const errorBody = (await response.text().catch(() => "")).trim();
          throw classifyVertexError({
            status: response.status,
            message: errorBody || `Vertex API error (${response.status})`,
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
        stream.push({ type: "error", error: classifyVertexError(err) });
      }
    })();

    return stream;
  };
}

export function classifyVertexError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isNetworkError(err)) {
    return new ProviderError(
      String(err),
      ProviderErrorType.Network,
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
    if (status === 400 && isContextOverflow(message)) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, {
        errorType: ProviderErrorType.ContextOverflow,
        isRetryable: false,
        statusCode: status,
        reason: ProviderErrorReason.ContextWindowExceeded,
      });
    }
    const httpError = classifyProviderHttpError({
      message,
      status,
      cause: err instanceof Error ? err : undefined,
    });
    if (httpError) return httpError;
    return new ProviderError(
      message,
      ProviderErrorType.Unknown,
      false,
      undefined,
      status,
      err instanceof Error ? err : undefined,
    );
  }
  return new ProviderError(
    err instanceof Error ? err.message : String(err),
    ProviderErrorType.Unknown,
    false,
    undefined,
    undefined,
    err instanceof Error ? err : undefined,
  );
}

function resolveVertexBaseUrl(baseUrl?: string): string {
  if (!baseUrl) throw new Error("Vertex baseUrl is required");
  return baseUrl.replace(/\/+$/, "");
}

export function resolveVertexModelId(modelId: string, baseUrl: string, modelMap?: Record<string, string>): string {
  const explicit = modelMap?.[modelId];
  if (explicit) return explicit;
  if (baseUrl.endsWith("/endpoints/openapi")) {
    return DEFAULT_OPENAPI_MODEL_MAP[modelId] ?? modelId;
  }
  return modelId;
}
