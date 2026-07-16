// @summary Agent loop coordinating compaction, streaming, tools, and loop safety

import type { Logger } from "@diligent/logging";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import type { StreamTurnScope } from "../llm/turn-scope";
import type { Model, StreamFunction, SystemSection, ThinkingEffort } from "../llm/types";
import { ProviderError } from "../llm/types";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message, ToolCallBlock } from "../types";
import { streamAssistantMessage } from "./assistant";
import { getCompactionDecision, runCompaction } from "./compaction";
import { runToolCalls } from "./tool";
import type { AgentStream, CompactionConfig, QueuedSteeringMessage } from "./types";
import { DoomLoopDetector } from "./util/doom-loop";
import { toSerializableError } from "./util/errors";
import { findLatestPlanSteps, latestUserGoal, PlanReminder, type PlanReminderState } from "./util/plan-reminder";

// Internal fully-resolved config for one loop run
interface LoopConfig {
  cwd?: string;
  model: Model;
  systemPrompt: SystemSection[];
  tools: Tool[];
  effort: ThinkingEffort;
  compaction?: CompactionConfig;
  /** Soft plan reminder cadence in agent turns; 0/undefined disables. See AgentOptions. */
  planReminderIntervalTurns?: number;
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
  /** Reminder state (plan + cadence counter) seeded by the Agent so it survives re-prompts. */
  planReminderState?: PlanReminderState;
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
  messages: Message[],
  runtime: LoopRuntime,
  userSignal?: AbortSignal,
): Promise<{
  messages: Message[];
  compactionSummary?: Record<string, unknown>;
  planReminderState?: PlanReminderState;
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
  const conversation = [...messages];
  const doomLoopTracker = new DoomLoopDetector();
  const registry = new Map(config.tools.map((tool) => [tool.name, tool]));
  const providerStream = streamFunction;
  let itemCounter = 0;
  let turnNumber = 0;
  const nextItemId = () => `item-${++itemCounter}`;

  // Soft plan reminder (recitation): re-inject unfinished plan steps into the tail once the
  // plan drifts out of context, so the model does not forget and stop early. Seeded from
  // session plan state so it survives compaction and re-prompts. See PlanReminder.
  const planReminder = new PlanReminder(
    config.planReminderIntervalTurns ?? 0,
    runtime.planReminderState ?? { plan: findLatestPlanSteps(conversation), turnsSinceSurfaced: 0 },
    runtime.logger.child({
      scope: "agent:plan-reminder",
      ...(runtime.sessionId !== undefined && { sessionId: runtime.sessionId }),
    }),
  );
  const runGoal = latestUserGoal(conversation);

  stream.emit({ type: "agent_start" });

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

      const turnId = `turn-${++turnNumber}`;
      stream.emit({ type: "turn_start", turnId });

      const justCompacted = await compactIfNeeded(conversation, loopRequest, stream);

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

      const planReminderMessage = planReminder.reminderForTurn({ compactedThisTurn: justCompacted, goal: runGoal });
      if (planReminderMessage) {
        const reminderEntry: Message = { role: "user", content: planReminderMessage, timestamp: Date.now() };
        conversation.push(reminderEntry);
        // Emit steering_injected so the reminder is staged to the session tree — external
        // session logs can then audit whether it fires, and resume restores an accurate
        // transcript. Unlike real steering it is NOT enqueued, so it never forces another
        // turn (stays soft). The web client hides it by its `<system-reminder>` marker.
        stream.emit({
          type: "steering_injected",
          messageCount: 1,
          messages: [reminderEntry],
          steerIds: [`plan-reminder-${turnId}`],
        });
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
          const compacted = await compactAfterContextOverflow(conversation, loopRequest, stream);
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
      const { executions } = await runToolCalls(toolCalls, signal, registry, stream, nextItemId, () =>
        toolAbortController.abort(),
      );

      // Always record tool results — including when the turn was aborted. Every
      // tool_use must be paired with its tool_result, otherwise the next request
      // sends an orphaned tool_use and the provider rejects the whole conversation
      // (e.g. Anthropic 400 "tool_use ids were found without tool_result blocks").
      for (const execution of executions) {
        conversation.push(execution.toolResult);
        doomLoopTracker.record(execution.toolCall.name, execution.toolCall.input);
        planReminder.recordToolResult(
          execution.toolResult.toolName,
          execution.toolResult.output,
          execution.toolResult.isError,
        );
      }

      const doomLoop = doomLoopTracker.check();
      if (doomLoop.detected) {
        conversation.push({
          role: "user",
          content: `[WARNING: Doom loop detected — tool "${doomLoop.toolName}" is being called in a repeating pattern (length ${doomLoop.patternLength}). Try a different approach.]`,
          timestamp: Date.now(),
        });
      }

      planReminder.endTurn();

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
    planReminderState: planReminder.snapshot(),
  };
}

function isContextOverflowError(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.errorType === "context_overflow";
}

async function compactIfNeeded(messages: Message[], request: LoopRequest, stream: AgentStream): Promise<boolean> {
  const config = request.config.compaction;
  if (!config) {
    return false;
  }

  const decision = getCompactionDecision(messages, request.config.model.contextWindow, config.reservePercent);
  if (!decision.shouldCompact) return false;

  request.logger.info("compaction_triggered", {
    message: "Compaction triggered",
    sessionId: request.sessionId,
    fields: {
      source: decision.source,
      estimatedTokens: decision.estimatedTokens,
      thresholdTokens: decision.thresholdTokens,
      reserveTokens: decision.reserveTokens,
      provider: request.config.model.provider,
      model: request.config.model.id,
    },
  });

  await applyCompaction(messages, request, stream);
  return true;
}

async function compactAfterContextOverflow(
  messages: Message[],
  request: LoopRequest,
  stream: AgentStream,
): Promise<boolean> {
  if (!request.config.compaction) return false;
  request.logger.warn("compaction_forced", {
    message: "[agent:compaction] forced after context_overflow",
    sessionId: request.sessionId,
    fields: {
      reason: "context_overflow",
      provider: request.config.model.provider,
      model: request.config.model.id,
    },
  });
  await applyCompaction(messages, request, stream);
  return true;
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
