// @summary Anthropic provider implementation with thinking, streaming, and message conversion
import Anthropic from "@anthropic-ai/sdk";
import { EventStream } from "../../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, Usage } from "../../types";
import { isNetworkError } from "../errors";
import { materializeUserContentBlocks } from "../image-io";
import type {
  FunctionToolDefinition,
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  SystemSection,
  ToolDefinition,
} from "../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError } from "../types";
import type { NativeCompactFn } from "./native-compaction";

type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;
type WebFetchResultBlock = Extract<ContentBlock, { type: "web_fetch_result" }>;

export function createAnthropicStream(apiKey?: string, baseUrl?: string): StreamFunction {
  const resolvedApiKey = resolveAnthropicApiKey(apiKey);
  const resolvedSdkBaseUrl = resolveAnthropicSdkBaseUrl(baseUrl);
  const debugEndpoint = `${resolvedSdkBaseUrl.replace(/\/+$/, "")}/v1/messages`;
  const client = new Anthropic({ apiKey: resolvedApiKey, baseURL: resolvedSdkBaseUrl });

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
        const effortProvided = effort !== undefined;

        let thinkingConfig: Record<string, unknown>;
        if (effortProvided && model.supportsThinking && model.supportsAdaptiveThinking) {
          thinkingConfig = {
            thinking: { type: "adaptive" } as Anthropic.ThinkingConfigParam,
            output_config: { effort },
            temperature: 1,
          };
        } else if (effortProvided && model.supportsThinking && !model.supportsAdaptiveThinking) {
          const budgetKey = effort === "none" ? "low" : effort;
          const budgetTokens = model.thinkingBudgets?.[budgetKey] ?? model.defaultBudgetTokens ?? 8_000;
          thinkingConfig = {
            thinking: { type: "enabled", budget_tokens: budgetTokens } as Anthropic.ThinkingConfigParam,
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
          messages: await convertMessages(context.messages, context.cwd, context.compactionSummary),
          ...(context.tools.length > 0 && { tools: convertTools(context.tools) }),
          ...thinkingConfig,
        } as Anthropic.MessageCreateParams;

        if (context.compactionSummary) {
        }

        if (process.env.ANTHROPIC_DEBUG_REQUEST === "1") {
          console.error("[anthropic.endpoint]", debugEndpoint);
          console.error("[anthropic.request]", JSON.stringify(requestParams, null, 2));
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
            stream.push({ type: "tool_call_delta", id: activeToolId, delta: partialJson });
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
              stream.push({ type: "tool_call_start", id: event.content_block.id, name: event.content_block.name });
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

    return stream;
  };
}

export async function convertMessages(
  messages: Message[],
  cwdOrCompactionSummary?: string | Record<string, unknown>,
  compactionSummary?: Record<string, unknown>,
): Promise<Anthropic.MessageParam[]> {
  const cwd = typeof cwdOrCompactionSummary === "string" ? cwdOrCompactionSummary : undefined;
  const effectiveCompactionSummary =
    typeof cwdOrCompactionSummary === "string" ? compactionSummary : (cwdOrCompactionSummary ?? compactionSummary);
  const result: Anthropic.MessageParam[] = [];

  const compactedUserMessage = toAnthropicCompactionUserMessage(effectiveCompactionSummary);
  if (compactedUserMessage) {
    result.push(compactedUserMessage);
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      const blocks =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : (await materializeUserContentBlocks(msg.content, { cwd })).map(convertContentBlock);
      result.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: msg.content.flatMap((block) => {
          const converted = convertAssistantContentBlock(block);
          return converted ? [converted] : [];
        }),
      });
    } else if (msg.role === "tool_result") {
      // Tool results go into a user message with tool_result blocks
      // Check if previous result entry is already a user message we can append to
      const last = result[result.length - 1];
      const hasImages = (msg.outputImages?.length ?? 0) > 0;
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: hasImages
          ? [
              // Anthropic rejects empty text blocks — omit when output is empty.
              ...(msg.output ? [{ type: "text" as const, text: msg.output }] : []),
              ...(msg.outputImages ?? []).map(
                (img): Anthropic.ImageBlockParam => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.source.media_type as Anthropic.Base64ImageSource["media_type"],
                    data: img.source.data,
                  },
                }),
              ),
            ]
          : msg.output,
        is_error: msg.isError,
      };

      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
      } else {
        result.push({ role: "user", content: [toolResultBlock] });
      }
    }
  }

  // Cache breakpoint on last user message (text or tool_result) so the entire
  // conversation prefix is cached and any fork from this point gets a cache hit.
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
    (msg.content[msg.content.length - 1] as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" };
    break;
  }

  return result;
}

