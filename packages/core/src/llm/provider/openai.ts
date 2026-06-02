// @summary OpenAI provider implementation with streaming, tools, and error classification
import OpenAI from "openai";
import { EventStream } from "../../event-stream";
import { isNetworkError } from "../errors";
import { flattenSections } from "../system-sections";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../types";
import { ProviderError } from "../types";
import type { NativeCompactFn } from "./native-compaction";
import {
  buildResponsesRequestBody,
  isContextOverflow,
  type OpenAIImageDetail,
  toResponseInputItems,
} from "./openai-responses";
import { describeCompactionPayload, extractCompactionSummary, extractCompactionSummaryItem } from "./openai-shared";
import { handleResponsesAPIEvents } from "./openai-sse";

export function createOpenAIStream(apiKey?: string, baseUrl?: string, imageDetail?: OpenAIImageDetail): StreamFunction {
  const resolvedApiKey = resolveOpenAIApiKey(apiKey);
  const client = new OpenAI({ apiKey: resolvedApiKey, baseURL: baseUrl });

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
        const useReasoning = model.supportsThinking;
        const requestBody = await buildResponsesRequestBody({
          model: model.id,
          systemInstructions: flattenSections(context.systemPrompt),
          messages: context.messages,
          cwd: context.cwd,
          compactionSummary: context.compactionSummary,
          tools: context.tools,
          strictTools: false,
          sessionId: options.sessionId,
          promptCacheRetention: "24h",
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          useReasoning,
          effort: options.effort,
          imageDetail,
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
          context.messages.length,
          options.sessionId,
        );
      } catch (err) {
        stream.push({ type: "error", error: classifyOpenAIError(err) });
      }
    })();

    return stream;
  };
}

export function classifyOpenAIError(err: unknown): ProviderError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) {
      const retryAfter = parseRetryAfterFromHeaders(err.headers);
      return new ProviderError(err.message, "rate_limit", false, retryAfter, status, err);
    }
    if (status >= 500) {
      return new ProviderError(err.message, "server_error", true, undefined, status, err);
    }
    if (status === 400 && isContextOverflow(err.message)) {
      return new ProviderError(err.message, "context_overflow", false, undefined, status, err);
    }
    if (status === 401 || status === 403) {
      return new ProviderError(err.message, "auth", false, undefined, status, err);
    }
    return new ProviderError(err.message, "unknown", false, undefined, status, err);
  }
  if (isNetworkError(err)) {
    return new ProviderError(String(err), "network", true);
  }
  if (isTransientOpenAIError(err)) {
    return new ProviderError(
      err instanceof Error ? err.message : String(err),
      "server_error",
      true,
      undefined,
      undefined,
      err instanceof Error ? err : undefined,
    );
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

function resolveOpenAIApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey to createOpenAIStream().");
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";

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
    const param = typeof err.param === "string" ? err.param : undefined;
    const message = typeof err.message === "string" ? err.message : undefined;
    const fields = [code, type, param, message].filter((field): field is string => Boolean(field));
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

function formatUnsupportedReason(status: number, errorBody: string): string {
  if (!errorBody) return `status_${status}`;
  return `status_${status} body=${errorBody}`;
}

function resolveOpenAIBaseUrl(baseUrl?: string): string {
  const resolved = (baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
  return resolved.endsWith("/v1") ? resolved : `${resolved}/v1`;
}

export function createOpenAINativeCompaction(
  apiKey: string,
  baseUrl?: string,
  imageDetail?: OpenAIImageDetail,
): NativeCompactFn {
  const compactEndpoint = `${resolveOpenAIBaseUrl(baseUrl)}/responses/compact`;
  return async (input) => {
    const body: Record<string, unknown> = {
      model: input.model.id,
      input: await toResponseInputItems({
        messages: input.messages,
        cwd: input.cwd,
        compactionSummary: input.compactionSummary,
        imageDetail,
      }),
    };
    if (input.systemPrompt.length > 0) body.instructions = flattenSections(input.systemPrompt);

    const response = await fetch(compactEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const errorBody = await readCompactErrorBody(response);
      if (response.status === 400 || response.status === 404 || response.status === 405) {
        return { status: "unsupported", reason: formatUnsupportedReason(response.status, errorBody) };
      }
      const suffix = errorBody ? ` body=${errorBody}` : "";
      throw new Error(`OpenAI native compaction failed (${response.status})${suffix}`);
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

function parseRetryAfterFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms) return Number.parseInt(ms, 10);
  const s = headers.get("retry-after");
  if (s) return Number.parseInt(s, 10) * 1000;
  return undefined;
}

function isTransientOpenAIError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("overloaded") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("an error occurred while processing your request") ||
    message.includes("request id") ||
    message.includes("help.openai.com") ||
    message.includes("service unavailable") ||
    message.includes("server had an error") ||
    message.includes("internal server error")
  );
}
