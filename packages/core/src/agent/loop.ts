import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { EventStream } from "../event-stream";
import { withRetry } from "../provider/retry";
import type { Model, StreamContext, ToolDefinition } from "../provider/types";
import { executeTool } from "../tool/executor";
import type { ToolContext } from "../tool/types";
import type { AssistantMessage, Message, ToolCallBlock, ToolResultMessage, Usage } from "../types";
import { LoopDetector } from "./loop-detector";
import type { AgentEvent, AgentLoopConfig, SerializableError } from "./types";

// D086: Convert Error to serializable representation
function toSerializableError(err: unknown): SerializableError {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err), name: "Error" };
}

export function agentLoop(messages: Message[], config: AgentLoopConfig): EventStream<AgentEvent, Message[]> {
  const stream = new EventStream<AgentEvent, Message[]>(
    (event) => event.type === "agent_end",
    (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
  );

  runLoop(messages, config, stream).catch((err) => {
    stream.push({ type: "error", error: toSerializableError(err), fatal: true });
    // Complete the stream gracefully so the result promise resolves
    // instead of leaving an unhandled rejection. Consumers see the error event.
    stream.push({ type: "agent_end", messages: [...messages] });
    stream.end([...messages]);
  });

  return stream;
}

async function runLoop(
  messages: Message[],
  config: AgentLoopConfig,
  stream: EventStream<AgentEvent, Message[]>,
): Promise<void> {
  // D086: Counter scoped per invocation — itemIds are deterministic within each agentLoop call
  let itemCounter = 0;
  const generateItemId = () => `item-${++itemCounter}`;

  const allMessages = [...messages];
  let turnCount = 0;
  const maxTurns = config.maxTurns ?? 100;

  const loopDetector = new LoopDetector();
  const registry = new Map(config.tools.map((t) => [t.name, t]));

  // D010: Wrap stream function with retry
  const retryStreamFn = withRetry(config.streamFunction, {
    maxAttempts: config.maxRetries ?? 5,
    baseDelayMs: config.retryBaseDelayMs ?? 1000,
    maxDelayMs: config.retryMaxDelayMs ?? 30_000,
    signal: config.signal,
    onRetry: (attempt, delayMs, _error) => {
      stream.push({
        type: "status_change",
        status: "retry",
        retry: { attempt, delayMs },
      });
    },
  });

  stream.push({ type: "agent_start" });

  while (turnCount < maxTurns) {
    if (config.signal?.aborted) break;
    turnCount++;

    const turnId = `turn-${turnCount}`;
    stream.push({ type: "turn_start", turnId });

    // 1. Stream LLM response (with retry)
    const assistantMessage = await streamAssistantResponse(allMessages, config, retryStreamFn, stream, generateItemId);
    allMessages.push(assistantMessage);

    // Emit usage after each turn
    stream.push({
      type: "usage",
      usage: assistantMessage.usage,
      cost: calculateCost(config.model, assistantMessage.usage),
    });

    // 2. Check for tool calls
    const toolCalls = assistantMessage.content.filter((b): b is ToolCallBlock => b.type === "tool_call");

    if (toolCalls.length === 0) {
      stream.push({
        type: "turn_end",
        turnId,
        message: assistantMessage,
        toolResults: [],
      });
      break;
    }

    // 3. Execute tools sequentially (D015)
    const toolResults: ToolResultMessage[] = [];

    for (const toolCall of toolCalls) {
      if (config.signal?.aborted) break;

      const toolItemId = generateItemId();

      stream.push({
        type: "tool_start",
        itemId: toolItemId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      });

      const ctx: ToolContext = {
        toolCallId: toolCall.id,
        signal: config.signal ?? new AbortController().signal,
        approve: async () => "once" as const,
        onUpdate: (partial) => {
          stream.push({
            type: "tool_update",
            itemId: toolItemId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            partialResult: partial,
          });
        },
      };

      const result = await executeTool(registry, toolCall, ctx);
      const toolResult: ToolResultMessage = {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        output: result.output,
        isError: !!result.metadata?.error,
        timestamp: Date.now(),
      };

      toolResults.push(toolResult);
      allMessages.push(toolResult);

      stream.push({
        type: "tool_end",
        itemId: toolItemId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        output: result.output,
        isError: toolResult.isError,
      });

      loopDetector.record(toolCall.name, toolCall.input);
    }

    const loopResult = loopDetector.check();
    if (loopResult.detected) {
      stream.push({
        type: "loop_detected",
        patternLength: loopResult.patternLength!,
        toolName: loopResult.toolName!,
      });
      allMessages.push({
        role: "user",
        content: `[WARNING: Loop detected — tool "${loopResult.toolName}" is being called in a repeating pattern (length ${loopResult.patternLength}). Try a different approach.]`,
        timestamp: Date.now(),
      });
    }

    stream.push({
      type: "turn_end",
      turnId,
      message: assistantMessage,
      toolResults,
    });
    // Loop continues — LLM sees tool results and responds
  }

  stream.push({ type: "agent_end", messages: allMessages });
  stream.end(allMessages);
}

async function streamAssistantResponse(
  messages: Message[],
  config: AgentLoopConfig,
  streamFn: typeof config.streamFunction,
  agentStream: EventStream<AgentEvent, Message[]>,
  generateItemId: () => string,
): Promise<AssistantMessage> {
  const context: StreamContext = {
    systemPrompt: config.systemPrompt,
    messages,
    tools: config.tools.map(toolToDefinition),
  };

  const providerStream = streamFn(config.model, context, { signal: config.signal });

  let currentMessage: AssistantMessage | undefined;
  const messageItemId = generateItemId();

  for await (const event of providerStream) {
    if (event.type === "done") {
      currentMessage = event.message;
      agentStream.push({ type: "message_end", itemId: messageItemId, message: event.message });
    } else if (event.type === "error") {
      // Consume the rejected result to prevent unhandled rejection
      providerStream.result().catch(() => {});
      throw event.error;
    } else if (event.type === "start") {
      // message_start emitted when we have first delta
    } else if (event.type === "text_delta") {
      if (!currentMessage) {
        currentMessage = createEmptyAssistantMessage(config.model.id);
        agentStream.push({ type: "message_start", itemId: messageItemId, message: currentMessage });
      }
      agentStream.push({
        type: "message_delta",
        itemId: messageItemId,
        message: currentMessage,
        delta: { type: "text_delta", delta: event.delta },
      });
    } else if (event.type === "thinking_delta") {
      if (!currentMessage) {
        currentMessage = createEmptyAssistantMessage(config.model.id);
        agentStream.push({ type: "message_start", itemId: messageItemId, message: currentMessage });
      }
      agentStream.push({
        type: "message_delta",
        itemId: messageItemId,
        message: currentMessage,
        delta: { type: "thinking_delta", delta: event.delta },
      });
    }
    // text_end, thinking_end, tool_call_*, usage — consumed silently
    // (final data comes from the "done" event's AssistantMessage)
  }

  if (!currentMessage) {
    throw new Error("Provider stream ended without producing a message");
  }

  // The final message comes from the done event via providerStream.result()
  const result = await providerStream.result();
  return result.message;
}

function toolToDefinition(tool: { name: string; description: string; parameters: z.ZodType }): ToolDefinition {
  const { $schema, ...schema } = zodToJsonSchema(tool.parameters) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
  };
}

function createEmptyAssistantMessage(model: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function calculateCost(model: Model, usage: Usage): number {
  const inputCost = (usage.inputTokens / 1_000_000) * (model.inputCostPer1M ?? 0);
  const outputCost = (usage.outputTokens / 1_000_000) * (model.outputCostPer1M ?? 0);
  return inputCost + outputCost;
}
