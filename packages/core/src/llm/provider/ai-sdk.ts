// @summary Shared bridge from AI SDK language models to Diligent messages, tools, and provider events
import {
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from "ai";
import { EventStream } from "../../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, ToolCallBlock, Usage } from "../../types";
import { type LocalImageLoader, materializeUserContentBlocks } from "../image-io";
import { flattenSections } from "../system-sections";
import type {
  Model,
  ProviderError,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  ToolDefinition,
} from "../types";

export interface AISDKStreamConfig {
  createLanguageModel: (model: Model) => LanguageModel;
  classifyError: (error: unknown) => ProviderError;
  buildTools?: (tools: ToolDefinition[]) => ToolSet;
  buildProviderOptions?: (model: Model, options: StreamOptions) => AISDKProviderOptions | undefined;
  resolveReasoning?: (model: Model, options: StreamOptions) => AISDKReasoning | undefined;
  createProviderState?: () => unknown;
  handleProviderPart?: (part: TextStreamPart<ToolSet>, state: unknown) => ContentBlock[];
  finalizeProviderState?: (state: unknown) => ContentBlock[];
}

type AISDKReasoning = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "provider-default";
type UserContent = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>;
type AssistantContent = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
type AISDKProviderOptions = NonNullable<Extract<AssistantContent[number], { type: "tool-call" }>["providerOptions"]>;

export async function convertToAISDKMessages(
  messages: Message[],
  localImageLoader?: LocalImageLoader,
): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        result.push({ role: "user", content: message.content });
        continue;
      }
      const blocks = await materializeUserContentBlocks(message.content, { loader: localImageLoader });
      const content: UserContent = [];
      for (const block of blocks) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          content.push({
            type: "file",
            data: { type: "data", data: block.source.data },
            mediaType: block.source.media_type,
          });
        }
      }
      result.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      const content: AssistantContent = [];
      for (const block of message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_call") {
          content.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
            ...(block.providerMetadata ? { providerOptions: block.providerMetadata as AISDKProviderOptions } : {}),
          });
        }
      }
      if (content.length > 0) result.push({ role: "assistant", content });
      continue;
    }

    result.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          output: toAISDKToolOutput(message),
        },
      ],
    });
  }

  return result;
}

function toAISDKToolOutput(message: Extract<Message, { role: "tool_result" }>) {
  if (message.isError) return { type: "error-text" as const, value: message.output };
  if (!message.outputImages || message.outputImages.length === 0) {
    return { type: "text" as const, value: message.output };
  }
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: message.output },
      ...message.outputImages.map((image) => ({
        type: "file" as const,
        data: { type: "data" as const, data: image.source.data },
        mediaType: image.source.media_type,
      })),
    ],
  };
}

export function convertToAISDKTools(tools: ToolDefinition[]): ToolSet {
  const result: ToolSet = {};
  for (const definition of tools) {
    if (definition.kind !== "function") continue;
    result[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema({ type: "object", ...definition.inputSchema }),
    });
  }
  return result;
}

export function createAISDKStream(config: AISDKStreamConfig): StreamFunction {
  return (model, context, options) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    if (options.signal) stream.attachSignal(options.signal);

    const work = runAISDKStream(stream, model, context, options, config);
    stream.setInnerWork(work);
    return stream;
  };
}

