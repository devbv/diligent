// @summary Shared OpenAI-compatible Chat Completions utilities for non-Responses providers
import type { EventStream } from "../../../event-stream";
import type { Message, StopReason, Usage } from "../../../types";
import { type LocalImageLoader, materializeUserContentBlocks } from "../../image-io";
import type { FunctionToolDefinition, Model, ProviderEvent, ProviderResult, ToolDefinition } from "../../types";
import { OpenAIContentAccumulator } from "../openai/content-accumulator";

type OpenAICompatibleContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type OpenAICompatibleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAICompatibleContentPart[] | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type OpenAICompatibleTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export async function buildOpenAICompatibleMessages(
  messages: Message[],
  localImageLoader?: LocalImageLoader,
): Promise<OpenAICompatibleMessage[]> {
  const result: OpenAICompatibleMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      const blocks = await materializeUserContentBlocks(msg.content, { loader: localImageLoader });
      const content: OpenAICompatibleContentPart[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          content.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      result.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const text = msg.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const toolCalls = msg.content
        .filter((block) => block.type === "tool_call")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        }));

      if (text.length > 0 || toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    result.push({
      role: "tool",
      tool_call_id: msg.toolCallId,
      name: msg.toolName,
      content: msg.output,
    });
    // Chat Completions' tool role is text-only; attach any image content as a
    // follow-up user message so the model can actually see it.
    if (msg.outputImages && msg.outputImages.length > 0) {
      const imageContent: OpenAICompatibleContentPart[] = msg.outputImages.map((img) => ({
        type: "image_url",
        image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
      }));
      result.push({ role: "user", content: imageContent });
    }
  }

  return result;
}

export function buildOpenAICompatibleTools(tools: ToolDefinition[]): OpenAICompatibleTool[] {
  return tools.flatMap((tool) => {
    if (tool.kind !== "function") return [];
    const functionTool: FunctionToolDefinition = tool;
    return [
      {
        type: "function" as const,
        function: {
          name: functionTool.name,
          description: functionTool.description,
          parameters: { type: "object", ...functionTool.inputSchema },
        },
      },
    ];
  });
}

export function mapChatCompletionsStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "error";
    default:
      return "end_turn";
  }
}

export function mapChatCompletionsUsage(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined,
): Usage {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cachedTokens),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
  };
}

function parseChatCompletionsToolArguments(argumentsText: string): Record<string, unknown> {
  if (argumentsText.trim().length === 0) return {};
  try {
    return JSON.parse(argumentsText) as Record<string, unknown>;
  } catch {
    return { _raw: argumentsText };
  }
}

export async function handleChatCompletionsEvents(
  events: AsyncIterable<Record<string, unknown>>,
  stream: EventStream<ProviderEvent, ProviderResult>,
  model: Model,
  signal?: AbortSignal,
): Promise<void> {
  const accumulator = new OpenAIContentAccumulator();
  const emit = (eventsToEmit: ProviderEvent[]) => {
    for (const event of eventsToEmit) stream.push(event);
  };

  for await (const payload of events) {
    if (signal?.aborted) {
      accumulator.abort();
      return;
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const rawUsage = payload.usage;
    if (rawUsage && typeof rawUsage === "object") {
      accumulator.setUsage(mapChatCompletionsUsage(rawUsage as { prompt_tokens?: number; completion_tokens?: number }));
    }

    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== "object") continue;
      const choice = rawChoice as Record<string, unknown>;
      const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      if (finishReason) accumulator.setStopReason(mapChatCompletionsStopReason(finishReason));

      const delta = choice.delta;
      if (!delta || typeof delta !== "object") continue;
      const deltaRecord = delta as Record<string, unknown>;

      if (typeof deltaRecord.reasoning_content === "string" && deltaRecord.reasoning_content.length > 0) {
        emit(accumulator.appendThinkingDelta(deltaRecord.reasoning_content));
      }

      if (typeof deltaRecord.content === "string" && deltaRecord.content.length > 0) {
        emit(accumulator.flushThinking());
        emit(accumulator.appendTextDelta(deltaRecord.content));
      }

      const toolCalls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
      for (const rawToolCall of toolCalls) {
        if (!rawToolCall || typeof rawToolCall !== "object") continue;
        const toolCall = rawToolCall as Record<string, unknown>;
        const index = typeof toolCall.index === "number" ? toolCall.index : 0;
        const functionPart = toolCall.function;
        let name: string | undefined;
        let argumentsDelta: string | undefined;
        if (functionPart && typeof functionPart === "object") {
          const fn = functionPart as Record<string, unknown>;
          if (typeof fn.name === "string" && fn.name.length > 0) name = fn.name;
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) argumentsDelta = fn.arguments;
        }
        const key = `tool-${index}`;
        emit(
          accumulator.upsertToolCall(key, {
            ...(typeof toolCall.id === "string" && toolCall.id.length > 0 ? { id: toolCall.id } : {}),
            ...(name ? { name } : {}),
            order: index,
          }),
        );
        if (argumentsDelta) emit(accumulator.appendToolArguments(key, argumentsDelta));
      }
    }
  }

  if (signal?.aborted) {
    accumulator.abort();
    return;
  }

  const finalization = accumulator.finalize({
    modelId: model.id,
    finalizePendingTools: true,
    parseToolArguments: parseChatCompletionsToolArguments,
  });
  if (finalization) emit(finalization.events);
}
