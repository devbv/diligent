// @summary Orchestrates agent run loop, steering queue, and compaction for a session

import type { CoreAgentEvent } from "@diligent/core/agent";
import {
  type Agent,
  formatSerializableErrorForLog,
  type QueuedSteeringMessage,
  toSerializableError,
  updateUserMessageContent,
} from "@diligent/core/agent";
import type { Message } from "@diligent/core/message-contract";
import { createStreamTurnScope, type StreamTurnScope } from "@diligent/core/provider-contract";
import { createLogger } from "@diligent/logging";
import type { PendingSteer } from "@diligent/protocol";
import { readContextPresentation } from "../agent/context-presentation";
import type { AgentEvent } from "../agent-event";
import { calculateUsageCost } from "../cost";
import { createToolStartRenderPayload } from "../tools/render-strategies";
import { buildSessionContext } from "./context-builder";
import type { SessionPersistence } from "./persistence";
import type { SessionCache } from "./session-cache";
import type { SessionStateStore } from "./state-store";
import { TurnStager } from "./turn-stager";
import type { CompactionEntry, ErrorEntry, SessionEntry, SessionManagerConfig } from "./types";
import { generateEntryId } from "./types";

const logger = createLogger({ scope: "runtime.session" });

export interface TurnOrchestratorContext {
  state: SessionStateStore;
  persistence: SessionPersistence;
  config: SessionManagerConfig;
  sessionCache: SessionCache;
  emit: (event: AgentEvent) => void;
  appendEntries: (entries: SessionEntry[]) => void;
  appendAndPersist: (entry: SessionEntry) => void;
  appendError: (error: ErrorEntry["error"], opts?: { fatal?: boolean; turnId?: string; persist?: boolean }) => void;
  repairEntries: () => void;
  getContext: () => Message[];
}

export class TurnOrchestrator {
  /** Cached agent instance — persists between runs for the session lifetime */
  private _agent: Agent | null = null;
  /** Track which agent instance has been restored with session history */
  private _initializedAgent: Agent | null = null;
  /** Pre-agent steering queue — drained into agent at start of run() */
  private pendingMessages: QueuedSteeringMessage[] = [];

  constructor(private ctx: TurnOrchestratorContext) {}

  get currentAgent(): Agent | null {
    return this._agent;
  }

  /** Reset agent state when the session is re-created or resumed. */
  resetAgentState(): void {
    this._agent = null;
    this._initializedAgent = null;
    this.pendingMessages = [];
  }

  /**
   * Run the agent loop with the current session context.
   * Persists user message and agent response to session.
   */
  async run(userMessage: Message, opts?: { signal?: AbortSignal }): Promise<void> {
    const turnScope = createStreamTurnScope();
    try {
      await this.runInternal(userMessage, { ...opts, turnScope });
    } finally {
      await turnScope.dispose();
    }
  }

  private async runInternal(
    userMessage: Message,
    opts: { signal?: AbortSignal; turnScope: StreamTurnScope },
  ): Promise<void> {
    this.emitBusyStatus();

    const prepared = await this.prepareRun(userMessage);
    const { unsubscribe, getCurrentTurnId, getLastAgentError } = this.subscribeRunEvents(prepared);

    let normalCompletion = false;
    try {
      await this.executeRun(prepared.agent, userMessage, opts.signal, opts.turnScope);
      this.commitRun(prepared.turnStager);
      normalCompletion = true;
    } catch (err) {
      this.handleRunError(err, prepared.turnStager, getCurrentTurnId(), getLastAgentError());
    } finally {
      this.finishRun(unsubscribe);
    }

    this.throwIfAborted(opts.signal);

    if (normalCompletion && this.ctx.config.onStop) {
      await this.ctx.config.onStop(this.ctx.getContext());
    }
  }

  async compactNow(): Promise<{
    compacted: boolean;
    entryCount: number;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
  }> {
    await this.ctx.persistence.waitForWrites();
    const context = buildSessionContext(this.ctx.state.getCommittedEntries(), this.ctx.state.getCommittedLeafId(), {});
    const compactionConfig = this.ctx.config.compaction ?? {
      enabled: true,
      reservePercent: 16,
      timeoutMs: 180_000,
    };

    const agentResult = this.resolveAgent();
    const agent = agentResult instanceof Promise ? await agentResult : agentResult;
    agent.restoreCompactionState(context.providerMessages, context.compactionSummary);
    // Manual compaction itself is not gated by `enabled` (it is an explicit request), but the
    // flag must survive this overwrite so automatic compaction stays disabled afterwards.
    agent.setCompactionConfig({
      enabled: compactionConfig.enabled,
      reservePercent: compactionConfig.reservePercent,
      timeoutMs: compactionConfig.timeoutMs,
    });
    this._initializedAgent = agent;

    const unsub = agent.agentStream.subscribe((event: CoreAgentEvent) => {
      if (event.type !== "context_injected") {
        this.ctx.emit(this.enrichEvent(event, agent));
      }
      if (event.type === "compaction_end") {
        this.persistCompactionEntry({
          summary: event.summary,
          displaySummary: event.compactionSummary ? "Compacted" : event.summary,
          compactionSummary: event.compactionSummary,
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
        });
      }
    });

    let compactionResult: Awaited<ReturnType<Agent["compact"]>>;
    try {
      compactionResult = await agent.compact();
    } finally {
      unsub();
    }

    await this.ctx.persistence.waitForWrites();
    return {
      compacted: compactionResult.compacted,
      entryCount: this.ctx.state.entryCount,
      tokensBefore: compactionResult.tokensBefore,
      tokensAfter: compactionResult.tokensAfter,
      summary: compactionResult.summary,
    };
  }

