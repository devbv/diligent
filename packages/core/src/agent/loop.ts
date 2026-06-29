// @summary Agent loop coordinating compaction, streaming, tools, and loop safety

import type { NativeCompactFn } from "../llm/provider/native-compaction";
import type { Model, StreamFunction, SystemSection, ThinkingEffort } from "../llm/types";
import { ProviderError } from "../llm/types";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message, ToolCallBlock } from "../types";
import { streamAssistantMessage } from "./assistant";
import { getCompactionDecision, runCompaction } from "./compaction";
import { runToolCalls } from "./tool";
import type { AgentStream, CompactionConfig } from "./types";
import { DoomLoopDetector } from "./util/doom-loop";
import { toSerializableError } from "./util/errors";

// Internal fully-resolved config for one loop run
interface LoopConfig {
  cwd?: string;
  model: Model;
  systemPrompt: SystemSection[];
  tools: Tool[];
  effort: ThinkingEffort;
  compaction?: CompactionConfig;
}

export interface LoopRuntime {
  config: LoopConfig;
  streamFunction: StreamFunction;
  llmCompactionFn?: NativeCompactFn;
  stream: AgentStream;
  sessionId?: string;
  compactionSummary?: Record<string, unknown>;
  hooks: {
    drainSteeringMessages: () => Message[];
    pendingSteeringCount: () => number;
  };
}

type LoopRequest = {
  config: LoopConfig;
  streamFunction: StreamFunction;
  llmCompactionFn?: NativeCompactFn;
  sessionId?: string;
  signal?: AbortSignal;
  compactionSummary?: Record<string, unknown>;
};

export async function runAgentLoop(
  messages: Message[],
  runtime: LoopRuntime,
  userSignal?: AbortSignal,
): Promise<{ messages: Message[]; compactionSummary?: Record<string, unknown> }> {
  const { config, streamFunction, stream, hooks } = runtime;
  const toolAbortController = new AbortController();
  const signal = AbortSignal.any([toolAbortController.signal, userSignal].filter((s): s is AbortSignal => s != null));

  const loopRequest = {
    config,
    streamFunction,
    llmCompactionFn: runtime.llmCompactionFn,
    sessionId: runtime.sessionId,
    signal,
    compactionSummary: runtime.compactionSummary,
  };
  const conversation = [...messages];
  const doomLoopTracker = new DoomLoopDetector();
  const registry = new Map(config.tools.map((tool) => [tool.name, tool]));
  const providerStream = streamFunction;
  let itemCounter = 0;
  let turnNumber = 0;
  const nextItemId = () => `item-${++itemCounter}`;

  stream.emit({ type: "agent_start" });

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

      const turnId = `turn-${++turnNumber}`;
      stream.emit({ type: "turn_start", turnId });

      await compactIfNeeded(conversation, loopRequest, stream);

      const steering = hooks.drainSteeringMessages();
      if (steering.length > 0) {
        conversation.push(...steering);
        stream.emit({ type: "steering_injected", messageCount: steering.length, messages: steering });
      }

      let retriedAfterContextOverflow = false;
      let assistantMessage: AssistantMessage;
      while (true) {
        try {
          assistantMessage = await streamAssistantMessage(
            conversation,
            loopRequest,
            { tools: config.tools, systemPrompt: config.systemPrompt, providerStream },
            stream,
            nextItemId,
          );
          break;
        } catch (err) {
          const canRetryWithCompaction =
            err instanceof ProviderError &&
            err.errorType === "context_overflow" &&
            !retriedAfterContextOverflow &&
            loopRequest.config.compaction !== undefined;
          if (!canRetryWithCompaction) {
            throw err;
          }
          console.log("[agent:compaction] forced after context_overflow");
          await applyCompaction(conversation, loopRequest, stream);
          retriedAfterContextOverflow = true;
        }
      }
      conversation.push(assistantMessage);

      stream.emit({ type: "usage", usage: assistantMessage.usage });

      const toolCalls = assistantMessage.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
      const { executions } = await runToolCalls(toolCalls, signal, registry, stream, nextItemId, () =>
        toolAbortController.abort(),
      );

      for (const execution of executions) {
        if (!signal.aborted) {
          conversation.push(execution.toolResult);
        }
        doomLoopTracker.record(execution.toolCall.name, execution.toolCall.input);
      }

      const doomLoop = doomLoopTracker.check();
      if (doomLoop.detected) {
        conversation.push({
          role: "user",
          content: `[WARNING: Doom loop detected — tool "${doomLoop.toolName}" is being called in a repeating pattern (length ${doomLoop.patternLength}). Try a different approach.]`,
          timestamp: Date.now(),
        });
      }

      stream.emit({
        type: "turn_end",
        turnId,
        message: assistantMessage,
        toolResults: executions.map((execution) => execution.toolResult),
      });

      if (signal.aborted || (toolCalls.length === 0 && hooks.pendingSteeringCount() === 0)) break;
    }
  } catch (err) {
    if (!userSignal?.aborted) {
      stream.emit({ type: "error", error: toSerializableError(err), fatal: true });
      throw err;
    }
  } finally {
    stream.emit({ type: "agent_end", messages: conversation });
  }

  return { messages: conversation, compactionSummary: loopRequest.compactionSummary };
}

async function compactIfNeeded(messages: Message[], request: LoopRequest, stream: AgentStream): Promise<void> {
  const config = request.config.compaction;
  if (!config) {
    return;
  }

  const decision = getCompactionDecision(messages, request.config.model.contextWindow, config.reservePercent);
  if (!decision.shouldCompact) return;

  console.log(
    `[agent:compaction] triggered source=${decision.source} estimatedTokens=${decision.estimatedTokens} thresholdTokens=${decision.thresholdTokens} reserveTokens=${decision.reserveTokens}`,
  );

  await applyCompaction(messages, request, stream);
}

async function applyCompaction(messages: Message[], request: LoopRequest, stream: AgentStream): Promise<void> {
  const config = request.config.compaction;
  if (!config) return;
  const result = await runCompaction({
    messages,
    model: request.config.model,
    systemPrompt: request.config.systemPrompt,
    compactionSummary: request.compactionSummary,
    sessionId: request.sessionId,
    compactionConfig: config,
    llmMsgStreamFn: request.streamFunction,
    llmCompactionFn: request.llmCompactionFn,
    stream,
    signal: request.signal,
  });
  messages.splice(0, messages.length, ...result.messages);
  request.compactionSummary = result.compactionSummary;
}
