// @summary Anthropic provider stream orchestration, thinking policy, final mapping, and error classification
import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@diligent/logging";
import { EventStream } from "../../../event-stream";
import type { AssistantMessage, ContentBlock, StopReason, Usage } from "../../../types";
import { isNetworkError } from "../../errors";
import { classifyProviderHttpError } from "../../provider-errors";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "../../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";
import { convertMessages } from "./messages";
import { toAnthropicBlocks } from "./request";
import {
  convertTools,
  createProviderToolUseBlock,
  createWebFetchResultBlock,
  createWebSearchResultBlock,
} from "./web-tools";

export {
  appendAnthropicConvertedMessage,
  applyAnthropicLastUserCacheBreakpoint,
  buildAnthropicCompactionPrefix,
  type ConvertedAnthropicMessage,
  convertAnthropicMessage,
  convertMessages,
} from "./messages";
export { createAnthropicNativeCompaction } from "./native-compaction";
export { convertTools } from "./web-tools";

const anthropicLogger = createLogger({ scope: "llm:anthropic" });

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type TextCitation = NonNullable<TextBlock["citations"]>[number];

export function createAnthropicStream(apiKey?: string, baseUrl?: string): StreamFunction {
  const resolvedApiKey = resolveAnthropicApiKey(apiKey);
  const resolvedSdkBaseUrl = resolveAnthropicSdkBaseUrl(baseUrl);
  const debugEndpoint = `${resolvedSdkBaseUrl.replace(/\/+$/, "")}/v1/messages`;
  const client = new Anthropic({
    apiKey: resolvedApiKey,
    baseURL: resolvedSdkBaseUrl,
    timeout: 15_000,
    maxRetries: 0,
  });

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
        const effort = options.effort;
        const effortProvided = effort !== undefined;

        let thinkingConfig: Record<string, unknown>;
        if (effortProvided && model.supportsThinking && model.supportsAdaptiveThinking) {
          thinkingConfig = {
            thinking: { type: "adaptive" } as Anthropic.ThinkingConfigParam,
            output_config: { effort: effort === "xhigh" ? "max" : effort },
            temperature: 1,
          };
        } else if (effortProvided && model.supportsThinking && !model.supportsAdaptiveThinking) {
          const budgetKey = effort === "none" ? "low" : effort === "xhigh" ? "max" : effort;
          const budgetTokens = model.thinkingBudgets?.[budgetKey] ?? model.defaultBudgetTokens ?? 8_000;
          thinkingConfig = {
            thinking: {
              type: "enabled",
              budget_tokens: budgetTokens,
            } as Anthropic.ThinkingConfigParam,
            temperature: 1,
          };
        } else {
          thinkingConfig = options.temperature !== undefined ? { temperature: options.temperature } : {};
        }

        const systemBlocks = toAnthropicBlocks(context.systemPrompt);
        const requestParams = {
          model: model.id,
          max_tokens: options.maxTokens ?? model.maxOutputTokens,
          system: systemBlocks,
          messages: await convertMessages(context.messages, context.compactionSummary, context.localImageLoader),
          ...(context.tools.length > 0 && {
            tools: convertTools(context.tools),
          }),
          ...thinkingConfig,
        } as Anthropic.MessageCreateParams;

        if (process.env.ANTHROPIC_DEBUG_REQUEST === "1") {
          anthropicLogger.error("request_endpoint", {
            message: `[anthropic.endpoint] ${debugEndpoint}`,
            fields: { endpoint: debugEndpoint },
          });
          anthropicLogger.error("request_payload", {
            message: `[anthropic.request] ${JSON.stringify(requestParams, null, 2)}`,
          });
        }

        const sdkStream = client.messages.stream(
          requestParams,
          ...(options.signal ? [{ signal: options.signal }] : []),
        );

        stream.push({ type: "start" });

        // Track active tool call for delta routing
        let activeToolId: string | undefined;

        sdkStream.on("text", (textDelta) => {
          stream.push({ type: "text_delta", delta: textDelta });
        });

        sdkStream.on("thinking", (thinkingDelta) => {
          stream.push({ type: "thinking_delta", delta: thinkingDelta });
        });

        sdkStream.on("inputJson", (partialJson) => {
          if (activeToolId) {
            stream.push({
              type: "tool_call_delta",
              id: activeToolId,
              delta: partialJson,
            });
          }
        });

        sdkStream.on("contentBlock", (block) => {
          if (block.type === "text") {
            stream.push({ type: "text_end", text: block.text });
          } else if (block.type === "thinking") {
            stream.push({ type: "thinking_end", thinking: block.thinking });
          } else if (block.type === "server_tool_use") {
            const providerToolUse = createProviderToolUseBlock(block);
            if (providerToolUse) {
              stream.push({ type: "content_block", block: providerToolUse });
            }
          } else if (block.type === "tool_use") {
            stream.push({
              type: "tool_call_end",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
            activeToolId = undefined;
          } else if (block.type === "web_search_tool_result") {
            const webSearchResult = createWebSearchResultBlock(block);
            if (webSearchResult) {
              stream.push({ type: "content_block", block: webSearchResult });
            }
          } else if (block.type === "web_fetch_tool_result") {
            const webFetchResult = createWebFetchResultBlock(block);
            if (webFetchResult) {
              stream.push({ type: "content_block", block: webFetchResult });
            }
          }
        });

        sdkStream.on("streamEvent", (event) => {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              activeToolId = event.content_block.id;
              stream.push({
                type: "tool_call_start",
                id: event.content_block.id,
                name: event.content_block.name,
              });
            } else if (event.content_block.type === "server_tool_use") {
              const providerToolUse = createProviderToolUseBlock(event.content_block);
              if (providerToolUse) {
                stream.push({ type: "content_block", block: providerToolUse });
              }
            }
          }
        });

        const finalMessage = await sdkStream.finalMessage();
        const assistantMessage = mapToAssistantMessage(finalMessage, model);
        stream.push({
          type: "usage",
          usage: assistantMessage.usage,
        });
        stream.push({
          type: "done",
          stopReason: assistantMessage.stopReason,
          message: assistantMessage,
        });
      } catch (err) {
        stream.push({
          type: "error",
          error: classifyAnthropicError(err),
        });
      }
    })();
    stream.setInnerWork(work);

    return stream;
  };
}

