// @summary Responses API SSE event state machine and handleResponsesAPIEvents for OpenAI-format providers
import type { EventStream } from "../../event-stream";
import type { AssistantMessage, ContentBlock, StopReason, Usage } from "../../types";
import type { Model, ProviderEvent, ProviderResult } from "../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError } from "../types";
import { isContextOverflow, mapStopReason, mapUsage } from "./openai-responses";
import { isTransientOpenAIErrorMessage } from "./openai-shared";

type ResponseToolBuffer = { id: string; name: string; args: string };

type ProviderName = "openai" | "chatgpt" | "anthropic";
type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;
type WebFetchResultBlock = Extract<ContentBlock, { type: "web_fetch_result" }>;

type ResponsesAPIState = {
  contentBlocks: ContentBlock[];
  pendingProviderToolUses: Map<string, ProviderToolUseBlock>;
  pendingWebSearchResults: Map<string, WebSearchResultBlock>;
  pendingWebFetchResults: Map<string, WebFetchResultBlock>;
  pendingCompletedResponse?: Record<string, unknown>;
  currentText: string;
  currentThinking: string;
  currentToolId: string;
  stopReason: StopReason;
  usage: Usage;
  toolBuffers: Map<string, ResponseToolBuffer>;
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
    contentBlocks: [],
    pendingProviderToolUses: new Map<string, ProviderToolUseBlock>(),
    pendingWebSearchResults: new Map<string, WebSearchResultBlock>(),
    pendingWebFetchResults: new Map<string, WebFetchResultBlock>(),
    pendingCompletedResponse: undefined,
    currentText: "",
    currentThinking: "",
    currentToolId: "",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolBuffers: new Map<string, ResponseToolBuffer>(),
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
      state.currentText += event.delta;
      return [{ type: "text_delta", delta: event.delta }];

    case "thinking_delta":
      state.currentThinking += event.delta;
      return [{ type: "thinking_delta", delta: event.delta }];

    case "tool_call_start":
      state.currentToolId = event.id;
      state.toolBuffers.set(event.id, { id: event.id, name: event.name, args: "" });
      return [{ type: "tool_call_start", id: event.id, name: event.name }];

    case "provider_web_call_start": {
      debugWebSearchPayload("start", event.item, model.provider);
      const providerToolUse = createProviderToolUseBlock(event.item, model.provider);
      if (!providerToolUse) return [];
      state.pendingProviderToolUses.set(providerToolUse.id, providerToolUse);
      state.contentBlocks.push(providerToolUse);
      return [{ type: "content_block", block: providerToolUse }];
    }

    case "tool_call_args_delta": {
      const itemId = event.itemId ?? state.currentToolId;
      const buffer = state.toolBuffers.get(itemId);
      if (buffer) {
        buffer.args += event.delta;
        return [{ type: "tool_call_delta", id: buffer.id, delta: event.delta }];
      }
      if (state.currentToolId) {
        return [{ type: "tool_call_delta", id: state.currentToolId, delta: event.delta }];
      }
      return [];
    }

    case "reasoning_done": {
      const finalThinking = state.currentThinking || event.summaryText;
      if (!finalThinking) return [];
      state.currentThinking = "";
      state.contentBlocks.unshift({ type: "thinking", thinking: finalThinking });
      return [{ type: "thinking_end", thinking: finalThinking }];
    }

    case "message_done": {
      if (event.blocks.length === 0) return [];
      state.currentText = "";
      const emitted: ProviderEvent[] = [];
      for (const block of event.blocks) {
        state.contentBlocks.push(block);
        if (block.type === "text") emitted.push({ type: "text_end", text: block.text });
      }
      return emitted;
    }

    case "tool_call_done": {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(event.args) as Record<string, unknown>;
      } catch {
        input = {};
      }
      state.toolBuffers.delete(event.id);
      state.contentBlocks.push({ type: "tool_call", id: event.id, name: event.name, input });
      return [{ type: "tool_call_end", id: event.id, name: event.name, input }];
    }

    case "provider_web_call_done": {
      debugWebSearchPayload("done", event.item, model.provider);
      const toolUseId = getProviderToolUseId(event.item);
      if (!toolUseId) return [];
      if (!state.pendingProviderToolUses.has(toolUseId)) {
        const providerToolUse = createProviderToolUseBlock(event.item, model.provider);
        if (providerToolUse) {
          state.pendingProviderToolUses.set(toolUseId, providerToolUse);
          state.contentBlocks.push(providerToolUse);
        }
      }
      const webSearchResult = createWebSearchResultBlock(event.item, toolUseId, model.provider);
      if (webSearchResult) {
        state.pendingWebSearchResults.set(toolUseId, webSearchResult);
        state.contentBlocks.push(webSearchResult);
        return [{ type: "content_block", block: webSearchResult }];
      }
      const webFetchResult = createWebFetchResultBlock(event.item, toolUseId, model.provider);
      if (webFetchResult) {
        state.pendingWebFetchResults.set(toolUseId, webFetchResult);
        state.contentBlocks.push(webFetchResult);
        return [{ type: "content_block", block: webFetchResult }];
      }
      return [];
    }

    case "response_completed":
      state.pendingCompletedResponse = event.response;
      applyCompletedResponseFallbacks(state, event.response, model.provider);
      state.usage = mapUsage(event.usage);
      state.stopReason = mapStopReason(event.status);
      return [];

    case "response_failed": {
      // Carry the provider's error code via cause so error logs show code=... (D086)
      const cause = Object.assign(new Error(event.message), { code: event.code });
      if (isContextOverflow(event.message)) {
        return [
          {
            type: "error",
            error: new ProviderError(
              CONTEXT_OVERFLOW_ERROR_MESSAGE,
              "context_overflow",
              false,
              undefined,
              undefined,
              cause,
            ),
          },
        ];
      }
      if (isTransientOpenAIErrorMessage(event.message)) {
        return [
          { type: "error", error: new ProviderError(event.message, "server_error", true, undefined, undefined, cause) },
        ];
      }
      return [
        { type: "error", error: new ProviderError(event.message, "unknown", false, undefined, undefined, cause) },
      ];
    }
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

