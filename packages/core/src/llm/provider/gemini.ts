// @summary Gemini provider implementation with thinking support and content conversion
import type {
  Candidate,
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  Tool,
} from "@google/genai";
import { GoogleGenAI } from "@google/genai";
import { EventStream } from "../../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, ToolCallBlock, Usage } from "../../types";
import { isNetworkError } from "../errors";
import { materializeUserContentBlocks } from "../image-io";
import { flattenSections } from "../system-sections";
import type {
  FunctionToolDefinition,
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  ToolDefinition,
} from "../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError } from "../types";

type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;

const DEFAULT_GEMINI_THINKING_BUDGETS = { low: 2_048, medium: 8_192, high: 16_384, max: 24_576 };

export function resolveGeminiThinkingBudget(model: Model, effort: StreamOptions["effort"]): number | undefined {
  if (effort === undefined || !model.supportsThinking) return undefined;
  const budgetKey = effort === "none" ? "low" : effort === "xhigh" ? "max" : effort;
  return model.thinkingBudgets?.[budgetKey] ?? DEFAULT_GEMINI_THINKING_BUDGETS[budgetKey];
}

export function createGeminiStream(apiKey?: string, baseUrl?: string): StreamFunction {
  const resolvedApiKey = resolveGeminiApiKey(apiKey);
  const client = new GoogleGenAI({
    apiKey: resolvedApiKey,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
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

    (async () => {
      try {
        const effort = options.effort;
        const budgetTokens = resolveGeminiThinkingBudget(model, effort);
        const useThinking = budgetTokens !== undefined;

        const responseStream = await client.models.generateContentStream({
          model: model.id,
          contents: await convertToGeminiContents(context.messages, context.cwd),
          config: buildGeminiGenerateConfig(context, options, useThinking ? budgetTokens : undefined),
        });

        stream.push({ type: "start" });

        const textBlocks: ContentBlock[] = [];
        const toolCallBlocks: ToolCallBlock[] = [];
        const webBlocksById = new Map<string, ContentBlock>();
        let toolCallCounter = 0;
        let currentText = "";
        let currentThinking = "";
        let stopReason: StopReason = "end_turn";
        let usageMeta: GenerateContentResponseUsageMetadata | undefined;

        for await (const chunk of responseStream) {
          if (options.signal?.aborted) break;

          if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;

          const candidate = chunk.candidates?.[0];
          const finishReason = candidate?.finishReason;
          if (finishReason) {
            stopReason = mapGeminiStopReason(finishReason);
          }

          if (candidate) {
            for (const block of extractGeminiWebBlocks(candidate)) {
              if (webBlocksById.has(geminiWebBlockKey(block))) continue;
              webBlocksById.set(geminiWebBlockKey(block), block);
              stream.push({ type: "content_block", block });
            }
          }

          for (const part of candidate?.content?.parts ?? []) {
            if (part.thought && part.text) {
              stream.push({ type: "thinking_delta", delta: part.text });
              currentThinking += part.text;
            } else if (part.text) {
              stream.push({ type: "text_delta", delta: part.text });
              currentText += part.text;
            } else if (part.functionCall?.name) {
              const toolName = part.functionCall.name;
              const toolId = `gemini-${toolName}-${++toolCallCounter}`;
              const input = part.functionCall.args ?? {};
              const providerMetadata = toGeminiProviderMetadata(part);
              stream.push({ type: "tool_call_start", id: toolId, name: toolName });
              stream.push({ type: "tool_call_end", id: toolId, name: toolName, input });
              toolCallBlocks.push({
                type: "tool_call",
                id: toolId,
                name: toolName,
                input,
                ...(providerMetadata ? { providerMetadata } : {}),
              });
            }
          }
        }

        if (options.signal?.aborted) return;

        if (currentThinking) {
          stream.push({ type: "thinking_end", thinking: currentThinking });
          textBlocks.unshift({ type: "thinking", thinking: currentThinking });
        }
        if (currentText) {
          stream.push({ type: "text_end", text: currentText });
          textBlocks.push({ type: "text", text: currentText });
        }

        const contentBlocks: ContentBlock[] = [...textBlocks, ...webBlocksById.values(), ...toolCallBlocks];

        const usage: Usage = {
          inputTokens: usageMeta?.promptTokenCount ?? 0,
          outputTokens: usageMeta?.candidatesTokenCount ?? 0,
          cacheReadTokens: usageMeta?.cachedContentTokenCount ?? 0,
          cacheWriteTokens: 0,
        };

        stream.push({ type: "usage", usage });

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: contentBlocks,
          model: model.id,
          usage,
          stopReason,
          timestamp: Date.now(),
        };

        stream.push({ type: "done", stopReason, message: assistantMessage });
      } catch (err) {
        stream.push({ type: "error", error: classifyGeminiError(err) });
      }
    })();

    return stream;
  };
}