async function runAISDKStream(
  stream: EventStream<ProviderEvent, ProviderResult>,
  model: Model,
  context: StreamContext,
  options: StreamOptions,
  config: AISDKStreamConfig,
): Promise<void> {
  try {
    const providerState = config.createProviderState?.();
    const messages = await convertToAISDKMessages(context.messages, context.localImageLoader);
    const result = streamText({
      model: config.createLanguageModel(model),
      instructions: flattenSections(context.systemPrompt),
      // Some auth/readiness probes intentionally call a stream with no transcript.
      messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
      tools: (config.buildTools ?? convertToAISDKTools)(context.tools),
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      reasoning: (config.resolveReasoning ?? resolveAISDKReasoning)(model, options),
      providerOptions: config.buildProviderOptions?.(model, options),
      abortSignal: options.signal,
      maxRetries: 0,
    });

    const content: ContentBlock[] = [];
    const startedToolCalls = new Set<string>();
    let text = "";
    let thinking = "";
    let usage = emptyUsage();
    let stopReason: StopReason = "end_turn";
    stream.push({ type: "start" });

    for await (const part of result.stream) {
      if (options.signal?.aborted) return;
      if (part.type === "error") throw part.error;
      if (part.type === "abort") return;

      if (part.type === "text-delta") {
        text += part.text;
        stream.push({ type: "text_delta", delta: part.text });
      } else if (part.type === "text-end") {
        if (text.length > 0) {
          stream.push({ type: "text_end", text });
          content.push({ type: "text", text });
          text = "";
        }
      } else if (part.type === "reasoning-delta") {
        thinking += part.text;
        stream.push({ type: "thinking_delta", delta: part.text });
      } else if (part.type === "reasoning-end") {
        if (thinking.length > 0) {
          stream.push({ type: "thinking_end", thinking });
          content.push({ type: "thinking", thinking });
          thinking = "";
        }
      } else if (part.type === "tool-input-start" && !part.providerExecuted) {
        startedToolCalls.add(part.id);
        stream.push({ type: "tool_call_start", id: part.id, name: part.toolName });
      } else if (part.type === "tool-input-delta" && startedToolCalls.has(part.id)) {
        stream.push({ type: "tool_call_delta", id: part.id, delta: part.delta });
      } else if (part.type === "tool-call" && !part.providerExecuted) {
        if (!startedToolCalls.has(part.toolCallId)) {
          stream.push({ type: "tool_call_start", id: part.toolCallId, name: part.toolName });
        }
        const input = toInputRecord(part.input);
        stream.push({ type: "tool_call_end", id: part.toolCallId, name: part.toolName, input });
        content.push({
          type: "tool_call",
          id: part.toolCallId,
          name: part.toolName,
          input,
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata as Record<string, unknown> } : {}),
        } satisfies ToolCallBlock);
      } else if (part.type === "finish-step") {
        stopReason = mapAISDKFinishReason(part.finishReason);
        usage = mapAISDKUsage(part.usage);
      } else if (part.type === "finish") {
        stopReason = mapAISDKFinishReason(part.finishReason);
        usage = mapAISDKUsage(part.totalUsage);
      }

      if (providerState !== undefined) {
        const blocks = config.handleProviderPart?.(part, providerState) ?? [];
        for (const block of blocks) {
          content.push(block);
          stream.push({ type: "content_block", block });
        }
      }
    }

    if (thinking.length > 0) {
      stream.push({ type: "thinking_end", thinking });
      content.push({ type: "thinking", thinking });
    }
    if (text.length > 0) {
      stream.push({ type: "text_end", text });
      content.push({ type: "text", text });
    }
    for (const block of providerState === undefined ? [] : (config.finalizeProviderState?.(providerState) ?? [])) {
      content.push(block);
      stream.push({ type: "content_block", block });
    }

    stream.push({ type: "usage", usage });
    const message: AssistantMessage = {
      role: "assistant",
      content,
      model: model.id,
      usage,
      stopReason,
      timestamp: Date.now(),
    };
    stream.push({ type: "done", stopReason, message });
  } catch (error) {
    stream.push({ type: "error", error: config.classifyError(error) });
  }
}

function resolveAISDKReasoning(model: Model, options: StreamOptions): AISDKReasoning | undefined {
  if (!model.supportsThinking || options.effort === undefined) return undefined;
  if (options.effort === "max") return "xhigh";
  return options.effort;
}

function toInputRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { _raw: input };
    }
  }
  return {};
}

export function mapAISDKFinishReason(reason: string): StopReason {
  if (reason === "tool-calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content-filter" || reason === "error") return "error";
  return "end_turn";
}

export function mapAISDKUsage(usage: LanguageModelUsage): Usage {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  return {
    inputTokens:
      usage.inputTokenDetails.noCacheTokens ??
      Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
