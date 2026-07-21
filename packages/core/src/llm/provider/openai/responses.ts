// @summary Responses API message conversion, tool building, and request body construction for OpenAI-format providers
import type { ResponseInputItem, ResponseInputMessageContentList } from "openai/resources/responses/responses";
import type { Message, StopReason, Usage } from "../../../types";
import { type LocalImageLoader, materializeUserContentBlocks } from "../../image-io";
import type {
  FunctionToolDefinition,
  ProviderBuiltinToolDefinition,
  ThinkingEffort,
  ToolDefinition,
} from "../../types";
import { openAICompactionStateToInputItems } from "./compaction-state";

// OpenAI vision `detail`: "low" = fixed 512px (~85 tokens), "high" = tiled, "auto" = server picks by size.
export type OpenAIImageDetail = "auto" | "low" | "high";

export async function convertMessages(
  messages: Message[],
  imageDetail: OpenAIImageDetail = "auto",
  localImageLoader?: LocalImageLoader,
  provider?: "openai" | "chatgpt",
): Promise<ResponseInputItem[]> {
  const result: ResponseInputItem[] = [];
  const pendingCalls = new Map<string, number>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ type: "message", role: "user", content: [{ type: "input_text", text: msg.content }] });
      } else {
        const blocks = await materializeUserContentBlocks(msg.content, { loader: localImageLoader });
        const content: ResponseInputMessageContentList = [];
        for (const block of blocks) {
          if (block.type === "text") {
            content.push({ type: "input_text", text: block.text });
          } else if (block.type === "image") {
            content.push({
              type: "input_image",
              image_url: `data:${block.source.media_type};base64,${block.source.data}`,
              detail: imageDetail,
            });
          }
        }
        result.push({ type: "message", role: "user", content });
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "thinking") {
          const providerState = block.providerState;
          if (providerState && providerState.provider === provider) {
            result.push({
              type: "reasoning",
              id: providerState.itemId,
              encrypted_content: providerState.encryptedContent,
              summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
            });
          }
        } else if (block.type === "text") {
          result.push({ role: "assistant", content: block.text });
        } else if (block.type === "tool_call") {
          pendingCalls.set(block.id, result.length);
          result.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
    } else if (msg.role === "tool_result") {
      pendingCalls.delete(msg.toolCallId);
      result.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.output,
      });
      // OpenAI's function_call_output is text-only; attach any image content
      // as a follow-up user message so the model can actually see it.
      if (msg.outputImages && msg.outputImages.length > 0) {
        const imageContent: ResponseInputMessageContentList = msg.outputImages.map((img) => ({
          type: "input_image",
          image_url: `data:${img.source.media_type};base64,${img.source.data}`,
          detail: imageDetail,
        }));
        result.push({ type: "message", role: "user", content: imageContent });
      }
    }
  }

  if (pendingCalls.size > 0) {
    const injections = Array.from(pendingCalls.entries())
      .map(([callId, idx]) => ({
        idx: idx + 1,
        item: { type: "function_call_output" as const, call_id: callId, output: "(interrupted)" },
      }))
      .sort((a, b) => b.idx - a.idx);
    for (const { idx, item } of injections) {
      result.splice(idx, 0, item);
    }
  }

  return result;
}

export async function toResponseInputItems(input: {
  messages: Message[];
  compactionSummary?: Record<string, unknown>;
  imageDetail?: OpenAIImageDetail;
  localImageLoader?: LocalImageLoader;
  provider?: "openai" | "chatgpt";
}): Promise<ResponseInputItem[]> {
  const convertedMessages = await convertMessages(
    input.messages,
    input.imageDetail,
    input.localImageLoader,
    input.provider,
  );
  if (input.compactionSummary) {
    const compactedInput = openAICompactionStateToInputItems(input.compactionSummary) as unknown as ResponseInputItem[];
    return [...compactedInput, ...convertedMessages];
  }
  return convertedMessages;
}

export function mapStopReason(status: string | undefined): StopReason {
  switch (status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return "max_tokens";
    case "failed":
      return "error";
    case "cancelled":
      return "aborted";
    default:
      return "end_turn";
  }
}

const GPT_56_MODEL_IDS = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

export function isGpt56Model(modelId: string): boolean {
  return GPT_56_MODEL_IDS.has(modelId);
}

/**
 * Convert a standard Responses request into the ChatGPT Codex Responses Lite shape.
 * Lite carries tool declarations and developer instructions as leading input items.
 */
export function toResponsesLiteRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const { input, instructions, tools, reasoning, ...rest } = body;
  const inputItems = Array.isArray(input) ? input : [];
  const toolItems = Array.isArray(tools) ? tools : [];
  const reasoningOptions = reasoning && typeof reasoning === "object" ? (reasoning as Record<string, unknown>) : {};
  const prefix: Array<Record<string, unknown>> = [
    {
      type: "additional_tools",
      role: "developer",
      tools: toolItems,
    },
  ];

  if (typeof instructions === "string" && instructions.length > 0) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    });
  }

  return {
    ...rest,
    input: [...prefix, ...inputItems],
    reasoning: { ...reasoningOptions, context: "all_turns" },
    parallel_tool_calls: false,
  };
}

type OpenAIFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

type OpenAIWebSearchTool = {
  type: "web_search";
  filters?: { allowed_domains?: string[] };
  search_context_size?: "low" | "medium" | "high";
  user_location?: {
    type: "approximate";
    city?: string;
    country?: string;
    region?: string;
    timezone?: string;
  };
};

export type OpenAIResponsesTool = OpenAIFunctionTool | OpenAIWebSearchTool;

function mapContextSize(maxContentTokens?: number): OpenAIWebSearchTool["search_context_size"] {
  if (maxContentTokens === undefined) return undefined;
  if (maxContentTokens <= 2_000) return "low";
  if (maxContentTokens <= 8_000) return "medium";
  return "high";
}

function mergeWebSearchTools(tools: ProviderBuiltinToolDefinition[]): OpenAIWebSearchTool | undefined {
  if (tools.length === 0) return undefined;

  const allowedDomains = Array.from(
    new Set(tools.flatMap((tool) => tool.options?.allowedDomains ?? []).filter((value) => value.length > 0)),
  );
  const contextSizes = tools
    .map((tool) => mapContextSize(tool.options?.maxContentTokens))
    .filter((value): value is "low" | "medium" | "high" => value !== undefined);
  const userLocation = tools.map((tool) => tool.options?.userLocation).find((value) => value !== undefined);

  return {
    type: "web_search",
    ...(allowedDomains.length > 0 ? { filters: { allowed_domains: allowedDomains } } : {}),
    ...(contextSizes.includes("high")
      ? { search_context_size: "high" as const }
      : contextSizes.includes("medium")
        ? { search_context_size: "medium" as const }
        : contextSizes.includes("low")
          ? { search_context_size: "low" as const }
          : {}),
    ...(userLocation ? { user_location: userLocation } : {}),
  };
}

export function buildTools(tools: ToolDefinition[], strict?: boolean): OpenAIResponsesTool[] {
  const functionTools: OpenAIFunctionTool[] = tools.flatMap((tool) => {
    if (tool.kind !== "function") return [];
    const t: FunctionToolDefinition = tool;
    return [
      {
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: { type: "object", ...t.inputSchema },
        ...(strict !== undefined && { strict }),
      },
    ];
  });

  const webTool = mergeWebSearchTools(
    tools.filter((tool): tool is ProviderBuiltinToolDefinition => tool.kind === "provider_builtin"),
  );

  return webTool ? [...functionTools, webTool] : functionTools;
}

export async function buildResponsesRequestBody(input: {
  model: string;
  messages: Message[];
  compactionSummary?: Record<string, unknown>;
  systemInstructions?: string;
  tools?: ToolDefinition[];
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  useReasoning?: boolean;
  effort?: ThinkingEffort;
  store?: boolean;
  enablePromptCaching?: boolean;
  strictTools?: boolean;
  imageDetail?: OpenAIImageDetail;
  localImageLoader?: LocalImageLoader;
  provider?: "openai" | "chatgpt";
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: input.model,
    stream: true,
    input: await toResponseInputItems({
      messages: input.messages,
      compactionSummary: input.compactionSummary,
      imageDetail: input.imageDetail,
      localImageLoader: input.localImageLoader,
      provider: input.provider,
    }),
  };
  if (input.systemInstructions) body.instructions = input.systemInstructions;
  if (input.sessionId) body.prompt_cache_key = input.sessionId;
  if (input.enablePromptCaching) {
    if (isGpt56Model(input.model)) {
      body.prompt_cache_options = { ttl: "30m" };
    } else {
      body.prompt_cache_retention = "24h";
    }
  }
  if (input.store !== undefined) body.store = input.store;
  if (input.tools && input.tools.length > 0) {
    body.tools = buildTools(input.tools, input.strictTools);
  }
  if (input.maxTokens !== undefined) body.max_output_tokens = input.maxTokens;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.useReasoning && input.effort) {
    body.reasoning = { effort: input.effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  if (input.tools?.some((tool) => tool.kind === "provider_builtin")) {
    const existing = Array.isArray(body.include) ? body.include : [];
    body.include = [...new Set([...existing, "web_search_call.action.sources"])];
  }
  return body;
}

export function isContextOverflow(message: string): boolean {
  const patterns = [/maximum context length/i, /context_length_exceeded/i, /too many tokens/i, /exceeds the model/i];
  return patterns.some((p) => p.test(message));
}

export function mapUsage(
  usage:
    | {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined,
): Usage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cachedTokens - cacheWriteTokens),
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cachedTokens,
    cacheWriteTokens,
  };
}
