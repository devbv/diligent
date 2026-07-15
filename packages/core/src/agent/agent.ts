// @summary Stateful Agent class — holds member vars, steering queue, and subscriber list; prompt() runs the loop

import { createLogger, type Logger } from "@diligent/logging";
import { resolveCompaction } from "../llm/compaction";
import { resolveModel } from "../llm/models";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import { withRetry } from "../llm/retry";
import { resolveStream } from "../llm/stream-resolver";
import { createStreamTurnScope, type StreamTurnScope } from "../llm/turn-scope";
import type { Model, ProviderName, StreamFunction, SystemSection, ThinkingEffort } from "../llm/types";
import type { Tool } from "../tool/types";
import type { Message } from "../types";
import { runCompaction } from "./compaction";
import type { LoopRuntime } from "./loop";
import { runAgentLoop } from "./loop";
import { updateUserMessageContent } from "./message-content";
import type { AgentOptions, AgentPromptOptions, CompactionConfig, QueuedSteeringMessage } from "./types";
import { AgentStream, type LLMRetryConfig } from "./types";
import { findLatestPlanSteps, type PlanReminderState } from "./util/plan-reminder";

export class Agent {
  cwd?: string;
  model: Model;
  systemPrompt: SystemSection[];
  tools: Tool[];
  effort: ThinkingEffort;
  private llmMsgStreamFn: StreamFunction;
  private llmCompactionFn?: NativeCompactFn;
  private retryConfig: LLMRetryConfig;
  private logger: Logger;
  private compactionConfig: CompactionConfig;
  private messages: Message[] = [];
  private compactionSummary?: Record<string, unknown>;
  /** Session-level reminder state (plan steps + cadence counter), external to the conversation
   *  so it survives compaction and re-prompts — the counter must persist across user inputs,
   *  otherwise a "N-turn burst → user input → …" pattern would reset it and never remind. */
  private planReminderState?: PlanReminderState;
  private planReminderIntervalTurns?: number;
  private pendingSteeringMessages: QueuedSteeringMessage[] = [];
  private nextSteeringId = 0;
  private _running = false;
  private sessionId?: string;
  readonly agentStream = new AgentStream();

  constructor(model: string | Model, systemPrompt: SystemSection[], tools: Tool[], opts?: AgentOptions) {
    this.model = typeof model === "string" ? resolveModel(model) : model;
    this.cwd = opts?.cwd;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.effort = opts?.effort ?? "medium";
    this.logger = opts?.logger ?? createLogger({ scope: "agent" });
    this.sessionId = opts?.sessionId;
    this.compactionConfig = opts?.compaction ?? {
      reservePercent: 14,
      keepRecentTokens: 20_000,
      timeoutMs: 180_000,
    };
    this.retryConfig = opts?.retry ?? {
      maxRetries: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
    };
    this.llmMsgStreamFn = this.wrapWithRetry(
      opts?.llmMsgStreamFn ?? resolveStream(this.model.provider as ProviderName),
    );
    this.llmCompactionFn = opts?.llmCompactionFn ?? resolveCompaction(this.model.provider);
    this.planReminderIntervalTurns = opts?.planReminderIntervalTurns;
  }