type GeminiRole = "user" | "model";
type GeminiContent = Content & { role: GeminiRole; parts: Part[] };
type GeminiProviderMetadata = { gemini: { thoughtSignature: string } };

export function buildGeminiGenerateConfig(
  context: StreamContext,
  options: StreamOptions,
  thinkingBudget?: number,
): GenerateContentConfig {
  const tools = context.tools.length > 0 ? convertToGeminiTools(context.tools) : undefined;
  return {
    ...(context.systemPrompt.length > 0 ? { systemInstruction: flattenSections(context.systemPrompt) } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(needsServerSideToolInvocations(context.tools)
      ? { toolConfig: { includeServerSideToolInvocations: true } }
      : {}),
    ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
  };
}

export async function convertToGeminiContents(messages: Message[], cwd?: string): Promise<GeminiContent[]> {
  const result: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const parts: Part[] =
        typeof msg.content === "string"
          ? [{ text: msg.content }]
          : (await materializeUserContentBlocks(msg.content, { cwd })).flatMap(convertUserContentBlockToGeminiPart);
      result.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: "" }] });
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_call") {
          parts.push({
            functionCall: { name: block.name, args: block.input },
            ...toGeminiThoughtSignaturePart(block.providerMetadata),
          });
        }
        // Skip thinking blocks — not needed in conversation history
      }
      if (parts.length > 0) {
        result.push({ role: "model", parts });
      }
    } else if (msg.role === "tool_result") {
      result.push({
        role: "user",
        parts: [{ functionResponse: { name: msg.toolName, response: { output: msg.output } } }],
      });
      // functionResponse cannot carry image bytes; attach any image content
      // as a follow-up user turn so the model can see it.
      if (msg.outputImages && msg.outputImages.length > 0) {
        const imageParts: Part[] = msg.outputImages.map((img) => ({
          inlineData: { mimeType: img.source.media_type, data: img.source.data },
        }));
        result.push({ role: "user", parts: imageParts });
      }
    }
  }

  return result;
}

function toGeminiThoughtSignaturePart(providerMetadata: Record<string, unknown> | undefined): {
  thoughtSignature?: string;
} {
  const geminiMetadata = providerMetadata?.gemini;
  if (!geminiMetadata || typeof geminiMetadata !== "object" || Array.isArray(geminiMetadata)) return {};
  const thoughtSignature = (geminiMetadata as Record<string, unknown>).thoughtSignature;
  return typeof thoughtSignature === "string" ? { thoughtSignature } : {};
}

function toGeminiProviderMetadata(part: Part): GeminiProviderMetadata | undefined {
  return part.thoughtSignature ? { gemini: { thoughtSignature: part.thoughtSignature } } : undefined;
}

function convertUserContentBlockToGeminiPart(block: ContentBlock): Part[] {
  if (block.type === "text") return [{ text: block.text }];
  if (block.type === "image") {
    return [
      {
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      },
    ];
  }
  if (block.type === "local_image") {
    throw new Error("local_image blocks must be materialized before Gemini conversion");
  }
  return [];
}

export function convertToGeminiTools(tools: ToolDefinition[]): Tool[] {
  const functionDeclarations = tools.flatMap((tool) => {
    if (tool.kind !== "function") return [];
    const t: FunctionToolDefinition = tool;
    return [
      {
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema({
          type: "object",
          ...t.inputSchema,
        }) as unknown as FunctionDeclaration["parameters"],
      },
    ];
  });

  const webTools = createGeminiWebTools(tools);
  return [...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []), ...webTools];
}