function getProviderName(provider: string): ProviderName {
  return provider === "chatgpt" ? "chatgpt" : provider === "anthropic" ? "anthropic" : "openai";
}

function getProviderToolUseId(item: Record<string, unknown>): string | undefined {
  const callId = item.call_id;
  if (typeof callId === "string" && callId.length > 0) return callId;
  const id = item.id;
  if (typeof id === "string" && id.length > 0) return id;
  return undefined;
}

function getWebAction(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const action = item.action;
  return action && typeof action === "object" ? (action as Record<string, unknown>) : undefined;
}

function getCapabilityName(actionType: unknown): ProviderToolUseBlock["name"] | undefined {
  return actionType === "search"
    ? "web_search"
    : actionType === "open_page" || actionType === "find_in_page"
      ? "web_fetch"
      : undefined;
}

function createProviderToolUseBlock(item: Record<string, unknown>, provider: string): ProviderToolUseBlock | undefined {
  const id = getProviderToolUseId(item);
  const action = getWebAction(item);
  const actionType = action?.type ?? item.action_type;
  const status = typeof item.status === "string" ? item.status : undefined;
  const name = getCapabilityName(actionType) ?? (item.type === "web_search_call" ? "web_search" : undefined);
  if (!id || !name) return undefined;
  const input = action ?? (actionType ? { type: actionType } : status === "in_progress" ? { type: "search" } : {});
  const sources = normalizeSources(item);
  return {
    type: "provider_tool_use",
    id,
    provider: getProviderName(provider),
    name,
    input: sources.length > 0 ? { ...input, sources } : input,
  };
}

function normalizeSources(item: Record<string, unknown>): Array<Record<string, unknown>> {
  const action = getWebAction(item);
  const output = item.output && typeof item.output === "object" ? (item.output as Record<string, unknown>) : undefined;
  const result = item.result && typeof item.result === "object" ? (item.result as Record<string, unknown>) : undefined;
  const page = item.page && typeof item.page === "object" ? (item.page as Record<string, unknown>) : undefined;
  const candidateArrays = [
    action?.sources,
    item.sources,
    item.results,
    output?.sources,
    output?.results,
    output?.data,
    result?.sources,
    result?.results,
    page?.sources,
    page?.results,
    item.data,
  ];
  for (const candidate of candidateArrays) {
    if (!Array.isArray(candidate)) continue;
    return candidate.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
  }
  return [];
}

function collectDocumentCandidates(item: Record<string, unknown>): Record<string, unknown>[] {
  const output = item.output && typeof item.output === "object" ? (item.output as Record<string, unknown>) : undefined;
  const result = item.result && typeof item.result === "object" ? (item.result as Record<string, unknown>) : undefined;
  const page = item.page && typeof item.page === "object" ? (item.page as Record<string, unknown>) : undefined;
  const content =
    item.content && typeof item.content === "object" ? (item.content as Record<string, unknown>) : undefined;
  const candidates = [
    item.document,
    item.page,
    item.content,
    item.result,
    item.output,
    output?.document,
    output?.page,
    output?.content,
    output?.result,
    result?.document,
    result?.page,
    result?.content,
    page,
    content,
  ];
  return candidates.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickDocumentString(candidates: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const candidate of candidates) {
    const value = pickString(candidate, keys);
    if (value) return value;
  }
  return undefined;
}