  private wrapWithRetry(fn: StreamFunction): StreamFunction {
    return withRetry(
      fn,
      {
        maxAttempts: this.retryConfig.maxRetries,
        baseDelayMs: this.retryConfig.baseDelayMs,
        maxDelayMs: this.retryConfig.maxDelayMs,
      },
      undefined,
      this.logger.child({ scope: "llm:retry" }),
    );
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(fn: (event: import("./types").CoreAgentEvent) => void): () => void {
    return this.agentStream.subscribe(fn);
  }

  /** Restore conversation history (called once when resuming a session). */
  restore(messages: Message[]): void {
    this.messages = [...messages];
    this.compactionSummary = undefined;
    this.planReminderState = { plan: findLatestPlanSteps(this.messages), turnsSinceSurfaced: 0 };
  }

  restoreCompactionState(messages: Message[], compactionSummary?: Record<string, unknown>): void {
    this.messages = [...messages];
    this.compactionSummary = compactionSummary;
    this.planReminderState = { plan: findLatestPlanSteps(this.messages), turnsSinceSurfaced: 0 };
  }

  /** Get the current conversation messages. */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Run the agent loop with a new user message.
   * Agent runs against a staged history and commits it only if the loop succeeds.
   * Resolves with the final message array when the loop ends.
   */
  async prompt(userMessage: Message, signal?: AbortSignal, options?: AgentPromptOptions): Promise<Message[]> {
    if (this._running) throw new Error("Agent is already running a prompt");
    this._running = true;
    const ownsTurnScope = options?.turnScope === undefined;
    const turnScope = options?.turnScope ?? createStreamTurnScope();
    try {
      const nextMessages = [...this.messages, userMessage];
      const result = await runAgentLoop(nextMessages, this.createLoopRuntime(turnScope), signal);
      this.messages = result.messages;
      if (result.compactionSummary !== undefined) {
        this.compactionSummary = result.compactionSummary;
      }
      this.planReminderState = result.planReminderState;
      return result.messages;
    } finally {
      if (ownsTurnScope) await turnScope.dispose();
      this._running = false;
      this.drainPendingMessages();
    }
  }

  private createLoopRuntime(turnScope: StreamTurnScope): LoopRuntime {
    return {
      config: {
        cwd: this.cwd,
        model: this.model,
        systemPrompt: this.systemPrompt,
        tools: this.tools,
        effort: this.effort,
        compaction: this.compactionConfig,
        planReminderIntervalTurns: this.planReminderIntervalTurns,
      },
      streamFunction: this.llmMsgStreamFn,
      llmCompactionFn: this.llmCompactionFn,
      stream: this.agentStream,
      turnScope,
      logger: this.logger,
      sessionId: this.sessionId,
      compactionSummary: this.compactionSummary,
      planReminderState: this.planReminderState,
      hooks: {
        drainSteeringMessages: () => this.drainPendingMessages(),
        pendingSteeringCount: () => this.pendingSteeringMessages.length,
      },
    };
  }

  /** Queue a steering message to be injected into the running loop. */
  steer(msg: Message, id = this.createSteeringId()): string {
    this.pendingSteeringMessages.push({ id, message: msg });
    return id;
  }

  /** Remove one queued steering message before it is injected. */
  cancelPendingMessage(id: string): boolean {
    const index = this.pendingSteeringMessages.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.pendingSteeringMessages.splice(index, 1);
    return true;
  }

  /** Update one queued steering message before it is injected. */
  updatePendingMessage(id: string, content: string): boolean {
    const entry = this.pendingSteeringMessages.find((pending) => pending.id === id);
    const msg = entry?.message;
    if (!msg || msg.role !== "user") return false;
    msg.content = updateUserMessageContent(msg.content, content);
    return true;
  }

  /** Returns true if there are pending steering messages. */
  hasPendingMessages(): boolean {
    return this.pendingSteeringMessages.length > 0;
  }

  /** Drain all steering messages from the queue. */
  drainPendingMessages(): QueuedSteeringMessage[] {
    return this.pendingSteeringMessages.splice(0);
  }

  getPendingSteeringMessages(): QueuedSteeringMessage[] {
    return this.pendingSteeringMessages.map((entry) => ({ id: entry.id, message: entry.message }));
  }

  private createSteeringId(): string {
    this.nextSteeringId += 1;
    return `steer-${this.nextSteeringId}`;
  }

  setModel(model: string | Model, streamFn?: StreamFunction, compactionFn?: NativeCompactFn): void {
    this.model = typeof model === "string" ? resolveModel(model) : model;
    this.llmMsgStreamFn = this.wrapWithRetry(streamFn ?? resolveStream(this.model.provider as ProviderName));
    this.llmCompactionFn = compactionFn ?? resolveCompaction(this.model.provider);
  }

  setEffort(effort: ThinkingEffort): void {
    this.effort = effort;
  }

  setCompactionConfig(compaction: CompactionConfig): void {
    this.compactionConfig = compaction;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Compact internal messages unconditionally, emitting compaction_start/end via stream. */
  async compact(signal?: AbortSignal): Promise<void> {
    const result = await runCompaction({
      messages: this.messages,
      model: this.model,
      systemPrompt: this.systemPrompt,
      compactionSummary: this.compactionSummary,
      compactionConfig: this.compactionConfig,
      llmMsgStreamFn: this.llmMsgStreamFn,
      llmCompactionFn: this.llmCompactionFn,
      stream: this.agentStream,
      sessionId: this.sessionId,
      signal,
    });
    this.messages = result.messages;
    this.compactionSummary = result.compactionSummary;
  }
}