function createGeminiWebTools(tools: ToolDefinition[]): Tool[] {
  const hasWebTool = tools.some((tool) => tool.kind === "provider_builtin" && tool.capability === "web");
  if (!hasWebTool) return [];
  return [{ googleSearch: {} }, { urlContext: {} }];
}

function needsServerSideToolInvocations(tools: ToolDefinition[]): boolean {
  const hasWebTool = tools.some((tool) => tool.kind === "provider_builtin" && tool.capability === "web");
  const hasFunctionTool = tools.some((tool) => tool.kind === "function");
  return hasWebTool && hasFunctionTool;
}

export function extractGeminiWebBlocks(candidate: Candidate): ContentBlock[] {
  return [...extractGeminiSearchBlocks(candidate), ...extractGeminiFetchBlocks(candidate)];
}

function extractGeminiSearchBlocks(candidate: Candidate): ContentBlock[] {
  const groundingMetadata = candidate.groundingMetadata;
  const chunks = groundingMetadata?.groundingChunks ?? [];
  const results = chunks.flatMap((chunk) => {
    const web = chunk.web;
    if (!web?.uri) return [];
    return [
      {
        url: web.uri,
        ...(web.title ? { title: web.title } : {}),
      },
    ];
  });
  const queries = groundingMetadata?.webSearchQueries ?? [];
  if (results.length === 0 && queries.length === 0) return [];

  const toolUseId = "gemini-web-search";
  const toolUse: ProviderToolUseBlock = {
    type: "provider_tool_use",
    id: toolUseId,
    provider: "gemini",
    name: "web_search",
    input: queries.length > 0 ? { queries } : {},
  };
  const result: WebSearchResultBlock = {
    type: "web_search_result",
    toolUseId,
    provider: "gemini",
    results,
  };
  return [toolUse, result];
}

function extractGeminiFetchBlocks(candidate: Candidate): ContentBlock[] {
  const urlMetadata = candidate.urlContextMetadata?.urlMetadata ?? [];
  if (urlMetadata.length === 0) return [];

  const toolUseId = "gemini-web-fetch";
  const urls = urlMetadata.flatMap((metadata) => (metadata.retrievedUrl ? [metadata.retrievedUrl] : []));
  const blocks: ContentBlock[] = [
    {
      type: "provider_tool_use",
      id: toolUseId,
      provider: "gemini",
      name: "web_fetch",
      input: urls.length > 0 ? { urls } : {},
    },
  ];

  for (const metadata of urlMetadata) {
    const url = metadata.retrievedUrl ?? "";
    blocks.push({
      type: "web_fetch_result",
      toolUseId,
      provider: "gemini",
      url,
      ...(metadata.urlRetrievalStatus && metadata.urlRetrievalStatus !== "URL_RETRIEVAL_STATUS_SUCCESS"
        ? { error: { code: metadata.urlRetrievalStatus } }
        : {}),
    });
  }

  return blocks;
}

function geminiWebBlockKey(block: ContentBlock): string {
  if (block.type === "provider_tool_use") return `${block.type}:${block.id}`;
  if (block.type === "web_search_result") return `${block.type}:${block.toolUseId}`;
  if (block.type === "web_fetch_result") return `${block.type}:${block.toolUseId}:${block.url}`;
  return JSON.stringify(block);
}

const GEMINI_SCHEMA_KEYS = new Set([
  "anyOf",
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions = collectSchemaDefinitions(schema);
  return sanitizeGeminiSchema(schema, definitions, new Set());
}

function collectSchemaDefinitions(schema: Record<string, unknown>): Map<string, unknown> {
  const definitions = new Map<string, unknown>();
  for (const key of ["definitions", "$defs"]) {
    const container = schema[key];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const [name, value] of Object.entries(container as Record<string, unknown>)) {
      definitions.set(`#/${key}/${name}`, value);
    }
  }
  return definitions;
}

