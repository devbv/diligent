// @summary Agent loop coordinating compaction, streaming, tools, and loop safety

import type { Logger } from "@diligent/logging";
import type { LocalImageLoader } from "../llm/image-io";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import type { StreamTurnScope } from "../llm/turn-scope";
import type { Model, StreamFunction, SystemSection, ThinkingEffort } from "../llm/types";
import { ProviderError, ProviderErrorType } from "../llm/types";
import type { ToolOutputFileStore } from "../tool/executor";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message, ToolCallBlock } from "../types";
import { streamAssistantMessage } from "./assistant";
import { getCompactionDecision, runCompaction } from "./compaction";
import type { AgentLoopHookDispatcher } from "./loop-hooks";
import { runToolCalls } from "./tool";
import type { AgentStream, CompactionConfig, QueuedSteeringMessage } from "./types";
import { DoomLoopDetector } from "./util/doom-loop";
import { toSerializableError } from "./util/errors";

// Internal fully-resolved config for one loop run
interface LoopConfig {
  model: Model;
  systemPrompt: SystemSection[];
  tools: Tool[];
  effort: ThinkingEffort;
  compaction?: CompactionConfig;
  localImageLoader?: LocalImageLoader;
}

export interface LoopRuntime {
  config: LoopConfig;
  streamFunction: StreamFunction;
  llmCompactionFn?: NativeCompactFn;
  stream: AgentStream;
  logger: Logger;
  turnScope: StreamTurnScope;
  sessionId?: string;
  compactionSummary?: Record<string, unknown>;
  loopHooks: AgentLoopHookDispatcher;
  toolOutputStore?: ToolOutputFileStore;
  hooks: {
    drainSteeringMessages: () => QueuedSteeringMessage[];
    pendingSteeringCount: () => number;
  };
}

type LoopRequest = {
  config: LoopConfig;
  streamFunction: StreamFunction;
  llmCompactionFn?: NativeCompactFn;
  logger: Logger;
  turnScope: StreamTurnScope;
  sessionId?: string;
  signal?: AbortSignal;
  compactionSummary?: Record<string, unknown>;
};

