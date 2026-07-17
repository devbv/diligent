// @summary Anthropic message conversion, replay filtering, coalescing, and cache breakpoints
import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message } from "../../../types";
import { type LocalImageLoader, materializeUserContentBlocks } from "../../image-io";

type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;
type WebFetchResultBlock = Extract<ContentBlock, { type: "web_fetch_result" }>;

export interface ConvertedAnthropicMessage {
  message: Anthropic.MessageParam;
  coalesceWithPreviousUser: boolean;
}

export async function convertMessages(
  messages: Message[],
  compactionSummary?: Record<string, unknown>,
  localImageLoader?: LocalImageLoader,
): Promise<Anthropic.MessageParam[]> {
  let result = buildAnthropicCompactionPrefix(compactionSummary);

  for (const message of messages) {
    const converted = await convertAnthropicMessage(message, localImageLoader);
    result = appendAnthropicConvertedMessage(result, converted);
  }

  return applyAnthropicLastUserCacheBreakpoint(result);
}

export function buildAnthropicCompactionPrefix(compactionSummary?: Record<string, unknown>): Anthropic.MessageParam[] {
  if (!isRecord(compactionSummary) || compactionSummary.type !== "compaction") return [];
  const content = typeof compactionSummary.content === "string" ? compactionSummary.content.trim() : "";
  if (!content) return [];
  return [
    {
      role: "user",
      content: [{ type: "text", text: content }],
    },
  ];
}

export async function convertAnthropicMessage(
  message: Message,
  localImageLoader?: LocalImageLoader,
): Promise<ConvertedAnthropicMessage> {
  if (message.role === "user") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : (
            await materializeUserContentBlocks(message.content, {
              loader: localImageLoader,
            })
          ).map(convertContentBlock);
    return {
      message: { role: "user", content },
      coalesceWithPreviousUser: false,
    };
  }

  if (message.role === "assistant") {
    return {
      message: {
        role: "assistant",
        content: message.content.flatMap((block) => {
          const converted = convertAssistantContentBlock(block);
          return converted ? [converted] : [];
        }),
      },
      coalesceWithPreviousUser: false,
    };
  }

  const hasImages = (message.outputImages?.length ?? 0) > 0;
  const toolResultBlock: Anthropic.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content: hasImages
      ? [
          ...(message.output ? [{ type: "text" as const, text: message.output }] : []),
          ...(message.outputImages ?? []).map(
            (image): Anthropic.ImageBlockParam => ({
              type: "image",
              source: {
                type: "base64",
                media_type: image.source.media_type as Anthropic.Base64ImageSource["media_type"],
                data: image.source.data,
              },
            }),
          ),
        ]
      : message.output,
    is_error: message.isError,
  };
  return {
    message: { role: "user", content: [toolResultBlock] },
    coalesceWithPreviousUser: true,
  };
}

export function appendAnthropicConvertedMessage(
  messages: Anthropic.MessageParam[],
  converted: ConvertedAnthropicMessage,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (
    converted.coalesceWithPreviousUser &&
    last?.role === "user" &&
    Array.isArray(last.content) &&
    Array.isArray(converted.message.content)
  ) {
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        content: [...last.content, ...converted.message.content],
      },
    ];
  }
  return [...messages, converted.message];
}

export function applyAnthropicLastUserCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) continue;
    const content = message.content;
    const lastBlock = content[content.length - 1] as unknown as Record<string, unknown>;
    return [
      ...messages.slice(0, index),
      {
        ...message,
        content: [
          ...content.slice(0, -1),
          {
            ...lastBlock,
            cache_control: { type: "ephemeral" },
          } as Anthropic.ContentBlockParam,
        ],
      },
      ...messages.slice(index + 1),
    ];
  }
  return messages;
}
export function ensureAnthropicCompactionConversationEndsWithUser(
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

  return messages.slice(0, lastUserIndex + 1);
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
    case "thinking":
      // Thinking blocks from other providers never carry an Anthropic signature.
      // Replaying them verbatim after a model switch would make every future turn
      // in this thread fail with "thinking blocks require signature". Drop them
      // instead, matching how foreign provider_tool_use blocks are omitted.
      if (!block.signature) return undefined;
      return convertContentBlock(block);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