function sanitizeGeminiSchema(
  value: unknown,
  definitions: Map<string, unknown>,
  refStack: Set<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const source = value as Record<string, unknown>;
  const ref = source.$ref;
  if (typeof ref === "string") {
    const target = definitions.get(ref);
    if (target && !refStack.has(ref)) {
      const nextStack = new Set(refStack);
      nextStack.add(ref);
      const resolved = sanitizeGeminiSchema(target, definitions, nextStack);
      return sanitizeGeminiSchema({ ...resolved, ...withoutKey(source, "$ref") }, definitions, refStack);
    }
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (key === "$schema" || key === "$id" || key === "$defs" || key === "definitions") continue;

    if (key === "oneOf" || key === "allOf") {
      const normalized = sanitizeGeminiSchemaArray(raw, definitions, refStack);
      if (normalized.length > 0) result.anyOf = normalized;
      continue;
    }

    if (key === "type") {
      applyGeminiType(result, raw, definitions, refStack);
      continue;
    }

    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

    if (key === "properties") {
      const properties = sanitizeGeminiProperties(raw, definitions, refStack);
      if (Object.keys(properties).length > 0) result.properties = properties;
      continue;
    }

    if (key === "items") {
      result.items = sanitizeGeminiSchema(raw, definitions, refStack);
      continue;
    }

    if (key === "anyOf") {
      const anyOf = sanitizeGeminiSchemaArray(raw, definitions, refStack);
      if (anyOf.length > 0) result.anyOf = anyOf;
      continue;
    }

    result[key] = raw;
  }

  return result;
}

function sanitizeGeminiProperties(
  value: unknown,
  definitions: Map<string, unknown>,
  refStack: Set<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
    result[name] = sanitizeGeminiSchema(schema, definitions, refStack);
  }
  return result;
}

function sanitizeGeminiSchemaArray(
  value: unknown,
  definitions: Map<string, unknown>,
  refStack: Set<string>,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeGeminiSchema(item, definitions, refStack))
    .filter((item) => Object.keys(item).length > 0);
}

function applyGeminiType(
  result: Record<string, unknown>,
  value: unknown,
  definitions: Map<string, unknown>,
  refStack: Set<string>,
): void {
  if (typeof value === "string") {
    result.type = value;
    return;
  }
  if (!Array.isArray(value)) return;

  const types = value.filter((item): item is string => typeof item === "string");
  if (types.includes("null")) result.nullable = true;
  const nonNullTypes = types.filter((item) => item !== "null");
  if (nonNullTypes.length === 1) {
    result.type = nonNullTypes[0];
  } else if (nonNullTypes.length > 1) {
    result.anyOf = nonNullTypes.map((type) => sanitizeGeminiSchema({ type }, definitions, refStack));
  }
}

function withoutKey(source: Record<string, unknown>, keyToRemove: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== keyToRemove) result[key] = value;
  }
  return result;
}

function resolveGeminiApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("Gemini API key is required. Set GEMINI_API_KEY or pass apiKey to createGeminiStream().");
}

function mapGeminiStopReason(finishReason: string): StopReason {
  switch (finishReason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "error";
    default:
      return "end_turn";
  }
}

// TODO: Track actual inputTokens for proactive compaction (D-compact)
export function classifyGeminiError(err: unknown): ProviderError {
  if (err instanceof Error) {
    const msg = err.message;
    const errObj = err as unknown as Record<string, unknown>;
    const httpStatus = (errObj.status as number | undefined) ?? (errObj.code as number | undefined);

    if (httpStatus === 429) {
      return new ProviderError(msg, "rate_limit", false, undefined, httpStatus, err);
    }
    if (httpStatus !== undefined && httpStatus >= 500) {
      return new ProviderError(msg, "server_error", true, undefined, httpStatus, err);
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return new ProviderError(msg, "auth", false, undefined, httpStatus, err);
    }
    if (isGeminiContextOverflow(msg)) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, "context_overflow", false, undefined, httpStatus, err);
    }
    if (isNetworkError(err)) {
      return new ProviderError(msg, "network", true, undefined, undefined, err);
    }
    return new ProviderError(msg, "unknown", false, undefined, httpStatus, err);
  }
  return new ProviderError(String(err), "unknown", false);
}

function isGeminiContextOverflow(message: string): boolean {
  const patterns = [/token count.*exceeds/i, /context.*too long/i, /input.*too long/i, /exceeds.*token limit/i];
  return patterns.some((p) => p.test(message));
}
