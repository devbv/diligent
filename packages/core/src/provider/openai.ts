import OpenAI from "openai";
import { EventStream } from "../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, Usage } from "../types";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  ToolDefinition,
} from "./types";
import { ProviderError } from "./types";

export function createOpenAIStream(apiKey: string, baseUrl?: string): StreamFunction {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  return (model: Model, context: StreamContext, options: StreamOptions): EventStream<ProviderEvent, ProviderResult> => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    (async () => {
      try {
        const openaiStream = await client.responses.create(
          {
            model: model.id,
            instructions: context.systemPrompt,
            input: convertToOpenAIInput(context.messages),
            ...(context.tools.length > 0 && {
              tools: convertToOpenAITools(context.tools),
            }),
            ...(options.maxTokens !== undefined && { max_output_tokens: options.maxTokens }),
            ...(options.temperature !== undefined && { temperature: options.temperature }),
            stream: true,
          },
          ...(options.signal ? [{ signal: options.signal }] : []),
        );

        stream.push({ type: "start" });

        const contentBlocks: ContentBlock[] = [];
        let currentToolId = "";
        let currentToolName = "";

        for await (const event of openaiStream) {
          if (options.signal?.aborted) break;

          switch (event.type) {
            case "response.output_text.delta":
              stream.push({ type: "text_delta", delta: event.delta });
              break;

            case "response.output_item.done": {
              const item = event.item;
              if (item.type === "message") {
                for (const part of item.content) {
                  if (part.type === "output_text") {
                    stream.push({ type: "text_end", text: part.text });
                    contentBlocks.push({ type: "text", text: part.text });
                  }
                }
              } else if (item.type === "function_call") {
                try {
                  const input = JSON.parse(item.arguments) as Record<string, unknown>;
                  stream.push({
                    type: "tool_call_end",
                    id: item.call_id,
                    name: item.name,
                    input,
                  });
                  contentBlocks.push({
                    type: "tool_call",
                    id: item.call_id,
                    name: item.name,
                    input,
                  });
                } catch {
                  stream.push({
                    type: "tool_call_end",
                    id: item.call_id,
                    name: item.name,
                    input: {},
                  });
                  contentBlocks.push({
                    type: "tool_call",
                    id: item.call_id,
                    name: item.name,
                    input: {},
                  });
                }
              }
              break;
            }

            case "response.function_call_arguments.delta":
              stream.push({ type: "tool_call_delta", id: currentToolId, delta: event.delta });
              break;

            case "response.output_item.added":
              if (event.item.type === "function_call") {
                currentToolId = event.item.call_id;
                currentToolName = event.item.name;
                stream.push({
                  type: "tool_call_start",
                  id: currentToolId,
                  name: currentToolName,
                });
              }
              break;

            case "response.completed": {
              const resp = event.response;
              const usage = mapOpenAIUsage(resp.usage);
              const stopReason = mapOpenAIStopReason(resp.status ?? "completed");

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
              break;
            }

            case "response.failed": {
              const failedResp = event.response as unknown as Record<string, unknown>;
              const respError = failedResp?.error as Record<string, unknown> | undefined;
              const errorMsg = (respError?.message as string) ?? "OpenAI response failed";
              stream.push({
                type: "error",
                error: new ProviderError(errorMsg, "unknown", false),
              });
              break;
            }
          }
        }
      } catch (err) {
        stream.push({ type: "error", error: classifyOpenAIError(err) });
      }
    })();

    return stream;
  };
}

type OpenAIInputItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function convertToOpenAIInput(messages: Message[]): OpenAIInputItem[] {
  const result: OpenAIInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({
        role: "user",
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((b) => b.type === "text")
                .map((b) => (b as { type: "text"; text: string }).text)
                .join("\n"),
      });
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          result.push({ role: "assistant", content: block.text });
        } else if (block.type === "tool_call") {
          result.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
    } else if (msg.role === "tool_result") {
      result.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.output,
      });
    }
  }

  return result;
}

function convertToOpenAITools(tools: ToolDefinition[]): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}> {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: { type: "object", ...t.inputSchema },
    strict: false,
  }));
}

function mapOpenAIUsage(usage: { input_tokens: number; output_tokens: number } | undefined): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function mapOpenAIStopReason(status: string): StopReason {
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

export function classifyOpenAIError(err: unknown): ProviderError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) {
      const retryAfter = parseRetryAfterFromHeaders(err.headers);
      return new ProviderError(err.message, "rate_limit", true, retryAfter, status, err);
    }
    if (status === 529) {
      return new ProviderError(err.message, "overloaded", true, undefined, status, err);
    }
    if (status === 400 && isContextOverflow(err.message)) {
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

function isContextOverflow(message: string): boolean {
  const patterns = [/maximum context length/i, /context_length_exceeded/i, /too many tokens/i, /exceeds the model/i];
  return patterns.some((p) => p.test(message));
}

function parseRetryAfterFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms) return Number.parseInt(ms, 10);
  const s = headers.get("retry-after");
  if (s) return Number.parseInt(s, 10) * 1000;
  return undefined;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}