function debugWebSearchPayload(
  stage: "start" | "done" | "completed",
  item: Record<string, unknown> | undefined,
  provider: string,
): void {
  if (process.env.DILIGENT_DEBUG_WEB_TOOLS !== "1") return;
  const summary = {
    provider,
    stage,
    itemType: item?.type,
    callId: item?.call_id,
    actionType: getWebAction(item ?? {})?.type ?? item?.action_type,
    keys: item ? Object.keys(item).slice(0, 20) : [],
    actionKeys: getWebAction(item ?? {}) ? Object.keys(getWebAction(item ?? {})!).slice(0, 20) : [],
    sourcesLen: normalizeSources(item ?? {}).length,
  };
  console.debug(`[llm:web-tools] ${JSON.stringify(summary)}`);
}

function collectCompletedWebSearchCalls(response: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const output = response?.output;
  if (!Array.isArray(output)) return [];
  return output.filter((item): item is Record<string, unknown> => {
    return Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).type === "web_search_call";
  });
}

function applyCompletedResponseFallbacks(
  state: ResponsesAPIState,
  response: Record<string, unknown> | undefined,
  provider: string,
): void {
  const items = collectCompletedWebSearchCalls(response);
  if (items.length === 0) return;
  let recoveredToolUses = 0;
  let recoveredSearchResults = 0;
  let recoveredFetchResults = 0;
  for (const item of items) {
    debugWebSearchPayload("completed", item, provider);
    const toolUseId = getProviderToolUseId(item);
    if (!toolUseId) continue;

    if (!state.pendingProviderToolUses.has(toolUseId)) {
      const providerToolUse = createProviderToolUseBlock(item, provider);
      if (providerToolUse) {
        state.pendingProviderToolUses.set(toolUseId, providerToolUse);
        state.contentBlocks.push(providerToolUse);
        recoveredToolUses += 1;
      }
    }

    if (!state.pendingWebSearchResults.has(toolUseId)) {
      const webSearchResult = createWebSearchResultBlock(item, toolUseId, provider);
      if (webSearchResult && webSearchResult.results.length > 0) {
        state.pendingWebSearchResults.set(toolUseId, webSearchResult);
        state.contentBlocks.push(webSearchResult);
        recoveredSearchResults += 1;
      }
    }

    if (!state.pendingWebFetchResults.has(toolUseId)) {
      const webFetchResult = createWebFetchResultBlock(item, toolUseId, provider);
      if (webFetchResult) {
        state.pendingWebFetchResults.set(toolUseId, webFetchResult);
        state.contentBlocks.push(webFetchResult);
        recoveredFetchResults += 1;
      }
    }
  }

  const recoveredCalls = recoveredToolUses + recoveredSearchResults + recoveredFetchResults;
  if (recoveredCalls > 0) {
    return;
  }
}

function createWebSearchResultBlock(
  item: Record<string, unknown>,
  toolUseId: string,
  provider: string,
): WebSearchResultBlock | undefined {
  const action = getWebAction(item);
  if (action?.type !== "search") return undefined;
  const providerToolUse = createProviderToolUseBlock(item, provider);
  const providerSources = Array.isArray(providerToolUse?.input.sources)
    ? (providerToolUse?.input.sources as Array<Record<string, unknown>>)
    : [];
  const results = normalizeSources(item)
    .map((source) => {
      const url = typeof source.url === "string" ? source.url : "";
      const providerSource = providerSources.find((candidate) => candidate.url === url);
      return {
        url,
        ...(typeof source.title === "string"
          ? { title: source.title }
          : typeof providerSource?.title === "string"
            ? { title: providerSource.title }
            : {}),
        ...(typeof source.page_age === "string" ? { pageAge: source.page_age } : {}),
        ...(typeof source.snippet === "string"
          ? { snippet: source.snippet }
          : typeof providerSource?.snippet === "string"
            ? { snippet: providerSource.snippet }
            : {}),
        ...(typeof source.encrypted_content === "string"
          ? { encryptedContent: source.encrypted_content }
          : typeof providerSource?.encrypted_content === "string"
            ? { encryptedContent: providerSource.encrypted_content }
            : {}),
      };
    })
    .filter((result) => result.url.length > 0);
  return {
    type: "web_search_result",
    toolUseId,
    provider: getProviderName(provider),
    results,
  };
}