function toAnthropicCompactionUserMessage(
  compactionSummary?: Record<string, unknown>,
): Anthropic.MessageParam | undefined {
  if (!isRecord(compactionSummary)) return undefined;
  if (compactionSummary.type !== "compaction") return undefined;
  const content = typeof compactionSummary.content === "string" ? compactionSummary.content.trim() : "";
  if (!content) return undefined;
  return {
    role: "user",
    content: [{ type: "text", text: content }],
  };
}

function ensureAnthropicCompactionConversationEndsWithUser(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) {
    return [];
  }

  const normalized = messages.slice(0, lastUserIndex + 1);
  if (lastUserIndex !== messages.length - 1) {
  }
  return normalized;
}

function convertContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.source.media_type as Anthropic.Base64ImageSource["media_type"],
          data: block.source.data,
        },
      };
    case "local_image":
      throw new Error("local_image blocks must be materialized before Anthropic conversion");
    case "thinking":
      if (!block.signature) {
        throw new Error("Anthropic thinking blocks require signature");
      }
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      };
    case "tool_call":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    default:
      throw new Error(`Unsupported content block for Anthropic conversion: ${block.type}`);
  }
}

function convertAssistantContentBlock(block: ContentBlock): Anthropic.ContentBlockParam | undefined {
  switch (block.type) {
    case "provider_tool_use":
      return convertProviderToolUseBlock(block);
    case "web_search_result":
      return convertWebSearchResultBlock(block);
    case "web_fetch_result":
      return convertWebFetchResultBlock(block);
    default:
      return convertContentBlock(block);
  }
}

function convertProviderToolUseBlock(block: ProviderToolUseBlock): Anthropic.ContentBlockParam | undefined {
  if (block.provider !== "anthropic") return undefined;
  return {
    type: "server_tool_use",
    id: block.id,
    name: block.name,
    input: block.input,
  } as Anthropic.ServerToolUseBlockParam;
}

function convertWebSearchResultBlock(block: WebSearchResultBlock): Anthropic.ContentBlockParam | undefined {
  if (block.provider !== "anthropic") return undefined;
  return {
    type: "web_search_tool_result",
    tool_use_id: block.toolUseId,
    caller: { type: "direct" },
    content: block.error
      ? {
          type: "web_search_tool_result_error",
          error_code: block.error.code as Anthropic.WebSearchToolResultErrorCode,
        }
      : block.results.flatMap((result): Anthropic.WebSearchResultBlockParam[] => {
          if (!result.encryptedContent) return [];
          return [
            {
              type: "web_search_result",
              url: result.url,
              title: result.title ?? result.url,
              encrypted_content: result.encryptedContent,
              ...(result.pageAge ? { page_age: result.pageAge } : {}),
            },
          ];
        }),
  } as Anthropic.WebSearchToolResultBlockParam;
}

function convertWebFetchResultBlock(block: WebFetchResultBlock): Anthropic.ContentBlockParam | undefined {
  if (block.provider !== "anthropic") return undefined;
  return {
    type: "web_fetch_tool_result",
    tool_use_id: block.toolUseId,
    caller: { type: "direct" },
    content: block.error
      ? {
          type: "web_fetch_tool_result_error",
          error_code: block.error.code as Anthropic.WebFetchToolResultErrorCode,
        }
      : {
          type: "web_fetch_result",
          url: block.url,
          ...(block.retrievedAt ? { retrieved_at: block.retrievedAt } : {}),
          content: toAnthropicFetchDocument(block.document),
        },
  } as Anthropic.WebFetchToolResultBlockParam;
}

function toAnthropicFetchDocument(document: WebFetchResultBlock["document"]): Anthropic.DocumentBlockParam {
  return {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      data: document?.text ?? "",
    },
    ...(document?.title ? { title: document.title } : {}),
    ...(document?.citationsEnabled !== undefined ? { citations: { enabled: document.citationsEnabled } } : {}),
  };
}

