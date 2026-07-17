// @summary Responses API SSE event state machine and handleResponsesAPIEvents for OpenAI-format providers
import type { EventStream } from "../../../event-stream";
import type { ContentBlock } from "../../../types";
import type { Model, ProviderEvent, ProviderResult } from "../../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";
import { OpenAIContentAccumulator } from "./content-accumulator";
import { isContextOverflow, mapStopReason, mapUsage } from "./responses";
import { isTransientOpenAIErrorMessage } from "./shared";
import {
  applyCompletedResponseFallbacks,
  createProviderToolUseBlock,
  createWebFetchResultBlock,
  createWebSearchResultBlock,
  debugWebSearchPayload,
  extractOutputContentBlocks,
  getProviderToolUseId,
  type OpenAIWebContentState,
} from "./web-content";

type ResponsesAPIState = OpenAIWebContentState & {
  currentToolId: string;
};

type ResponsesAPIDecodedEvent =
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "provider_web_call_start"; item: Record<string, unknown> }
  | { kind: "tool_call_args_delta"; itemId?: string; delta: string }
  | { kind: "reasoning_done"; summaryText: string }
  | { kind: "message_done"; blocks: ContentBlock[] }
  | { kind: "tool_call_done"; id: string; name: string; args: string }
  | { kind: "provider_web_call_done"; item: Record<string, unknown> }
  | {
      kind: "response_completed";
      response?: Record<string, unknown>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      };
      status?: string;
    }
  | { kind: "response_failed"; message: string; code?: string };

function createResponsesAPIState(): ResponsesAPIState {
  return {
    accumulator: new OpenAIContentAccumulator(),
    pendingProviderToolUses: new Map(),
    pendingWebSearchResults: new Map(),
    pendingWebFetchResults: new Map(),
    currentToolId: "",
  };
}

function decodeResponsesAPIEvent(event: Record<string, unknown>): ResponsesAPIDecodedEvent | undefined {
  const type = event.type as string;

  switch (type) {
    case "response.output_text.delta": {
      const delta = event.delta as string;
      if (!delta) return undefined;
      return { kind: "text_delta", delta };
    }
    case "response.reasoning_summary_text.delta": {
      const delta = event.delta as string;
      if (!delta) return undefined;
      return { kind: "thinking_delta", delta };
    }
    case "response.output_item.added": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return undefined;
      if (item.type === "web_search_call") {
        return { kind: "provider_web_call_start", item };
      }
      if (item.type !== "function_call") return undefined;
      return { kind: "tool_call_start", id: (item.call_id as string) ?? "", name: (item.name as string) ?? "" };
    }
    case "response.function_call_arguments.delta": {
      const delta = event.delta as string;
      if (!delta) return undefined;
      return { kind: "tool_call_args_delta", itemId: event.item_id as string | undefined, delta };
    }
    case "response.output_item.done": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return undefined;
      if (item.type === "reasoning") {
        return { kind: "reasoning_done", summaryText: extractReasoningSummaryText(item.summary) };
      }
      if (item.type === "message") {
        return { kind: "message_done", blocks: extractOutputContentBlocks(item.content) };
      }
      if (item.type === "function_call") {
        return {
          kind: "tool_call_done",
          id: (item.call_id as string) ?? "",
          name: (item.name as string) ?? "",
          args: (item.arguments as string) ?? "",
        };
      }
      if (item.type === "web_search_call") {
        return { kind: "provider_web_call_done", item };
      }
      return undefined;
    }
    case "response.completed": {
      const response = event.response as Record<string, unknown> | undefined;
      if (!response) return undefined;
      return {
        kind: "response_completed",
        response,
        usage: response.usage as {
          input_tokens: number;
          output_tokens: number;
          input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          output_tokens_details?: { reasoning_tokens?: number };
        },
        status: response.status as string | undefined,
      };
    }
    case "response.failed": {
      const response = event.response as Record<string, unknown> | undefined;
      const responseError = response?.error as Record<string, unknown> | undefined;
      const code = responseError?.code;
      return {
        kind: "response_failed",
        message: (responseError?.message as string) ?? "Response failed",
        code: typeof code === "string" ? code : undefined,
      };
    }
    default:
      return undefined;
  }
}

