// @summary Stateful Agent class — holds member vars, steering queue, and subscriber list; prompt() runs the loop

import { createLogger, type Logger } from "@diligent/logging";
import { resolveCompaction } from "../llm/compaction";
import type { LocalImageLoader } from "../llm/image-io";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import { withRetry } from "../llm/retry";
import { resolveStream } from "../llm/stream-resolver";
import { createStreamTurnScope, type StreamTurnScope } from "../llm/turn-scope";
import type { Model, ProviderName, StreamFunction, SystemSection, ThinkingEffort } from "../llm/types";
import type { ToolOutputFileStore } from "../tool/executor";
import type { Tool } from "../tool/types";
import type { Message } from "../types";
import { runCompaction } from "./compaction";
import type { LoopRuntime } from "./loop";
import { runAgentLoop } from "./loop";
import { AgentLoopHookDispatcher } from "./loop-hooks";
import { updateUserMessageContent } from "./message-content";
import type { AgentOptions, AgentPromptOptions, CompactionConfig, QueuedSteeringMessage } from "./types";
import { AgentStream, DEFAULT_LLM_RETRY_CONFIG, type LLMRetryConfig } from "./types";

export class Agent {
  model: Model;
  systemPrompt: SystemSection[];
  tools: Tool[];
  effort: ThinkingEffort;
  private llmMsgStreamFn: StreamFunction;
  private llmCompactionFn?: NativeCompactFn;
  private retryConfig: LLMRetryConfig;
  private logger: Logger;
  private loopHooks: AgentLoopHookDispatcher;
  private compactionConfig: CompactionConfig;
  private messages: Message[] = [];
  private compactionSummary?: Record<string, unknown>;
  private pendingSteeringMessages: QueuedSteeringMessage[] = [];
  private nextSteeringId = 0;
  private _running = false;
  private sessionId?: string;
  private localImageLoader?: LocalImageLoader;
  private toolOutputStore?: ToolOutputFileStore;
  readonly agentStream = new AgentStream();

  constructor(model: Model, systemPrompt: SystemSection[], tools: Tool[], opts?: AgentOptions) {
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.effort = opts?.effort ?? "medium";
    this.logger = opts?.logger ?? createLogger({ scope: "agent" });
    this.loopHooks = new AgentLoopHookDispatcher(opts?.loopHooks ?? [], this.logger);
    this.sessionId = opts?.sessionId;
    this.localImageLoader = opts?.localImageLoader;
    this.toolOutputStore = opts?.toolOutputStore;
    this.compactionConfig = opts?.compaction ?? {
      reservePercent: 14,
      timeoutMs: 180_000,
    };
    this.retryConfig = opts?.retry ?? DEFAULT_LLM_RETRY_CONFIG;
    this.llmMsgStreamFn = this.wrapWithRetry(
      opts?.llmMsgStreamFn ?? resolveStream(this.model.provider as ProviderName),
    );
    this.llmCompactionFn = opts?.llmCompactionFn ?? resolveCompaction(this.model.provider);
  }

  private wrapWithRetry(fn: StreamFunction): StreamFunction {
    return withRetry(
      fn,
      {
        maxAttempts: this.retryConfig.maxRetries + 1,
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
    this.loopHooks.restore(this.messages);
  }

  restoreCompactionState(messages: Message[], compactionSummary?: Record<string, unknown>): void {
    this.messages = [...messages];
    this.compactionSummary = compactionSummary;
    this.loopHooks.restore(this.messages);
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
      const result = await runAgentLoop(this.messages, userMessage, this.createLoopRuntime(turnScope), signal);
      this.messages = result.messages;
      if (result.compactionSummary !== undefined) {
        this.compactionSummary = result.compactionSummary;
      }
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
        model: this.model,
        systemPrompt: this.systemPrompt,
        tools: this.tools,
        effort: this.effort,
        compaction: this.compactionConfig,
        localImageLoader: this.localImageLoader,
      },
      streamFunction: this.llmMsgStreamFn,
      llmCompactionFn: this.llmCompactionFn,
      stream: this.agentStream,
      turnScope,
      logger: this.logger,
      sessionId: this.sessionId,
      compactionSummary: this.compactionSummary,
      loopHooks: this.loopHooks,
      toolOutputStore: this.toolOutputStore,
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

  setModel(model: Model, streamFn?: StreamFunction, compactionFn?: NativeCompactFn): void {
    this.model = model;
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

  /** Attempt to compact internal messages, adopting only a smaller effective context. */
  async compact(signal?: AbortSignal): Promise<import("./compaction").RunCompactionResult> {
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
      localImageLoader: this.localImageLoader,
      signal,
    });
    if (result.compacted) {
      this.messages = result.messages;
      this.compactionSummary = result.compactionSummary;
    }
    return result;
  }
}
