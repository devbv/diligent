// @summary OpenAI provider implementation with streaming, tools, and error classification
import OpenAI from "openai";
import { EventStream } from "../../../event-stream";
import { flattenSections } from "../../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../../types";
import { ProviderError } from "../../types";

export { createOpenAINativeCompaction } from "./native-compaction";

import { buildResponsesRequestBody, type OpenAIImageDetail } from "./responses";
import { classifyOpenAIFamilyError, iterateOpenAIStreamWithIdleTimeout, parseOpenAIRetryAfter } from "./shared";
import { handleResponsesAPIEvents } from "./sse";

const OPENAI_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface OpenAIStreamProviderOptions {
  /** Maximum idle wait between SDK stream events. Resets whenever an event arrives. */
  streamIdleTimeoutMs?: number;
}

export function createOpenAIStream(
  apiKey?: string,
  baseUrl?: string,
  imageDetail?: OpenAIImageDetail,
  providerOptions: OpenAIStreamProviderOptions = {},
): StreamFunction {
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
          store: false,
          imageDetail,
          localImageLoader: context.localImageLoader,
          provider: "openai",
        });
        const openaiStream = await client.responses.create(
          requestBody,
          ...(options.signal ? [{ signal: options.signal }] : []),
        );

        stream.push({ type: "start" });

        const sdkStream = openaiStream as unknown as AsyncIterable<Record<string, unknown>> & {
          controller?: AbortController;
        };
        const idleTimeoutMs = Math.max(1, providerOptions.streamIdleTimeoutMs ?? OPENAI_STREAM_IDLE_TIMEOUT_MS);
        await handleResponsesAPIEvents(
          iterateOpenAIStreamWithIdleTimeout(sdkStream, {
            idleTimeoutMs,
            message: `OpenAI stream idle timeout after ${idleTimeoutMs}ms`,
            signal: options.signal,
            onTimeout: () => sdkStream.controller?.abort(),
            onAbort: () => sdkStream.controller?.abort(),
          }),
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
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIError) {
    return classifyOpenAIFamilyError({
      message: err.message,
      status: err.status,
      code: typeof err.code === "string" ? err.code : undefined,
      cause: err,
      retryAfterMs: parseOpenAIRetryAfter(err.headers),
    });
  }
  return classifyOpenAIFamilyError({
    message: err instanceof Error ? err.message : String(err),
    cause: err instanceof Error ? err : undefined,
  });
}

function resolveOpenAIApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey to createOpenAIStream().");
}
