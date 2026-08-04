// @summary Gemini provider adapter built on the Vercel AI SDK Google provider
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import type { TextStreamPart, ToolSet } from "ai";
import { asObjectJsonSchema } from "../../../tool/input-schema";
import type { ContentBlock } from "../../../types";
import { isNetworkError } from "../../errors";
import { classifyProviderHttpError } from "../../provider-errors";
import type { Model, StreamFunction, StreamOptions, ThinkingEffort, ToolDefinition } from "../../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";
import { convertToAISDKTools, createAISDKStream } from "../ai-sdk";
import { flattenGeminiUnionSchema, normalizeGeminiToolSchema } from "./tool-schema";

export { flattenGeminiUnionSchema, normalizeGeminiToolSchema } from "./tool-schema";

type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;

interface GeminiProviderState {
  blocksByKey: Map<string, ContentBlock>;
  sourceResults: Map<string, { url: string; title?: string }>;
}

type GeminiThinkingLevel = "low" | "medium" | "high";

export function resolveGeminiThinkingLevel(
  model: Model,
  effort: ThinkingEffort | undefined,
): GeminiThinkingLevel | undefined {
  if (effort === undefined || !model.supportsThinking) return undefined;
  if (effort === "xhigh" || effort === "max") return "high";
  return effort;
}

export function buildGeminiProviderOptions(model: Model, options: StreamOptions) {
  const thinkingLevel = resolveGeminiThinkingLevel(model, options.effort);
  if (thinkingLevel === undefined) return undefined;
  return {
    google: {
      thinkingConfig: {
        thinkingLevel,
        includeThoughts: true,
      },
    },
  };
}

export function buildGeminiTools(tools: ToolDefinition[]): ToolSet {
  const hasNativeWeb = tools.some(
    (definition) => definition.kind === "provider_builtin" && definition.capability === "web",
  );
  const compatibleTools = tools.map((definition): ToolDefinition => {
    if (definition.kind !== "function") return definition;
    // A root union is rejected whatever else the request carries, so it is folded away for every
    // schema. Size-driven simplification stays tied to native web tools, which are what push a
    // request over the schema budget.
    const flattened = flattenGeminiUnionSchema(definition.inputSchema);
    const compatible = hasNativeWeb ? normalizeGeminiToolSchema(flattened) : flattened;
    return { ...definition, inputSchema: asObjectJsonSchema(compatible) };
  });
  const result = convertToAISDKTools(compatibleTools);
  if (hasNativeWeb) {
    result.google_search = google.tools.googleSearch({});
    result.url_context = google.tools.urlContext({});
  }
  return result;
}

export function createGeminiStream(apiKey?: string, baseUrl?: string): StreamFunction {
  const provider = createGoogleGenerativeAI({
    apiKey: resolveGeminiApiKey(apiKey),
    ...(baseUrl ? { baseURL: baseUrl.replace(/\/+$/, "") } : {}),
  });

  return createAISDKStream({
    createLanguageModel: (model) => provider(model.modelId),
    classifyError: classifyGeminiError,
    buildTools: buildGeminiTools,
    buildProviderOptions: buildGeminiProviderOptions,
    // Latest Gemini models use provider-specific thinking levels instead of AI SDK reasoning.
    resolveReasoning: () => undefined,
    // Gemini 3.6 Flash and 3.5 Flash-Lite reject sampling parameters in future API generations.
    resolveTemperature: () => undefined,
    createProviderState: createGeminiProviderState,
    handleProviderPart: handleGeminiProviderPart,
    finalizeProviderState: finalizeGeminiProviderState,
  });
}

function createGeminiProviderState(): GeminiProviderState {
  return { blocksByKey: new Map(), sourceResults: new Map() };
}

export function handleGeminiProviderPart(part: TextStreamPart<ToolSet>, state: GeminiProviderState): ContentBlock[] {
  const candidates: ContentBlock[] = [];

  if (part.type === "tool-call" && part.providerExecuted) {
    const mappedName =
      part.toolName === "google_search" ? "web_search" : part.toolName === "url_context" ? "web_fetch" : undefined;
    if (mappedName) {
      candidates.push({
        type: "provider_tool_use",
        id: part.toolCallId,
        provider: "gemini",
        name: mappedName,
        input: toInputRecord(part.input),
      });
    }
  } else if (part.type === "source" && part.sourceType === "url") {
    state.sourceResults.set(part.id, {
      url: part.url,
      ...(part.title ? { title: part.title } : {}),
    });
  } else if (part.type === "finish-step") {
    candidates.push(...extractGeminiWebBlocks(toRecord(part.providerMetadata?.google)));
  }

  return addNewBlocks(state, candidates);
}

function finalizeGeminiProviderState(state: GeminiProviderState): ContentBlock[] {
  if (state.sourceResults.size === 0 || hasBlockType(state, "web_search_result")) return [];

  const existingUse = [...state.blocksByKey.values()].find(
    (block): block is ProviderToolUseBlock => block.type === "provider_tool_use" && block.name === "web_search",
  );
  const toolUseId = existingUse?.id ?? "gemini-web-search";
  const blocks: ContentBlock[] = [];
  if (!existingUse) {
    blocks.push({
      type: "provider_tool_use",
      id: toolUseId,
      provider: "gemini",
      name: "web_search",
      input: {},
    });
  }
  blocks.push({
    type: "web_search_result",
    toolUseId,
    provider: "gemini",
    results: [...state.sourceResults.values()],
  });
  return addNewBlocks(state, blocks);
}