export async function runAgentLoop(
  history: Message[],
  userMessage: Message,
  runtime: LoopRuntime,
  userSignal?: AbortSignal,
): Promise<{
  messages: Message[];
  compactionSummary?: Record<string, unknown>;
}> {
  const { config, streamFunction, stream, hooks } = runtime;
  const toolAbortController = new AbortController();
  const signal = AbortSignal.any([toolAbortController.signal, userSignal].filter((s): s is AbortSignal => s != null));

  const loopRequest = {
    config,
    streamFunction,
    llmCompactionFn: runtime.llmCompactionFn,
    logger: runtime.logger,
    turnScope: runtime.turnScope,
    sessionId: runtime.sessionId,
    signal,
    compactionSummary: runtime.compactionSummary,
  };
  const conversation = [...history];
  const doomLoopTracker = new DoomLoopDetector();
  const registry = new Map(config.tools.map((tool) => [tool.name, tool]));
  const providerStream = streamFunction;
  let itemCounter = 0;
  let turnNumber = 0;
  const nextItemId = () => `item-${++itemCounter}`;

  stream.emit({ type: "agent_start" });

  try {
    const compactedBeforePrompt = await compactIfNeeded(
      conversation,
      loopRequest,
      stream,
      [...conversation, userMessage],
      [userMessage],
    );
    if (!compactedBeforePrompt) {
      conversation.push(userMessage);
    }
    const freshUserIndex = conversation.length - 1;
    runtime.loopHooks.onPromptStart(conversation);

    while (true) {
      if (signal?.aborted) {
        break;
      }

      const turnId = `turn-${++turnNumber}`;
      const justCompacted =
        turnNumber === 1 ? compactedBeforePrompt : await compactIfNeeded(conversation, loopRequest, stream);
      stream.emit({ type: "turn_start", turnId });

      const steering = hooks.drainSteeringMessages();
      if (steering.length > 0) {
        const steeringMessages = steering.map((entry) => entry.message);
        conversation.push(...steeringMessages);
        stream.emit({
          type: "steering_injected",
          messageCount: steering.length,
          messages: steeringMessages,
          steerIds: steering.map((entry) => entry.id),
        });
      }

      const contextInjections = runtime.loopHooks.beforeTurn({
        messages: conversation,
        turnId,
        compactedThisTurn: justCompacted,
      });
      if (contextInjections.length > 0) {
        const injections = contextInjections.map((injection) => ({
          source: injection.source,
          message: { role: "user" as const, content: injection.content, timestamp: Date.now() },
          metadata: injection.metadata,
        }));
        conversation.push(...injections.map((injection) => injection.message));
        stream.emit({ type: "context_injected", injections });
      }

      let retriedAfterContextOverflow = false;
      let assistantMessage: AssistantMessage | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
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
          if (!isContextOverflowError(err) || retriedAfterContextOverflow) throw err;
          let compacted = false;
          try {
            compacted = await compactAfterContextOverflow(
              conversation,
              loopRequest,
              stream,
              turnNumber === 1 ? conversation.length - freshUserIndex : 0,
            );
          } catch {
            throw err;
          }
          if (!compacted) throw err;
          retriedAfterContextOverflow = true;
        }
      }
      if (!assistantMessage) {
        throw new Error("Assistant message was not produced");
      }
      conversation.push(assistantMessage);

      stream.emit({ type: "usage", usage: assistantMessage.usage });

      const toolCalls = assistantMessage.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
      const { executions } = await runToolCalls(
        toolCalls,
        signal,
        registry,
        stream,
        nextItemId,
        () => toolAbortController.abort(),
        runtime.toolOutputStore,
      );

      // Always record tool results — including when the turn was aborted. Every
      // tool_use must be paired with its tool_result, otherwise the next request
      // sends an orphaned tool_use and the provider rejects the whole conversation
      // (e.g. Anthropic 400 "tool_use ids were found without tool_result blocks").
      for (const execution of executions) {
        conversation.push(execution.toolResult);
        runtime.loopHooks.onToolResult({
          turnId,
          toolCall: execution.toolCall,
          result: execution.toolResult,
        });
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

      runtime.loopHooks.afterTurn({
        turnId,
        message: assistantMessage,
        toolResults: executions.map((execution) => execution.toolResult),
      });

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

  return {
    messages: conversation,
    compactionSummary: loopRequest.compactionSummary,
  };
}

function isContextOverflowError(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.errorType === ProviderErrorType.ContextOverflow;
}

async function compactIfNeeded(
  messages: Message[],
  request: LoopRequest,
  stream: AgentStream,
  decisionMessages: Message[] = messages,
  preservedMessages: Message[] = [],
): Promise<boolean> {
  const config = request.config.compaction;
  if (!config) {
    return false;
  }

  const decision = getCompactionDecision(decisionMessages, request.config.model.contextWindow, config.reservePercent);
  if (!decision.shouldCompact) return false;

  request.logger.info("compaction_triggered", {
    message: `[agent:compaction] triggered source=${decision.source} estimatedTokens=${decision.estimatedTokens} thresholdTokens=${decision.thresholdTokens} reserveTokens=${decision.reserveTokens}`,
    sessionId: request.sessionId,
    fields: {
      source: decision.source,
      estimatedTokens: decision.estimatedTokens,
      thresholdTokens: decision.thresholdTokens,
      reserveTokens: decision.reserveTokens,
      provider: request.config.model.provider,
      model: request.config.model.modelId,
    },
  });

  return applyCompaction(messages, request, stream, { preservedMessages });
}

async function compactAfterContextOverflow(
  messages: Message[],
  request: LoopRequest,
  stream: AgentStream,
  preserveTailCount: number,
): Promise<boolean> {
  if (!request.config.compaction) return false;
  request.logger.warn("compaction_forced", {
    message: "[agent:compaction] forced after context_overflow",
    sessionId: request.sessionId,
    fields: {
      reason: "context_overflow",
      provider: request.config.model.provider,
      model: request.config.model.modelId,
    },
  });
  const splitIndex = Math.max(0, messages.length - preserveTailCount);
  const compactableMessages = messages.slice(0, splitIndex);
  const preservedMessages = messages.slice(splitIndex);
  if (compactableMessages.length === 0 && request.compactionSummary === undefined) return false;
  const compacted = await applyCompaction(compactableMessages, request, stream, {
    bypassMinimum: true,
    preservedMessages,
  });
  if (compacted) {
    messages.splice(0, messages.length, ...compactableMessages);
  }
  return compacted;
}

async function applyCompaction(
  messages: Message[],
  request: LoopRequest,
  stream: AgentStream,
  options?: { bypassMinimum?: boolean; preservedMessages?: Message[] },
): Promise<boolean> {
  const config = request.config.compaction;
  if (!config) return false;
  const result = await runCompaction({
    messages,
    preservedMessages: options?.preservedMessages,
    model: request.config.model,
    systemPrompt: request.config.systemPrompt,
    compactionSummary: request.compactionSummary,
    sessionId: request.sessionId,
    localImageLoader: request.config.localImageLoader,
    compactionConfig: config,
    llmMsgStreamFn: request.streamFunction,
    llmCompactionFn: request.llmCompactionFn,
    stream,
    signal: request.signal,
    bypassMinimum: options?.bypassMinimum,
  });
  if (!result.compacted) {
    // A triggered-but-rejected compaction is invisible in the session file (no entry, no event) —
    // log it so a context stuck above the threshold is diagnosable from runtime logs (QA-10459).
    request.logger.info("compaction_rejected", {
      message: `[agent:compaction] rejected reason=${result.rejectionReason} tokensBefore=${result.tokensBefore}`,
      sessionId: request.sessionId,
      fields: {
        reason: result.rejectionReason,
        tokensBefore: result.tokensBefore,
        provider: request.config.model.provider,
        model: request.config.model.modelId,
      },
    });
    return false;
  }
  messages.splice(0, messages.length, ...result.messages);
  request.compactionSummary = result.compactionSummary;
  return true;
}
