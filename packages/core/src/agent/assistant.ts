// @summary Assistant-response streaming helpers and provider debug logging

import { createHash } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { StreamTurnScope } from "../llm/turn-scope";
import type {
  FunctionToolDefinition,
  Model,
  ModelRef,
  StreamContext,
  StreamFunction,
  SystemSection,
  ThinkingEffort,
  ToolDefinition,
} from "../llm/types";
import { resolveMaxTokens } from "../llm/types";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message } from "../types";
import type { AgentStream } from "./types";
import { toSerializableError } from "./util/errors";

function toFunctionToolDefinition(
  tool: Pick<Tool, "name" | "description" | "parameters" | "inputSchema">,
): FunctionToolDefinition {
  const schema = tool.inputSchema
    ? tool.inputSchema
    : (() => {
        const { $schema, ...rest } = zodToJsonSchema(tool.parameters) as Record<string, unknown>;
        // Providers (Anthropic at least) require a top-level `type: "object"`. A top-level
        // union (`anyOf` of object variants) omits it and the whole request 400s, so force
        // it while the union branches still describe the accepted shapes.
        return rest.type === "object" ? rest : { ...rest, type: "object" };
      })();
  return {
    kind: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
  };
}

function toToolDefinition(
  tool: Pick<Tool, "name" | "description" | "parameters" | "inputSchema" | "modelExposure">,
): ToolDefinition {
  return tool.modelExposure ?? toFunctionToolDefinition(tool);
}

function createAssistantMessage(model: ModelRef): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function ensureCurrentMessage(
  currentMessage: AssistantMessage | undefined,
  model: ModelRef,
  stream: AgentStream,
  itemId: string,
): AssistantMessage {
  if (currentMessage) return currentMessage;
  const message = createAssistantMessage(model);
  stream.emit({ type: "message_start", itemId, message });
  return message;
}

export async function streamAssistantMessage(
  messages: Message[],
  request: {
    config: {
      model: Model;
      effort: ThinkingEffort;
      localImageLoader?: import("../llm/image-io").LocalImageLoader;
    };
    sessionId?: string;
    signal?: AbortSignal;
    compactionSummary?: Record<string, unknown>;
    turnScope: StreamTurnScope;
  },
  runtime: {
    tools: Tool[];
    systemPrompt: SystemSection[];
    providerStream: StreamFunction;
  },
  stream: AgentStream,
  generateItemId: () => string,
): Promise<AssistantMessage> {
  const context: StreamContext = {
    localImageLoader: request.config.localImageLoader,
    systemPrompt: runtime.systemPrompt,
    messages,
    tools: runtime.tools.map(toToolDefinition),
    compactionSummary: request.compactionSummary,
  };

  const promptHashes = computePromptContextHashes(context);
  stream.emit({
    type: "prompt_signature",
    sessionId: request.sessionId,
    messageCount: context.messages.length,
    signature: promptHashes.join("|"),
    hashes: promptHashes,
  });

  const providerStream = runtime.providerStream(request.config.model, context, {
    signal: request.signal,
    effort: request.config.effort,
    sessionId: request.sessionId,
    maxTokens: resolveMaxTokens(request.config.model),
    turnStateRef: request.turnScope.turnStateRef,
    turnScope: request.turnScope,
  });

  const _requestStartedAt = Date.now();
  const messageItemId = generateItemId();
  let currentMessage: AssistantMessage | undefined;
  let sawDone = false;

  for await (const event of providerStream) {
    switch (event.type) {
      case "done":
        sawDone = true;
        currentMessage = event.message;
        stream.emit({ type: "message_end", itemId: messageItemId, message: event.message });
        break;
      case "error":
        providerStream.result().catch(() => {});
        throw event.error;
      case "retry":
        if (currentMessage) {
          stream.emit({
            type: "message_discarded",
            itemId: messageItemId,
            error: toSerializableError(event.error),
            nextAttempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
          });
          currentMessage = undefined;
        }
        break;
      case "text_delta":
      case "thinking_delta": {
        currentMessage = ensureCurrentMessage(currentMessage, request.config.model, stream, messageItemId);

        stream.emit({
          type: "message_delta",
          itemId: messageItemId,
          message: currentMessage,
          delta:
            event.type === "text_delta"
              ? { type: "text_delta", delta: event.delta }
              : { type: "thinking_delta", delta: event.delta },
        });
        break;
      }
      case "content_block": {
        currentMessage = ensureCurrentMessage(currentMessage, request.config.model, stream, messageItemId);
        currentMessage.content.push(event.block);
        stream.emit({
          type: "message_delta",
          itemId: messageItemId,
          message: currentMessage,
          delta: { type: "content_block_delta", block: event.block },
        });
        break;
      }
      case "start":
      case "text_end":
      case "thinking_end":
        break;
      case "tool_call_start":
      case "tool_call_delta":
      case "tool_call_end":
        currentMessage = ensureCurrentMessage(currentMessage, request.config.model, stream, messageItemId);
        break;
      case "usage":
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled provider event: ${String(exhaustive)}`);
      }
    }
  }

  if (!sawDone || !currentMessage) {
    if (request.signal?.aborted) {
      throw new Error("Aborted");
    }
    throw new Error("Provider stream ended without producing a message");
  }

  const result = await providerStream.result();
  return result.message;
}

function computePromptContextHashes(context: StreamContext): string[] {
  const systemHashes = context.systemPrompt.map((section) => hashSegment("sys", section));
  const toolHashes = context.tools.map((tool) => hashSegment("tool", tool));
  const messageHashes = context.messages.map((message) => hashSegment("msg", message));
  return [...systemHashes, ...toolHashes, ...messageHashes];
}

function hashSegment(kind: "sys" | "tool" | "msg", payload: unknown): string {
  const stable = JSON.stringify({ kind, payload });
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 6);
  return `${kind}:${digest}`;
}