function createWebFetchResultBlock(
  item: Record<string, unknown>,
  toolUseId: string,
  provider: string,
): WebFetchResultBlock | undefined {
  const action = getWebAction(item);
  if (action?.type !== "open_page" && action?.type !== "find_in_page") return undefined;

  const sources = normalizeSources(item);
  const source = sources[0];
  const url = pickString(action, ["url"]) ?? (source ? pickString(source, ["url"]) : undefined);
  if (!url) return undefined;

  const documentCandidates = [...collectDocumentCandidates(item), ...(source ? [source] : [])];
  const text = pickDocumentString(documentCandidates, ["text", "content", "snippet", "body", "markdown"]);
  const mimeType = pickDocumentString(documentCandidates, ["mime_type", "mimeType", "content_type", "contentType"]);
  const title = pickDocumentString(documentCandidates, ["title", "page_title", "pageTitle"]);
  const base64Data = pickDocumentString(documentCandidates, ["base64_data", "base64Data", "data"]);
  const retrievedAt =
    pickString(item, ["retrieved_at", "retrievedAt"]) ??
    pickDocumentString(documentCandidates, ["retrieved_at", "retrievedAt"]);

  return {
    type: "web_fetch_result",
    toolUseId,
    provider: getProviderName(provider),
    url,
    ...(text || mimeType || title || base64Data
      ? {
          document: {
            mimeType: mimeType ?? "text/html",
            ...(text ? { text } : {}),
            ...(base64Data ? { base64Data } : {}),
            ...(title ? { title } : {}),
            citationsEnabled: true,
          },
        }
      : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
  };
}

function extractCitations(part: {
  text?: unknown;
  annotations?: unknown;
}): Array<NonNullable<Extract<ContentBlock, { type: "text" }>["citations"]>[number]> | undefined {
  if (!Array.isArray(part.annotations)) return undefined;
  const text = typeof part.text === "string" ? part.text : "";
  const citations: Array<NonNullable<Extract<ContentBlock, { type: "text" }>["citations"]>[number]> = [];
  for (const annotation of part.annotations) {
    if (!annotation || typeof annotation !== "object") continue;
    const raw = annotation as Record<string, unknown>;
    const annotationType = raw.type;
    const startIndex = typeof raw.start_index === "number" ? raw.start_index : undefined;
    const endIndex = typeof raw.end_index === "number" ? raw.end_index : undefined;
    const citedText =
      startIndex !== undefined && endIndex !== undefined && endIndex > startIndex
        ? text.slice(startIndex, endIndex)
        : undefined;

    if (
      (annotationType === "url_citation" || annotationType === "web_search_result_location") &&
      typeof raw.url === "string"
    ) {
      citations.push({
        type: "web_search_result_location",
        url: raw.url,
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
        ...(typeof raw.encrypted_index === "string" ? { encryptedIndex: raw.encrypted_index } : {}),
        ...(citedText ? { citedText } : {}),
      });
      continue;
    }

    const documentIndex = typeof raw.document_index === "number" ? raw.document_index : undefined;
    if ((annotationType === "file_citation" || annotationType === "char_location") && documentIndex !== undefined) {
      citations.push({
        type: "char_location",
        documentIndex,
        ...(typeof raw.document_title === "string" ? { documentTitle: raw.document_title } : {}),
        startCharIndex: startIndex ?? 0,
        endCharIndex: endIndex ?? 0,
        ...(citedText ? { citedText } : {}),
      });
    }
  }

  return citations.length > 0 ? citations : undefined;
}

function extractOutputContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as { type?: unknown; text?: unknown; annotations?: unknown };
    if (part.type === "output_text" && typeof part.text === "string") {
      const citations = extractCitations(part);
      blocks.push({
        type: "text",
        text: part.text,
        ...(citations ? { citations } : {}),
      });
    }
  }
  return blocks;
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
  _turnIndex?: number,
  _sessionId?: string,
): Promise<void> {
  const state = createResponsesAPIState();
  let sawCompleted = false;

  for await (const event of iter) {
    if (signal?.aborted) break;
    const decodedEvent = decodeResponsesAPIEvent(event);
    if (!decodedEvent) continue;
    if (decodedEvent.kind === "response_completed") sawCompleted = true;
    const emittedEvents = reduceResponsesAPIEvent(state, decodedEvent, model);
    emitProviderEvents(stream, emittedEvents);
    if (emittedEvents.some((providerEvent) => providerEvent.type === "error")) return;
  }

  if (signal?.aborted) return;

  if (!sawCompleted) {
    stream.push({
      type: "error",
      error: new ProviderError("stream closed before response.completed", "network", true),
    });
    return;
  }

  if (state.currentText) {
    const text = state.currentText;
    state.currentText = "";
    state.contentBlocks.push({ type: "text", text });
    stream.push({ type: "text_end", text });
  }

  stream.push({ type: "usage", usage: state.usage });

  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: state.contentBlocks,
    model: model.id,
    usage: state.usage,
    stopReason: state.stopReason,
    timestamp: Date.now(),
  };

  stream.push({ type: "done", stopReason: state.stopReason, message: assistantMessage });
}
