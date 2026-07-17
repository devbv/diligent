// @summary OpenAI-family web tool, fetch result, citation, and fallback normalization
import { createLogger } from "@diligent/logging";
import type { ContentBlock } from "../../../types";
import type { OpenAIContentAccumulator } from "./content-accumulator";

const webToolsLogger = createLogger({ scope: "llm:web-tools" });

type ProviderName = "openai" | "chatgpt" | "anthropic";
type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;
type WebFetchResultBlock = Extract<ContentBlock, { type: "web_fetch_result" }>;

export interface OpenAIWebContentState {
  accumulator: OpenAIContentAccumulator;
  pendingProviderToolUses: Map<string, ProviderToolUseBlock>;
  pendingWebSearchResults: Map<string, WebSearchResultBlock>;
  pendingWebFetchResults: Map<string, WebFetchResultBlock>;
}

function getProviderName(provider: string): ProviderName {
  return provider === "chatgpt" ? "chatgpt" : provider === "anthropic" ? "anthropic" : "openai";
}

export function getProviderToolUseId(item: Record<string, unknown>): string | undefined {
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

export function createProviderToolUseBlock(
  item: Record<string, unknown>,
  provider: string,
): ProviderToolUseBlock | undefined {
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

export function debugWebSearchPayload(
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
  webToolsLogger.debug("web_tool_payload", {
    message: `[llm:web-tools] ${JSON.stringify(summary)}`,
    fields: summary,
  });
}

function collectCompletedWebSearchCalls(response: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const output = response?.output;
  if (!Array.isArray(output)) return [];
  return output.filter((item): item is Record<string, unknown> => {
    return Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).type === "web_search_call";
  });
}

export function applyCompletedResponseFallbacks(
  state: OpenAIWebContentState,
  response: Record<string, unknown> | undefined,
  provider: string,
): void {
  const items = collectCompletedWebSearchCalls(response);
  if (items.length === 0) return;
  for (const item of items) {
    debugWebSearchPayload("completed", item, provider);
    const toolUseId = getProviderToolUseId(item);
    if (!toolUseId) continue;

    if (!state.pendingProviderToolUses.has(toolUseId)) {
      const providerToolUse = createProviderToolUseBlock(item, provider);
      if (providerToolUse) {
        state.pendingProviderToolUses.set(toolUseId, providerToolUse);
        state.accumulator.addContentBlock(providerToolUse);
      }
    }

    if (!state.pendingWebSearchResults.has(toolUseId)) {
      const webSearchResult = createWebSearchResultBlock(item, toolUseId, provider);
      if (webSearchResult && webSearchResult.results.length > 0) {
        state.pendingWebSearchResults.set(toolUseId, webSearchResult);
        state.accumulator.addContentBlock(webSearchResult);
      }
    }

    if (!state.pendingWebFetchResults.has(toolUseId)) {
      const webFetchResult = createWebFetchResultBlock(item, toolUseId, provider);
      if (webFetchResult) {
        state.pendingWebFetchResults.set(toolUseId, webFetchResult);
        state.accumulator.addContentBlock(webFetchResult);
      }
    }
  }
}

export function createWebSearchResultBlock(
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

export function createWebFetchResultBlock(
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

export function extractOutputContentBlocks(content: unknown): ContentBlock[] {
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
