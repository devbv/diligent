import Anthropic from "@anthropic-ai/sdk";
import { EventStream } from "../event-stream";
import type {
  StreamFunction,
  StreamContext,
  StreamOptions,
  Model,
  ProviderEvent,
  ProviderResult,
  ToolDefinition,
} from "./types";
import { ProviderError } from "./types";
import type {
  Message,
  AssistantMessage,
  ContentBlock,
  Usage,
  StopReason,
} from "../types";

export const createAnthropicStream: StreamFunction = (
  model: Model,
  context: StreamContext,
  options: StreamOptions,
): EventStream<ProviderEvent, ProviderResult> => {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );

  const client = new Anthropic({ apiKey: options.apiKey });

  (async () => {
    try {
      const sdkStream = client.messages.stream(
        {
          model: model.id,
          max_tokens: options.maxTokens ?? model.maxOutputTokens,
          system: context.systemPrompt,
          messages: convertMessages(context.messages),
          ...(context.tools.length > 0 && { tools: convertTools(context.tools) }),
          ...(options.temperature !== undefined && { temperature: options.temperature }),
        },
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
        } else if (block.type === "tool_use") {
          stream.push({
            type: "tool_call_end",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
          activeToolId = undefined;
        }
      });

      sdkStream.on("streamEvent", (event) => {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          activeToolId = event.content_block.id;
          stream.push({ type: "tool_call_start", id: event.content_block.id, name: event.content_block.name });
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

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        result.push({
          role: "user",
          content: msg.content.map(convertContentBlock),
        });
      }
    } else if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: msg.content.map(convertContentBlock),
      });
    } else if (msg.role === "tool_result") {
      // Tool results go into a user message with tool_result blocks
      // Check if previous result entry is already a user message we can append to
      const last = result[result.length - 1];
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.output,
        is_error: msg.isError,
      };

      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
      } else {
        result.push({ role: "user", content: [toolResultBlock] });
      }
    }
  }

  return result;
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
    case "thinking":
      // Thinking blocks are not sent back to the API
      return { type: "text", text: "" };
    case "tool_call":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
  }
}

function convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      ...t.inputSchema,
    },
  }));
}

function mapToAssistantMessage(
  msg: Anthropic.Message,
  model: Model,
): AssistantMessage {
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
      return { type: "thinking", thinking: block.thinking };
    }
    return { type: "text", text: "" };
  });

  const usage: Usage = {
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: (msg.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
    cacheWriteTokens: (msg.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
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
    case "end_turn": return "end_turn";
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    default: return "end_turn";
  }
}

export function classifyAnthropicError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers as Record<string, string> | undefined);
      return new ProviderError(err.message, "rate_limit", true, retryAfter, status, err);
    }
    if (status === 529) {
      return new ProviderError(err.message, "overloaded", true, undefined, status, err);
    }
    if (status === 400 && err.message.includes("context length")) {
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
  return new ProviderError(
    err instanceof Error ? err.message : String(err),
    "unknown",
    false,
    undefined,
    undefined,
    err instanceof Error ? err : undefined,
  );
}

function parseRetryAfter(headers?: Record<string, string>): number | undefined {
  if (!headers) return undefined;
  const ms = headers["retry-after-ms"];
  if (ms) return parseInt(ms, 10);
  const s = headers["retry-after"];
  if (s) return parseInt(s, 10) * 1000;
  return undefined;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network");
}