function convertTools(tools: ToolDefinition[]): Anthropic.MessageCreateParams["tools"] {
  return tools.flatMap((tool) => {
    if (tool.kind === "provider_builtin" && tool.capability === "web") {
      return [createAnthropicWebTool(tool)];
    }
    if (tool.kind !== "function") return [];
    const t: FunctionToolDefinition = tool;
    return [
      {
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object" as const,
          ...t.inputSchema,
        },
      },
    ];
  });
}

function createAnthropicWebTool(tool: Extract<ToolDefinition, { kind: "provider_builtin" }>): Anthropic.Tool {
  const options = tool.options;
  const hasFetchSettings = Boolean(options?.maxContentTokens);
  const webToolType = hasFetchSettings ? "web_fetch_20260209" : "web_search_20260209";
  const userLocation = options?.userLocation;

  return {
    type: webToolType,
    name: hasFetchSettings ? "web_fetch" : "web_search",
    allowed_callers: ["direct"],
    ...(options?.maxUses !== undefined ? { max_uses: options.maxUses } : {}),
    ...(options?.allowedDomains?.length ? { allowed_domains: options.allowedDomains } : {}),
    ...(options?.blockedDomains?.length ? { blocked_domains: options.blockedDomains } : {}),
    ...(userLocation ? { user_location: toAnthropicUserLocation(userLocation) } : {}),
    ...(hasFetchSettings ? { max_content_tokens: options?.maxContentTokens } : {}),
  } as unknown as Anthropic.Tool;
}

function mapToAssistantMessage(msg: Anthropic.Message, model: Model): AssistantMessage {
  const content: ContentBlock[] = msg.content.map((block): ContentBlock => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    } else if (block.type === "tool_use") {
      return {
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    } else if (block.type === "thinking") {
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
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

function extractAnthropicCompactionSummary(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const rawBlock of content) {
    if (!isRecord(rawBlock)) continue;
    if (rawBlock.type !== "compaction") continue;
    if (typeof rawBlock.content !== "string" || !rawBlock.content.trim()) continue;

    const block: Record<string, unknown> = {
      type: "compaction",
      content: rawBlock.content,
    };
    if (isRecord(rawBlock.cache_control)) {
      block.cache_control = rawBlock.cache_control;
    }
    return block;
  }
  return undefined;
}

// TODO: Track actual inputTokens for proactive compaction (D-compact)
export function classifyAnthropicError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers);
      return new ProviderError(err.message, "rate_limit", false, retryAfter, status, err);
    }
    if (status >= 500) {
      return new ProviderError(err.message, "server_error", true, undefined, status, err);
    }
    if (status === 400 && err.message.includes("context length")) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, "context_overflow", false, undefined, status, err);
    }
    if (status === 401 || status === 403) {
      return new ProviderError(err.message, "auth", false, undefined, status, err);
    }
    return new ProviderError(err.message, "unknown", false, undefined, status, err);
  }
  if (isNetworkError(err)) {
    return new ProviderError(String(err), "network", true);
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

function resolveAnthropicBaseUrl(baseUrl?: string): string {
  const resolved = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return resolved.endsWith("/v1") ? resolved : `${resolved}/v1`;
}

function resolveAnthropicApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error("Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey to createAnthropicStream().");
}

function resolveAnthropicSdkBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
}

function toAnthropicUserLocation(
  location: NonNullable<NonNullable<Extract<ToolDefinition, { kind: "provider_builtin" }>["options"]>["userLocation"]>,
) {
  return {
    type: location.type,
    ...(location.city ? { city: location.city } : {}),
    ...(location.region ? { region: location.region } : {}),
    ...(location.country ? { country: location.country } : {}),
    ...(location.timezone ? { timezone: location.timezone } : {}),
  };
}

function createProviderToolUseBlock(block: Anthropic.ServerToolUseBlock): ProviderToolUseBlock | undefined {
  if (block.name !== "web_search" && block.name !== "web_fetch") return undefined;
  return {
    type: "provider_tool_use",
    id: block.id,
    provider: "anthropic",
    name: block.name,
    input: isRecord(block.input) ? block.input : {},
  };
}