  /** Queue a steering message. If agent is active, steers directly; otherwise queues locally. */
  steer(message: Message | string, id?: string): string {
    const msg: Message =
      typeof message === "string"
        ? {
            role: "user",
            content: message,
            timestamp: Date.now(),
          }
        : message;
    const steerId = id ?? `steer-${generateEntryId()}`;
    if (this._agent) {
      return this._agent.steer(msg, steerId);
    } else {
      this.pendingMessages.push({ id: steerId, message: msg });
      return steerId;
    }
  }

  cancelPendingMessage(id: string): boolean {
    if (this._agent?.cancelPendingMessage(id)) return true;
    const index = this.pendingMessages.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.pendingMessages.splice(index, 1);
    return true;
  }

  updatePendingMessage(id: string, content: string): boolean {
    if (this._agent?.updatePendingMessage(id, content)) return true;
    const msg = this.pendingMessages.find((entry) => entry.id === id)?.message;
    if (!msg || msg.role !== "user") return false;
    msg.content = updateUserMessageContent(msg.content, content);
    return true;
  }

  getPendingSteers(): PendingSteer[] {
    const agentMessages = this._agent?.getPendingSteeringMessages() ?? [];
    return [...agentMessages, ...this.pendingMessages].map(({ id, message }) => ({
      id,
      content: getUserMessageText(message) ?? "",
    }));
  }

  /** Check if pending messages exist (steering or follow-up). */
  hasPendingMessages(): boolean {
    if (this._agent) return this._agent.hasPendingMessages();
    return this.pendingMessages.length > 0;
  }

  /** Pop any undrained pending messages (from agent queue or pre-agent queue). Returns null if empty. */
  popPendingMessages(): string[] | null {
    const msgs: Message[] = [];

    if (this._agent) {
      msgs.push(...this._agent.drainPendingMessages().map((entry) => entry.message));
    }

    msgs.push(...this.pendingMessages.splice(0).map((entry) => entry.message));

    if (msgs.length === 0) return null;
    return msgs.map((m) => (m.role === "user" && typeof m.content === "string" ? m.content : ""));
  }

  private emitBusyStatus(): void {
    this.ctx.emit({ type: "status_change", status: "busy" });
  }

  private async prepareRun(userMessage: Message): Promise<{ agent: Agent; turnStager: TurnStager }> {
    this.ctx.repairEntries();

    const context = buildSessionContext(this.ctx.state.getCommittedEntries(), this.ctx.state.getCommittedLeafId(), {});
    const turnStager = new TurnStager(this.ctx.state.getCommittedLeafId(), userMessage);
    const snapshot = turnStager.getSnapshot();
    this.ctx.state.setPending(snapshot.entries, snapshot.leafId);

    const agentResult = this.resolveAgent();
    const agent = agentResult instanceof Promise ? await agentResult : agentResult;
    this._agent = agent;

    agent.setSessionId(this.ctx.persistence.sessionId);

    for (const { id, message } of this.pendingMessages.splice(0)) {
      agent.steer(message, id);
    }

    // Always forward the config — an explicit enabled:false must reach the agent, otherwise its
    // built-in default compaction config stays active and the flag silently does nothing.
    const compactionConfig = this.ctx.config.compaction;
    if (compactionConfig) {
      agent.setCompactionConfig({
        enabled: compactionConfig.enabled,
        reservePercent: compactionConfig.reservePercent,
        timeoutMs: compactionConfig.timeoutMs,
      });
    }

    if (agent !== this._initializedAgent) {
      agent.restoreCompactionState(context.providerMessages, context.compactionSummary);
      this._initializedAgent = agent;
    }

    return { agent, turnStager };
  }