export function extractGeminiWebBlocks(providerMetadata: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const grounding = toRecord(providerMetadata.groundingMetadata);
  const chunks = Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : [];
  const results = chunks.flatMap((rawChunk) => {
    const web = toRecord(toRecord(rawChunk).web);
    if (typeof web.uri !== "string" || web.uri.length === 0) return [];
    return [{ url: web.uri, ...(typeof web.title === "string" ? { title: web.title } : {}) }];
  });
  const queries = Array.isArray(grounding.webSearchQueries)
    ? grounding.webSearchQueries.filter((query): query is string => typeof query === "string")
    : [];
  if (results.length > 0 || queries.length > 0) {
    const toolUseId = "gemini-web-search";
    blocks.push(
      {
        type: "provider_tool_use",
        id: toolUseId,
        provider: "gemini",
        name: "web_search",
        input: queries.length > 0 ? { queries } : {},
      } satisfies ProviderToolUseBlock,
      {
        type: "web_search_result",
        toolUseId,
        provider: "gemini",
        results,
      } satisfies WebSearchResultBlock,
    );
  }

  const urlContext = toRecord(providerMetadata.urlContextMetadata);
  const urlMetadata = Array.isArray(urlContext.urlMetadata) ? urlContext.urlMetadata : [];
  if (urlMetadata.length > 0) {
    const toolUseId = "gemini-web-fetch";
    const urls = urlMetadata.flatMap((rawMetadata) => {
      const retrievedUrl = toRecord(rawMetadata).retrievedUrl;
      return typeof retrievedUrl === "string" ? [retrievedUrl] : [];
    });
    blocks.push({
      type: "provider_tool_use",
      id: toolUseId,
      provider: "gemini",
      name: "web_fetch",
      input: urls.length > 0 ? { urls } : {},
    });
    for (const rawMetadata of urlMetadata) {
      const metadata = toRecord(rawMetadata);
      const status = typeof metadata.urlRetrievalStatus === "string" ? metadata.urlRetrievalStatus : undefined;
      blocks.push({
        type: "web_fetch_result",
        toolUseId,
        provider: "gemini",
        url: typeof metadata.retrievedUrl === "string" ? metadata.retrievedUrl : "",
        ...(status && status !== "URL_RETRIEVAL_STATUS_SUCCESS" ? { error: { code: status } } : {}),
      });
    }
  }

  return blocks;
}

function addNewBlocks(state: GeminiProviderState, candidates: ContentBlock[]): ContentBlock[] {
  const added: ContentBlock[] = [];
  for (const block of candidates) {
    const key = geminiWebBlockKey(block);
    if (state.blocksByKey.has(key)) continue;
    state.blocksByKey.set(key, block);
    added.push(block);
  }
  return added;
}

function hasBlockType(state: GeminiProviderState, type: ContentBlock["type"]): boolean {
  return [...state.blocksByKey.values()].some((block) => block.type === type);
}

function geminiWebBlockKey(block: ContentBlock): string {
  if (block.type === "provider_tool_use") return `${block.type}:${block.id}`;
  if (block.type === "web_search_result") return `${block.type}:${block.toolUseId}`;
  if (block.type === "web_fetch_result") return `${block.type}:${block.toolUseId}:${block.url}`;
  return JSON.stringify(block);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toInputRecord(input: unknown): Record<string, unknown> {
  return toRecord(input);
}

function resolveGeminiApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("Gemini API key is required. Set GEMINI_API_KEY or pass apiKey to createGeminiStream().");
}

// TODO: Track actual inputTokens for proactive compaction (D-compact)
export function classifyGeminiError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error) {
    const record = err as unknown as Record<string, unknown>;
    const status =
      typeof record.statusCode === "number"
        ? record.statusCode
        : typeof record.status === "number"
          ? record.status
          : typeof record.code === "number"
            ? record.code
            : undefined;
    const httpError = classifyProviderHttpError({ message: err.message, status, cause: err });
    if (httpError) return httpError;
    if (isGeminiContextOverflow(err.message)) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, {
        errorType: ProviderErrorType.ContextOverflow,
        isRetryable: false,
        statusCode: status,
        cause: err,
        reason: ProviderErrorReason.ContextWindowExceeded,
      });
    }
    if (isNetworkError(err)) {
      return new ProviderError(err.message, ProviderErrorType.Network, true, undefined, undefined, err);
    }
    return new ProviderError(err.message, ProviderErrorType.Unknown, false, undefined, status, err);
  }
  return new ProviderError(String(err), ProviderErrorType.Unknown, false);
}

function isGeminiContextOverflow(message: string): boolean {
  return [/token count.*exceeds/i, /context.*too long/i, /input.*too long/i, /exceeds.*token limit/i].some((pattern) =>
    pattern.test(message),
  );
}