function createWebSearchResultBlock(block: Anthropic.WebSearchToolResultBlock): WebSearchResultBlock {
  if (!Array.isArray(block.content)) {
    return {
      type: "web_search_result",
      toolUseId: block.tool_use_id,
      provider: "anthropic",
      results: [],
      error: { code: block.content.error_code },
    };
  }

  return {
    type: "web_search_result",
    toolUseId: block.tool_use_id,
    provider: "anthropic",
    results: block.content.map((result) => ({
      url: result.url,
      title: result.title,
      ...(result.page_age ? { pageAge: result.page_age } : {}),
      ...(result.encrypted_content ? { encryptedContent: result.encrypted_content } : {}),
    })),
  };
}

function createWebFetchResultBlock(block: Anthropic.WebFetchToolResultBlock): WebFetchResultBlock {
  if (block.content.type === "web_fetch_tool_result_error") {
    return {
      type: "web_fetch_result",
      toolUseId: block.tool_use_id,
      provider: "anthropic",
      url: "",
      error: { code: block.content.error_code },
    };
  }

  return {
    type: "web_fetch_result",
    toolUseId: block.tool_use_id,
    provider: "anthropic",
    url: block.content.url,
    document: {
      mimeType: block.content.content.source.media_type,
      ...(extractFetchText(block.content) ? { text: extractFetchText(block.content) } : {}),
      ...(block.content.content.title ? { title: block.content.content.title } : {}),
      citationsEnabled: true,
    },
    ...(block.content.retrieved_at ? { retrievedAt: block.content.retrieved_at } : {}),
  };
}

function extractFetchText(block: Anthropic.WebFetchBlock): string | undefined {
  const source = block.content.source;
  if (source.type === "text") {
    return source.data;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function toAnthropicBlocks(sections: SystemSection[]): AnthropicTextBlock[] {
  return sections.map((s) => {
    let text: string;
    if (!s.tag) {
      text = s.content;
    } else {
      const attrs = s.tagAttributes
        ? Object.entries(s.tagAttributes)
            .map(([k, v]) => ` ${k}="${v}"`)
            .join("")
        : "";
      text = `<${s.tag}${attrs}>\n${s.content}\n</${s.tag}>`;
    }
    const block: AnthropicTextBlock = { type: "text", text };
    if (s.cacheControl === "ephemeral") {
      block.cache_control = { type: "ephemeral" };
    }
    return block;
  });
}

export function createAnthropicNativeCompaction(apiKey: string, baseUrl?: string): NativeCompactFn {
  const endpoint = `${resolveAnthropicBaseUrl(baseUrl)}/messages`;
  return async (input) => {
    const rawMessages = await convertMessages(input.messages, input.cwd, input.compactionSummary);
    const normalizedMessages = ensureAnthropicCompactionConversationEndsWithUser(rawMessages);
    const body: Record<string, unknown> = {
      model: input.model.id,
      max_tokens: Math.max(256, Math.min(input.model.maxOutputTokens, 4_096)),
      messages: normalizedMessages,
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 50_000 },
            pause_after_compaction: true,
          },
        ],
      },
    };
    if (input.systemPrompt.length > 0) body.system = toAnthropicBlocks(input.systemPrompt);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "compact-2026-01-12",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const errorDetails = await readErrorBody(response);
      if (response.status === 400 || response.status === 404 || response.status === 405 || response.status === 422) {
        return {
          status: "unsupported",
          reason: errorDetails ? `status_${response.status} ${errorDetails}` : `status_${response.status}`,
        };
      }
      throw new Error(
        errorDetails
          ? `Anthropic native compaction failed (${response.status}) ${errorDetails}`
          : `Anthropic native compaction failed (${response.status})`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const compactionSummary = extractAnthropicCompactionSummary(payload.content);
    const summary = typeof compactionSummary?.content === "string" ? compactionSummary.content : undefined;
    const stopReason = typeof payload.stop_reason === "string" ? payload.stop_reason : undefined;
    const payloadKeys = Object.keys(payload).slice(0, 8).join(",") || "none";
    if (!summary?.trim() || !compactionSummary) {
      return {
        status: "unsupported",
        reason: `missing_compaction_block stop_reason=${stopReason ?? "-"} payload_keys=${payloadKeys}`,
      };
    }
    return { status: "ok", summary, compactionSummary };
  };
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      return JSON.stringify(payload);
    } catch {
      return undefined;
    }
  }

  try {
    const text = (await response.text()).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