function mapTextCitations(citations: Anthropic.TextCitation[] | null | undefined): TextCitation[] | undefined {
  if (!citations || citations.length === 0) return undefined;
  const mapped: TextCitation[] = [];
  for (const citation of citations) {
    if (citation.type === "web_search_result_location") {
      mapped.push({
        type: "web_search_result_location",
        url: citation.url,
        ...(citation.title != null ? { title: citation.title } : {}),
        ...(citation.encrypted_index ? { encryptedIndex: citation.encrypted_index } : {}),
        ...(citation.cited_text ? { citedText: citation.cited_text } : {}),
      });
    } else if (citation.type === "char_location") {
      mapped.push({
        type: "char_location",
        documentIndex: citation.document_index,
        ...(citation.document_title != null ? { documentTitle: citation.document_title } : {}),
        startCharIndex: citation.start_char_index,
        endCharIndex: citation.end_char_index,
        ...(citation.cited_text ? { citedText: citation.cited_text } : {}),
      });
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

function mapToAssistantMessage(msg: Anthropic.Message, model: Model): AssistantMessage {
  const content: ContentBlock[] = msg.content.map((block): ContentBlock => {
    if (block.type === "text") {
      const citations = mapTextCitations(block.citations);
      return {
        type: "text",
        text: block.text,
        ...(citations ? { citations } : {}),
      };
    } else if (block.type === "tool_use") {
      return {
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    } else if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      };
    } else if (block.type === "server_tool_use") {
      return createProviderToolUseBlock(block) ?? { type: "text", text: "" };
    } else if (block.type === "web_search_tool_result") {
      return createWebSearchResultBlock(block) ?? { type: "text", text: "" };
    } else if (block.type === "web_fetch_tool_result") {
      return createWebFetchResultBlock(block) ?? { type: "text", text: "" };
    }
    return { type: "text", text: "" };
  });

  const usage: Usage = {
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };

  const stopReason = mapStopReason(msg.stop_reason);

  return {
    role: "assistant",
    content,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "compaction":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// TODO: Track actual inputTokens for proactive compaction (D-compact)
export function classifyAnthropicError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 400 && err.message.includes("context length")) {
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
      retryAfterMs: parseRetryAfter(err.headers),
    });
    if (httpError) return httpError;
    return new ProviderError(err.message, ProviderErrorType.Unknown, false, undefined, status, err);
  }
  if (isNetworkError(err)) {
    return new ProviderError(String(err), ProviderErrorType.Network, true);
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

function parseRetryAfter(headers?: Headers | Record<string, string | null | undefined>): number | undefined {
  if (!headers) return undefined;

  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  };

  const ms = getHeader("retry-after-ms");
  if (ms) {
    const parsedMs = Number.parseInt(ms, 10);
    if (Number.isFinite(parsedMs)) return parsedMs;
  }

  const s = getHeader("retry-after");
  if (s) {
    const parsedSeconds = Number.parseInt(s, 10);
    if (Number.isFinite(parsedSeconds)) return parsedSeconds * 1000;
  }

  return undefined;
}

function resolveAnthropicApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey to createAnthropicStream().");
}

function resolveAnthropicSdkBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
}
