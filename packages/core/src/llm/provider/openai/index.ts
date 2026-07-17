// @summary OpenAI provider implementation with streaming, tools, and error classification
import OpenAI from "openai";
import { EventStream } from "../../../event-stream";
import { isNetworkError } from "../../errors";
import { classifyProviderHttpError } from "../../provider-errors";
import { flattenSections } from "../../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";

export { createOpenAINativeCompaction } from "./native-compaction";

import { buildResponsesRequestBody, isContextOverflow, type OpenAIImageDetail } from "./responses";
import { isTransientOpenAIErrorMessage } from "./shared";
import { handleResponsesAPIEvents } from "./sse";

export function createOpenAIStream(apiKey?: string, baseUrl?: string, imageDetail?: OpenAIImageDetail): StreamFunction {
  const resolvedApiKey = resolveOpenAIApiKey(apiKey);
  const client = createOpenAIClient(resolvedApiKey, baseUrl);

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
        const useReasoning = model.supportsThinking;
        const requestBody = await buildResponsesRequestBody({
          model: model.id,
          systemInstructions: flattenSections(context.systemPrompt),
          messages: context.messages,
          compactionSummary: context.compactionSummary,
          tools: context.tools,
          strictTools: false,
          sessionId: options.sessionId,
          enablePromptCaching: true,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          useReasoning,
          effort: options.effort,
          imageDetail,
          localImageLoader: context.localImageLoader,
        });
        const openaiStream = await client.responses.create(
          requestBody,
          ...(options.signal ? [{ signal: options.signal }] : []),
        );

        stream.push({ type: "start" });

        await handleResponsesAPIEvents(
          openaiStream as unknown as AsyncIterable<Record<string, unknown>>,
          stream,
          model,
          options.signal,
        );
      } catch (err) {
        stream.push({ type: "error", error: classifyOpenAIError(err) });
      }
    })();
    stream.setInnerWork(work);

    return stream;
  };
}

export function createOpenAIClient(apiKey: string, baseUrl?: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: 15_000,
    maxRetries: 0,
  });
}

export function classifyOpenAIError(err: unknown): ProviderError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 400 && isContextOverflow(err.message)) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, {
        errorType: ProviderErrorType.ContextOverflow,
        isRetryable: false,
        statusCode: status,
        cause: err,
        reason: ProviderErrorReason.ContextWindowExceeded,
      });
    }
    const httpError = classifyProviderHttpError({
      message: err.message,
      status,
      cause: err,
      retryAfterMs: parseRetryAfterFromHeaders(err.headers),
    });
    if (httpError) return httpError;
    if (isTransientOpenAIError(err)) {
      return new ProviderError(err.message, ProviderErrorType.ServerError, true, undefined, status, err);
    }
    return new ProviderError(err.message, ProviderErrorType.Unknown, false, undefined, status, err);
  }
  if (isNetworkError(err)) {
    return new ProviderError(String(err), ProviderErrorType.Network, true);
  }
  if (isTransientOpenAIError(err)) {
    return new ProviderError(
      err instanceof Error ? err.message : String(err),
      ProviderErrorType.ServerError,
      true,
      undefined,
      undefined,
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

function resolveOpenAIApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey to createOpenAIStream().");
}

function parseRetryAfterFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms) return Number.parseInt(ms, 10);
  const s = headers.get("retry-after");
  if (s) return Number.parseInt(s, 10) * 1000;
  return undefined;
}

function isTransientOpenAIError(err: unknown): boolean {
  return err instanceof Error && isTransientOpenAIErrorMessage(err.message);
}
