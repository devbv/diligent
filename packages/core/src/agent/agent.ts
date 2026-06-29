// @summary Stateful Agent class — holds member vars, steering queue, and subscriber list; prompt() runs the loop

import { resolveCompaction } from "../llm/compaction";
import { resolveModel } from "../llm/models";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import { withRetry } from "../llm/retry";
import { resolveStream } from "../llm/stream-resolver";
import type { Model, ProviderName, StreamFunction, SystemSection, ThinkingEffort } from "../llm/types";
import type { Tool } from "../tool/types";
import type { Message, UserMessage } from "../types";
import { runCompaction } from "./compaction";
import type { LoopRuntime } from "./loop";
import { runAgentLoop } from "./loop";
import type { AgentOptions, CompactionConfig, QueuedSteeringMessage } from "./types";
import { AgentStream, type LLMRetryConfig } from "./types";

export class Agent {
  cwd?: string;
  model: Model;
  systemPrompt: SystemSection[];
  tools: Tool[];
  effort: ThinkingEffort;
  private llmMsgStreamFn: StreamFunction;
  private llmCompactionFn?: NativeCompactFn;
  private retryConfig: LLMRetryConfig;
  private compactionConfig: CompactionConfig;
  private messages: Message[] = [];
  private compactionSummary?: Record<string, unknown>;
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
  }

  private wrapWithRetry(fn: StreamFunction): StreamFunction {
    return withRetry(fn, {
      maxAttempts: this.retryConfig.maxRetries,
      baseDelayMs: this.retryConfig.baseDelayMs,
      maxDelayMs: this.retryConfig.maxDelayMs,
    });
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(fn: (event: import("./types").CoreAgentEvent) => void): () => void {
    return this.agentStream.subscribe(fn);
  }

  /** Restore conversation history (called once when resuming a session). */
  restore(messages: Message[]): void {
    this.messages = [...messages];
    this.compactionSummary = undefined;
  }

  restoreCompactionState(messages: Message[], compactionSummary?: Record<string, unknown>): void {
    this.messages = [...messages];
    this.compactionSummary = compactionSummary;
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
  async prompt(userMessage: Message, signal?: AbortSignal): Promise<Message[]> {
    if (this._running) throw new Error("Agent is already running a prompt");
    this._running = true;
    try {
      const nextMessages = [...this.messages, userMessage];
      const result = await runAgentLoop(nextMessages, this.createLoopRuntime(), signal);
      this.messages = result.messages;
      if (result.compactionSummary !== undefined) {
        this.compactionSummary = result.compactionSummary;
      }
      return result.messages;
    } finally {
      this._running = false;
      this.drainPendingMessages();
    }
  }

  private createLoopRuntime(): LoopRuntime {
    return {
      config: {
        cwd: this.cwd,
        model: this.model,
        systemPrompt: this.systemPrompt,
        tools: this.tools,
        effort: this.effort,
        compaction: this.compactionConfig,
      },
      streamFunction: this.llmMsgStreamFn,
      llmCompactionFn: this.llmCompactionFn,
      stream: this.agentStream,
      sessionId: this.sessionId,
      compactionSummary: this.compactionSummary,
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

function updateUserMessageContent(current: UserMessage["content"], content: string): UserMessage["content"] {
  if (typeof current === "string") return content;
  const next = [...current];
  const index = next.findIndex((block) => block.type === "text");
  if (index === -1) return [{ type: "text", text: content }, ...next];
  const block = next[index];
  if (!block || block.type !== "text") return next;
  next[index] = { ...block, text: content };
  return next;
}
