// @summary Shared OpenAI-compatible Chat Completions utilities for non-Responses providers
import type { EventStream } from "../../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, Usage } from "../../types";
import { materializeUserContentBlocks } from "../image-io";
import type { FunctionToolDefinition, Model, ProviderEvent, ProviderResult, ToolDefinition } from "../types";

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
  cwd?: string,
): Promise<OpenAICompatibleMessage[]> {
  const result: OpenAICompatibleMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      const blocks = await materializeUserContentBlocks(msg.content, { cwd });
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

export async function handleChatCompletionsEvents(
  events: AsyncIterable<Record<string, unknown>>,
  stream: EventStream<ProviderEvent, ProviderResult>,
  model: Model,
  signal?: AbortSignal,
): Promise<void> {
  const contentBlocks: ContentBlock[] = [];
  const toolState = new Map<number, { id: string; name: string; arguments: string; started: boolean }>();
  let currentText = "";
  let currentThinking = "";
  let thinkingEnded = false;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const payload of events) {
    if (signal?.aborted) return;

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const rawUsage = payload.usage;
    if (rawUsage && typeof rawUsage === "object") {
      usage = mapChatCompletionsUsage(rawUsage as { prompt_tokens?: number; completion_tokens?: number });
    }

    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== "object") continue;
      const choice = rawChoice as Record<string, unknown>;
      const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      if (finishReason) stopReason = mapChatCompletionsStopReason(finishReason);

      const delta = choice.delta;
      if (!delta || typeof delta !== "object") continue;
      const deltaRecord = delta as Record<string, unknown>;

      if (typeof deltaRecord.reasoning_content === "string" && deltaRecord.reasoning_content.length > 0) {
        currentThinking += deltaRecord.reasoning_content;
        stream.push({ type: "thinking_delta", delta: deltaRecord.reasoning_content });
      }

      if (typeof deltaRecord.content === "string" && deltaRecord.content.length > 0) {
        if (currentThinking.length > 0 && !thinkingEnded) {
          stream.push({ type: "thinking_end", thinking: currentThinking });
          contentBlocks.push({ type: "thinking", thinking: currentThinking });
          thinkingEnded = true;
        }
        currentText += deltaRecord.content;
        stream.push({ type: "text_delta", delta: deltaRecord.content });
      }

      const toolCalls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
      for (const rawToolCall of toolCalls) {
        if (!rawToolCall || typeof rawToolCall !== "object") continue;
        const toolCall = rawToolCall as Record<string, unknown>;
        const index = typeof toolCall.index === "number" ? toolCall.index : 0;
        const existing = toolState.get(index) ?? {
          id: typeof toolCall.id === "string" ? toolCall.id : `tool-${index}`,
          name: "unknown_tool",
          arguments: "",
          started: false,
        };
        if (typeof toolCall.id === "string" && toolCall.id.length > 0) existing.id = toolCall.id;

        const functionPart = toolCall.function;
        if (functionPart && typeof functionPart === "object") {
          const fn = functionPart as Record<string, unknown>;
          if (typeof fn.name === "string" && fn.name.length > 0) existing.name = fn.name;
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            existing.arguments += fn.arguments;
            if (!existing.started && existing.name !== "unknown_tool") {
              stream.push({ type: "tool_call_start", id: existing.id, name: existing.name });
              existing.started = true;
            }
            stream.push({ type: "tool_call_delta", id: existing.id, delta: fn.arguments });
          }
        }

        if (!existing.started && existing.name !== "unknown_tool") {
          stream.push({ type: "tool_call_start", id: existing.id, name: existing.name });
          existing.started = true;
        }
        toolState.set(index, existing);
      }
    }
  }

  if (signal?.aborted) return;

  if (currentThinking.length > 0 && !thinkingEnded) {
    stream.push({ type: "thinking_end", thinking: currentThinking });
    contentBlocks.push({ type: "thinking", thinking: currentThinking });
  }

  if (currentText.length > 0) {
    stream.push({ type: "text_end", text: currentText });
    contentBlocks.push({ type: "text", text: currentText });
  }

  for (const tool of [...toolState.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])) {
    let input: Record<string, unknown> = {};
    try {
      input = tool.arguments.trim().length > 0 ? (JSON.parse(tool.arguments) as Record<string, unknown>) : {};
    } catch {
      input = { _raw: tool.arguments };
    }
    stream.push({ type: "tool_call_end", id: tool.id, name: tool.name, input });
    contentBlocks.push({ type: "tool_call", id: tool.id, name: tool.name, input });
  }

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
}