  private subscribeRunEvents(prepared: { agent: Agent; turnStager: TurnStager }): {
    unsubscribe: () => void;
    getCurrentTurnId: () => string | undefined;
    getLastAgentError: () => { error: ErrorEntry["error"]; fatal: boolean } | undefined;
  } {
    const { agent, turnStager } = prepared;
    let currentTurnId: string | undefined;
    let lastAgentError: { error: ErrorEntry["error"]; fatal: boolean } | undefined;

    const unsubscribe = agent.subscribe((event: CoreAgentEvent) => {
      if (event.type === "turn_start") currentTurnId = event.turnId;
      if (event.type === "error") {
        lastAgentError = { error: event.error, fatal: event.fatal };
      }
      if (event.type === "usage") {
        this.ctx.sessionCache.handleUsage(this.ctx.persistence.sessionId, event.usage);
      }
      if (event.type === "prompt_signature") {
        this.ctx.sessionCache.handlePromptSignature(this.ctx.persistence.sessionId, event.hashes);
      }

      turnStager.handleEvent(event);
      if (event.type === "context_injected") {
        for (const injection of event.injections) {
          const presentation = readContextPresentation(injection.metadata);
          if (presentation) {
            this.ctx.emit({ type: "context_notice", source: injection.source, presentation });
          }
        }
      } else {
        this.ctx.emit(this.enrichEvent(event, agent));
      }

      if (shouldFlushTurnProgress(event)) {
        this.flushTurnProgress(turnStager);
      }

      const snapshot = turnStager.getSnapshot();
      this.ctx.state.setPending(snapshot.entries, snapshot.leafId);
    });

    return {
      unsubscribe,
      getCurrentTurnId: () => currentTurnId,
      getLastAgentError: () => lastAgentError,
    };
  }

  private async executeRun(
    agent: Agent,
    userMessage: Message,
    signal: AbortSignal | undefined,
    turnScope: StreamTurnScope,
  ): Promise<void> {
    await agent.prompt(userMessage, signal, { turnScope });
  }

  private commitRun(turnStager: TurnStager): void {
    this.ctx.appendEntries(turnStager.flushPendingEntries());
  }

  private handleRunError(
    err: unknown,
    turnStager: TurnStager,
    turnId?: string,
    agentError?: { error: ErrorEntry["error"]; fatal: boolean },
  ): void {
    const pendingEntries = turnStager.flushPendingEntries();
    this.ctx.appendEntries(pendingEntries);
    this._initializedAgent = null;
    const serializable = agentError?.error ?? toSerializableError(err);
    const lastPersisted = summarizeLastPersistedMessage(this.ctx.state.getCommittedEntries());
    // Structured, content-free run context for diagnostics sinks (Sentry tags): which
    // provider/model failed and how big the turn was. Never put conversation content here.
    const runContext = this._agent
      ? {
          provider: this._agent.model.provider,
          modelId: this._agent.model.modelId,
          toolCount: this._agent.tools.length,
          entryCount: this.ctx.state.entryCount,
        }
      : undefined;
    logger.error("run_failed", {
      sessionId: this.ctx.persistence.sessionId,
      turnId,
      message: `[SessionManager] Run error session=${this.ctx.persistence.sessionId} ${formatSerializableErrorForLog(serializable)} lastPersisted=${lastPersisted}`,
      error: err,
      fields: { lastPersisted, serializedError: serializable, runContext },
    });
    this.ctx.appendError(serializable, { fatal: false, turnId, persist: true });
  }

  private finishRun(unsubscribe: () => void): void {
    this.ctx.state.clearPending();
    unsubscribe();
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
  }

  private persistCompactionEntry(event: {
    summary: string;
    displaySummary?: string;
    compactionSummary?: Record<string, unknown>;
    tokensBefore: number;
    tokensAfter: number;
  }): void {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(),
      parentId: this.ctx.state.getCommittedLeafId(),
      timestamp: new Date().toISOString(),
      summary: event.summary,
      displaySummary: event.compactionSummary ? "Compacted" : event.displaySummary,
      compactionSummary: event.compactionSummary,
      tokensBefore: event.tokensBefore,
      tokensAfter: event.tokensAfter,
    };
    this.ctx.appendAndPersist(entry);
  }

  private flushTurnProgress(turnStager: TurnStager): void {
    const entries = turnStager.flushPendingEntries();
    if (entries.length === 0) return;
    this.ctx.appendEntries(entries);
    this.ctx.state.clearPending();
  }

  private enrichEvent(event: CoreAgentEvent, agent: Agent): AgentEvent {
    if (event.type === "usage") {
      return { ...event, cost: calculateUsageCost(agent.model, event.usage) };
    }
    if (event.type === "tool_start") {
      return {
        ...event,
        render: createToolStartRenderPayload(event.toolName, event.input),
      };
    }
    return event as AgentEvent;
  }

  /**
   * Resolve the agent. When the factory returns a Promise, this returns a Promise.
   * When it returns synchronously, this returns synchronously.
   */
  private resolveAgent(): Agent | Promise<Agent> {
    return typeof this.ctx.config.agent === "function" ? this.ctx.config.agent() : this.ctx.config.agent;
  }
}

function getUserMessageText(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function summarizeLastPersistedMessage(entries: SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "tool_result") {
      return `tool_result:${message.toolName}:error=${message.isError}`;
    }
    if (message.role === "assistant") {
      const blockTypes = message.content.map((block) => block.type).join(",") || "-";
      return `assistant:stop=${message.stopReason}:blocks=${blockTypes}`;
    }
    if (message.role === "user") {
      return "user";
    }
  }
  return "none";
}

function shouldFlushTurnProgress(event: CoreAgentEvent): boolean {
  return (
    event.type === "turn_start" ||
    (event.type === "message_end" && event.message.stopReason === "tool_use") ||
    event.type === "tool_end"
  );
}
