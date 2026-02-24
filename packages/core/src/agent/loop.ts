import { EventStream } from "../event-stream";
import type { AgentEvent, AgentLoopConfig } from "./types";
import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  ToolCallBlock,
  ContentBlock,
  Usage,
} from "../types";
import type { StreamContext, ToolDefinition } from "../provider/types";
import type { ToolContext } from "../tool/types";
import { executeTool } from "../tool/executor";

export function agentLoop(
  messages: Message[],
  config: AgentLoopConfig,
): EventStream<AgentEvent, Message[]> {
  const stream = new EventStream<AgentEvent, Message[]>(
    (event) => event.type === "agent_end",
    (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
  );

  runLoop(messages, config, stream).catch((err) => {
    stream.push({ type: "error", error: err, fatal: true });
    stream.error(err);
  });

  return stream;
}

async function runLoop(
  messages: Message[],
  config: AgentLoopConfig,
  stream: EventStream<AgentEvent, Message[]>,
): Promise<void> {
  const allMessages = [...messages];
  let turnCount = 0;
  const maxTurns = config.maxTurns ?? 100;

  const registry = new Map(config.tools.map((t) => [t.name, t]));

  stream.push({ type: "agent_start" });

  while (turnCount < maxTurns) {
    if (config.signal?.aborted) break;
    turnCount++;

    const turnId = `turn-${turnCount}`;
    stream.push({ type: "turn_start", turnId });

    // 1. Stream LLM response
    const assistantMessage = await streamAssistantResponse(
      allMessages,
      config,
      stream,
    );
    allMessages.push(assistantMessage);

    // 2. Check for tool calls
    const toolCalls = assistantMessage.content.filter(
      (b): b is ToolCallBlock => b.type === "tool_call",
    );

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

      stream.push({
        type: "tool_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      });

      const ctx: ToolContext = {
        toolCallId: toolCall.id,
        signal: config.signal ?? new AbortController().signal,
        approve: async () => true,
        onUpdate: (partial) => {
          stream.push({
            type: "tool_update",
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
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        output: result.output,
        isError: toolResult.isError,
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
  agentStream: EventStream<AgentEvent, Message[]>,
): Promise<AssistantMessage> {
  const context: StreamContext = {
    systemPrompt: config.systemPrompt,
    messages,
    tools: config.tools.map(toolToDefinition),
  };

  const providerStream = config.streamFunction(
    config.model,
    context,
    { signal: config.signal, apiKey: config.apiKey },
  );

  let currentMessage: AssistantMessage | undefined;

  for await (const event of providerStream) {
    if (event.type === "done") {
      currentMessage = event.message;
      agentStream.push({ type: "message_end", message: event.message });
    } else if (event.type === "error") {
      throw event.error;
    } else if (event.type === "start") {
      // message_start emitted when we have first delta
    } else {
      if (currentMessage === undefined) {
        currentMessage = createEmptyAssistantMessage(config.model.id);
        agentStream.push({ type: "message_start", message: currentMessage });
      }
      agentStream.push({ type: "message_delta", message: currentMessage, event });
    }
  }

  if (!currentMessage) {
    throw new Error("Provider stream ended without producing a message");
  }

  // The final message comes from the done event via providerStream.result()
  const result = await providerStream.result();
  return result.message;
}

function toolToDefinition(tool: { name: string; description: string; parameters: { _def?: unknown } & { shape?: unknown } }): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.parameters),
  };
}

// Convert a Zod schema to JSON Schema via its _def internals (Zod v3)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodToJsonSchema(schema: any): Record<string, unknown> {
  const def = schema?._def;
  if (!def) return {};

  switch (def.typeName) {
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((value as any)?._def?.typeName !== "ZodOptional" && (value as any)?._def?.typeName !== "ZodDefault") {
          required.push(key);
        }
      }
      return { type: "object", properties, ...(required.length > 0 && { required }) };
    }
    case "ZodString": {
      const result: Record<string, unknown> = { type: "string" };
      if (def.description) result.description = def.description;
      return result;
    }
    case "ZodNumber": {
      const result: Record<string, unknown> = { type: "number" };
      if (def.description) result.description = def.description;
      return result;
    }
    case "ZodBoolean": {
      const result: Record<string, unknown> = { type: "boolean" };
      if (def.description) result.description = def.description;
      return result;
    }
    case "ZodArray": {
      const result: Record<string, unknown> = { type: "array", items: zodToJsonSchema(def.type) };
      if (def.description) result.description = def.description;
      return result;
    }
    case "ZodEnum": {
      const result: Record<string, unknown> = { type: "string", enum: def.values };
      if (def.description) result.description = def.description;
      return result;
    }
    case "ZodLiteral": {
      return { const: def.value };
    }
    case "ZodOptional": {
      const inner = zodToJsonSchema(def.innerType);
      if (def.description) inner.description = def.description;
      return inner;
    }
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType);
      if (def.description) inner.description = def.description;
      return inner;
    }
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType);
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodUnion": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { anyOf: def.options.map((opt: any) => zodToJsonSchema(opt)) };
    }
    default:
      return {};
  }
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