function reduceResponsesAPIEvent(
  state: ResponsesAPIState,
  event: ResponsesAPIDecodedEvent,
  model: Model,
): ProviderEvent[] {
  switch (event.kind) {
    case "text_delta":
      return state.accumulator.appendTextDelta(event.delta);

    case "thinking_delta":
      return state.accumulator.appendThinkingDelta(event.delta);

    case "tool_call_start": {
      state.currentToolId = event.id;
      state.accumulator.upsertToolCall(event.id, { id: event.id, name: event.name, order: 0 });
      return [{ type: "tool_call_start", id: event.id, name: event.name }];
    }

    case "provider_web_call_start": {
      debugWebSearchPayload("start", event.item, model.provider);
      const providerToolUse = createProviderToolUseBlock(event.item, model.provider);
      if (!providerToolUse) return [];
      state.pendingProviderToolUses.set(providerToolUse.id, providerToolUse);
      state.accumulator.addContentBlock(providerToolUse);
      return [{ type: "content_block", block: providerToolUse }];
    }

    case "tool_call_args_delta": {
      const itemId = event.itemId ?? state.currentToolId;
      const emitted = state.accumulator.appendToolArguments(itemId, event.delta);
      if (emitted.length > 0) return emitted;
      if (state.currentToolId) {
        return [{ type: "tool_call_delta", id: state.currentToolId, delta: event.delta }];
      }
      return [];
    }

    case "reasoning_done": {
      return state.accumulator.flushThinking(event.summaryText, "prepend");
    }

    case "message_done": {
      return state.accumulator.acceptAuthoritativeMessage(event.blocks);
    }

    case "tool_call_done": {
      return state.accumulator.completeToolCall(event.id, {
        id: event.id,
        name: event.name,
        arguments: event.args,
        parseArguments: parseResponsesToolArguments,
      });
    }

    case "provider_web_call_done": {
      debugWebSearchPayload("done", event.item, model.provider);
      const toolUseId = getProviderToolUseId(event.item);
      if (!toolUseId) return [];
      if (!state.pendingProviderToolUses.has(toolUseId)) {
        const providerToolUse = createProviderToolUseBlock(event.item, model.provider);
        if (providerToolUse) {
          state.pendingProviderToolUses.set(toolUseId, providerToolUse);
          state.accumulator.addContentBlock(providerToolUse);
        }
      }
      const webSearchResult = createWebSearchResultBlock(event.item, toolUseId, model.provider);
      if (webSearchResult) {
        state.pendingWebSearchResults.set(toolUseId, webSearchResult);
        state.accumulator.addContentBlock(webSearchResult);
        return [{ type: "content_block", block: webSearchResult }];
      }
      const webFetchResult = createWebFetchResultBlock(event.item, toolUseId, model.provider);
      if (webFetchResult) {
        state.pendingWebFetchResults.set(toolUseId, webFetchResult);
        state.accumulator.addContentBlock(webFetchResult);
        return [{ type: "content_block", block: webFetchResult }];
      }
      return [];
    }

    case "response_completed":
      applyCompletedResponseFallbacks(state, event.response, model.provider);
      state.accumulator.setUsage(mapUsage(event.usage));
      state.accumulator.setStopReason(mapStopReason(event.status));
      return [];

    case "response_failed": {
      // Carry the provider's error code via cause so error logs show code=... (D086)
      const cause = Object.assign(new Error(event.message), { code: event.code });
      if (isContextOverflow(event.message)) {
        return [
          {
            type: "error",
            error: new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, {
              errorType: ProviderErrorType.ContextOverflow,
              isRetryable: false,
              cause,
              reason: ProviderErrorReason.ContextWindowExceeded,
            }),
          },
        ];
      }
      if (isTransientOpenAIErrorMessage(event.message)) {
        return [
          {
            type: "error",
            error: new ProviderError(event.message, ProviderErrorType.ServerError, true, undefined, undefined, cause),
          },
        ];
      }
      return [
        {
          type: "error",
          error: new ProviderError(event.message, ProviderErrorType.Unknown, false, undefined, undefined, cause),
        },
      ];
    }
  }
}

function parseResponsesToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsText) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function emitProviderEvents(stream: EventStream<ProviderEvent, ProviderResult>, events: ProviderEvent[]): void {
  for (const event of events) {
    stream.push(event);
  }
}

function extractReasoningSummaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Process OpenAI Responses API SSE events from an async iterable.
 * Works for both SDK streams (openai.ts) and raw-parsed objects (chatgpt.ts).
 */
export async function handleResponsesAPIEvents(
  iter: AsyncIterable<Record<string, unknown>>,
  stream: EventStream<ProviderEvent, ProviderResult>,
  model: Model,
  signal?: AbortSignal,
): Promise<void> {
  const state = createResponsesAPIState();
  let sawCompleted = false;

  for await (const event of iter) {
    if (signal?.aborted) {
      state.accumulator.abort();
      break;
    }
    const decodedEvent = decodeResponsesAPIEvent(event);
    if (!decodedEvent) continue;
    if (decodedEvent.kind === "response_completed") sawCompleted = true;
    const emittedEvents = reduceResponsesAPIEvent(state, decodedEvent, model);
    emitProviderEvents(stream, emittedEvents);
    if (emittedEvents.some((providerEvent) => providerEvent.type === "error")) {
      state.accumulator.abort();
      return;
    }
  }

  if (signal?.aborted) return;

  if (!sawCompleted) {
    state.accumulator.abort();
    stream.push({
      type: "error",
      error: new ProviderError("stream closed before response.completed", ProviderErrorType.Network, true),
    });
    return;
  }

  const finalization = state.accumulator.finalize({
    modelId: model.id,
    finalizePendingTools: false,
    flushThinking: false,
  });
  if (finalization) emitProviderEvents(stream, finalization.events);
}
