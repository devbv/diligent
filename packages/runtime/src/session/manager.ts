// @summary Session manager orchestrating agent loop, persistence, compaction, and steering

import type { CoreAgentEvent } from "@diligent/core/agent";
import {
  type Agent,
  formatSerializableErrorForLog,
  selectForCompaction,
  toSerializableError,
} from "@diligent/core/agent";
import type { Message } from "@diligent/core/types";
import type { Mode } from "../agent/mode";
import type { AgentEvent } from "../agent-event";
import { calculateUsageCost } from "../cost";
import type { DiligentPaths } from "../infrastructure";
import { createToolStartRenderPayload } from "../tools/render-strategies";
import { buildSessionContext, buildSessionTranscript } from "./context-builder";
import { SessionPersistence, type SessionReconcileResult } from "./persistence";
import { SessionStateStore } from "./state-store";
import { TurnStager } from "./turn-stager";
import type {
  CollabSessionMeta,
  CompactionEntry,
  EffortChangeEntry,
  ErrorEntry,
  ModeChangeEntry,
  ModelChangeEntry,
  SessionEntry,
  SessionInfo,
} from "./types";
import { generateEntryId } from "./types";

export interface SessionManagerConfig {
  cwd: string;
  paths: DiligentPaths;
  // D087: Factory allows per-run config (e.g. collaboration mode, mid-session knowledge refresh)
  agent: Agent | (() => Agent | Promise<Agent>);
  compaction?: {
    enabled: boolean;
    reservePercent: number;
    keepRecentTokens: number;
    timeoutMs?: number;
  };
  knowledgePath?: string;
  sessionId?: string;
  parentSession?: string;
  /** When spawned as a sub-agent, identity info persisted in session header */
  collabMeta?: CollabSessionMeta;
  /**
   * Called after each successful turn (normal completion, not abort or error).
   * Return `{ continueWith }` to re-run the agent with a follow-up message
   * (e.g. when a Stop hook blocks). On re-runs, `isRerun` is true so hooks
   * can set `stop_hook_active` and avoid infinite loops.
   */
  onStop?: (context: Message[], isRerun: boolean) => Promise<{ continueWith?: Message } | undefined>;
}

export interface ResumeSessionOptions {
  sessionId?: string;
  mostRecent?: boolean;
}

export class SessionManager {
  private state = new SessionStateStore();
  private persistence: SessionPersistence;
  /** Pre-agent steering queue — drained into agent at start of run() */
  private pendingMessages: Message[] = [];
  private memoryErrors: ErrorEntry[] = [];
  private listeners = new Set<(event: AgentEvent) => void>();
  /** Cached agent instance — persists between runs for the session lifetime */
  private _agent: Agent | null = null;
  private prevCacheReadBySession = new Map<string, number>();
  private prevPromptHashesBySession = new Map<string, string[]>();
  private currPromptHashesBySession = new Map<string, string[]>();
  private promptSignatureCountBySession = new Map<string, number>();
  /** Track which agent instance has been restored with session history */
  private _initializedAgent: Agent | null = null;

  constructor(private config: SessionManagerConfig) {
    this.persistence = new SessionPersistence({
      sessionsDir: config.paths.sessions,
      cwd: config.cwd,
      parentSession: config.parentSession,
      collabMeta: config.collabMeta,
      sessionId: config.sessionId,
    });
  }

  /** Create a new session */
  async create(): Promise<void> {
    this.state.reset();
    this.resetUsageDebugState();
    this._initializedAgent = null;
    this.persistence.resetForCreate();
    await this.persistence.create();
  }

  /** Resume an existing session */
  async resume(options: ResumeSessionOptions): Promise<boolean> {
    this.resetUsageDebugState();
    const entries = await this.persistence.resume(options);
    if (!entries) return false;

    this.state.replaceCommitted(entries);
    this._initializedAgent = null;

    this.repairEntries();

    return true;
  }

  /** Repair orphaned tool_calls on resume — inject synthetic "interrupted" tool_results. */
  private repairEntries(): void {
    const path = this.state.getPathEntries();
    if (path.length === 0) return;

    const last = path[path.length - 1];
    if (last.type !== "message" || last.message.role !== "assistant") return;

    const assistantMsg = last.message;
    const toolCalls = assistantMsg.content.filter((b) => b.type === "tool_call");
    if (toolCalls.length === 0) return;

    const toolCallIds = new Set(toolCalls.map((b) => (b as { id: string }).id));
    for (const entry of path) {
      if (entry.type === "message" && entry.message.role === "tool_result") {
        toolCallIds.delete((entry.message as { toolCallId: string }).toolCallId);
      }
    }

    for (const id of toolCallIds) {
      const block = toolCalls.find((b) => (b as { id: string }).id === id);
      this.appendMessageEntry({
        role: "tool_result",
        toolCallId: id,
        toolName: (block as { name: string })?.name ?? "unknown",
        output: "[Cancelled]",
        isError: false,
        timestamp: assistantMsg.timestamp,
      });
    }
  }

  /** List available sessions */
  async list(): Promise<SessionInfo[]> {
    return this.persistence.list();
  }

  /** Scan session entries for spawn_agent tool results to restore collab thread IDs on resume. */
  getHistoricalCollabAgents(): Array<{ threadId: string; nickname: string }> {
    const results: Array<{ threadId: string; nickname: string }> = [];
    for (const entry of this.state.getCommittedEntries()) {
      if (
        entry.type === "message" &&
        entry.message.role === "tool_result" &&
        (entry.message as { toolName?: string }).toolName === "spawn_agent" &&
        !(entry.message as { isError?: boolean }).isError
      ) {
        try {
          const parsed = JSON.parse((entry.message as { output: string }).output);
          if (parsed.thread_id && parsed.nickname) {
            results.push({ threadId: parsed.thread_id, nickname: parsed.nickname });
          }
        } catch {
          // skip malformed output
        }
      }
    }
    return results;
  }

  /** Get the current message context for display (e.g., after resume) */
  getContext(): Message[] {
    const { entries, leafId } = this.state.getVisibleState();
    const context = buildSessionContext(entries, leafId, {});
    return context.messages;
  }

  /** Get the full raw transcript for human-facing UIs. */
  getTranscript() {
    const { entries, leafId } = this.state.getVisibleState();
    return buildSessionTranscript(entries, leafId);
  }

  getErrors(): ErrorEntry[] {
    return this.memoryErrors;
  }

  getCurrentModel(): { provider: string; modelId: string } | undefined {
    return buildSessionContext(this.state.getCommittedEntries(), this.state.getCommittedLeafId(), {}).currentModel;
  }

  /**
   * Reconcile in-memory entries with the persisted session file.
   */
  async reconcileFromDisk(): Promise<SessionReconcileResult> {
    const reconciled = await this.persistence.reconcile({
      committedEntries: this.state.getCommittedEntries(),
      committedLeafId: this.state.getCommittedLeafId(),
      summarizeTailEntryIds,
      summarizeLastPersistedMessage,
    });

    if (reconciled.entries) {
      this.state.replaceCommitted(reconciled.entries);
    }

    return reconciled.result;
  }

  getCurrentEffort(): "none" | "low" | "medium" | "high" | "max" | undefined {
    return buildSessionContext(this.state.getCommittedEntries(), this.state.getCommittedLeafId(), {}).currentEffort;
  }

  async compactNow(): Promise<{
    compacted: boolean;
    entryCount: number;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
  }> {
    await this.waitForWrites();
    const context = buildSessionContext(this.state.getCommittedEntries(), this.state.getCommittedLeafId(), {});
    const compactionConfig = this.config.compaction ?? {
      enabled: true,
      reservePercent: 16,
      keepRecentTokens: 20000,
      timeoutMs: 180_000,
    };

    const agentResult = this.resolveAgent();
    const agent = agentResult instanceof Promise ? await agentResult : agentResult;
    agent.restoreCompactionState(context.providerMessages, context.compactionSummary);
    agent.setCompactionConfig({
      reservePercent: compactionConfig.reservePercent,
      keepRecentTokens: compactionConfig.keepRecentTokens,
    });
    this._initializedAgent = agent;

    let tokensBefore = 0;
    let tokensAfter = 0;
    let summary = "";
    const unsub = agent.agentStream.subscribe((event: CoreAgentEvent) => {
      this.emitToListeners(event);
      if (event.type === "compaction_end") {
        tokensBefore = event.tokensBefore;
        tokensAfter = event.tokensAfter;
        summary = event.summary;
        this.persistCompactionEntry({
          summary: event.summary,
          displaySummary: event.compactionSummary ? "Compacted" : event.summary,
          recentUserMessages: selectForCompaction(context.messages, compactionConfig.keepRecentTokens)
            .recentUserMessages,
          compactionSummary: event.compactionSummary,
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
        });
      }
    });

    try {
      await agent.compact();
    } finally {
      unsub();
    }

    await this.waitForWrites();
    return { compacted: true, entryCount: this.entryCount, tokensBefore, tokensAfter, summary };
  }

  appendModelChange(provider: string, modelId: string): void {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: generateEntryId(),
      parentId: this.state.getCommittedLeafId(),
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.appendAndPersist(entry);
  }

  /**
   * Subscribe to session events (CoreAgentEvent relayed from agent + RuntimeAgentEvent from manager).
   * Returns an unsubscribe function.
   */
  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Run the agent loop with the current session context.
   * Persists user message and agent response to session.
   * Compaction is handled by the Agent internally.
   */
  async run(userMessage: Message, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.runInternal(userMessage, opts, false);
  }

  private async runInternal(
    userMessage: Message,
    opts: { signal?: AbortSignal } | undefined,
    isRerun: boolean,
  ): Promise<void> {
    this.emitBusyStatus();

    const prepared = await this.prepareRun(userMessage);
    const { unsubscribe, getCurrentTurnId, getLastAgentError } = this.subscribeRunEvents(prepared);

    let normalCompletion = false;
    try {
      await this.executeRun(prepared.agent, userMessage, opts?.signal);
      this.commitRun(prepared.turnStager);
      normalCompletion = true;
    } catch (err) {
      this.handleRunError(err, prepared.turnStager, getCurrentTurnId(), getLastAgentError());
    } finally {
      this.finishRun(unsubscribe);
    }

    this.throwIfAborted(opts?.signal);

    if (normalCompletion && this.config.onStop) {
      const result = await this.config.onStop(this.getContext(), isRerun);
      if (result?.continueWith && !opts?.signal?.aborted) {
        await this.runInternal(result.continueWith, opts, true);
      }
    }
  }

  /** Wait for all pending writes to complete. */
  async waitForWrites(): Promise<void> {
    await this.persistence.waitForWrites();
  }

  private emitBusyStatus(): void {
    for (const fn of this.listeners) fn({ type: "status_change", status: "busy" });
  }

  private async prepareRun(userMessage: Message): Promise<{ agent: Agent; turnStager: TurnStager }> {
    this.repairEntries();

    const context = buildSessionContext(this.state.getCommittedEntries(), this.state.getCommittedLeafId(), {});
    const turnStager = new TurnStager(this.state.getCommittedLeafId(), context.messages, userMessage);
    const snapshot = turnStager.getSnapshot();
    this.state.setPending(snapshot.entries, snapshot.leafId);

    const agentResult = this.resolveAgent();
    const agent = agentResult instanceof Promise ? await agentResult : agentResult;
    this._agent = agent;

    agent.setSessionId(this.persistence.sessionId);

    for (const msg of this.pendingMessages.splice(0)) {
      agent.steer(msg);
    }

    const compactionConfig = this.config.compaction;
    if (compactionConfig?.enabled) {
      agent.setCompactionConfig({
        reservePercent: compactionConfig.reservePercent,
        keepRecentTokens: compactionConfig.keepRecentTokens,
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
        this.handleUsageEvent(event.usage);
      }
      if (event.type === "prompt_signature") {
        this.handlePromptSignatureEvent(event.hashes);
      }

      const keepRecentTokens = this.config.compaction?.keepRecentTokens ?? 20_000;
      turnStager.handleEvent(event, keepRecentTokens);
      this.emitToListeners(event);

      if (shouldFlushTurnProgress(event)) {
        this.flushTurnProgress(turnStager);
      }

      const snapshot = turnStager.getSnapshot();
      this.state.setPending(snapshot.entries, snapshot.leafId);
    });

    return {
      unsubscribe,
      getCurrentTurnId: () => currentTurnId,
      getLastAgentError: () => lastAgentError,
    };
  }

  private async executeRun(agent: Agent, userMessage: Message, signal?: AbortSignal): Promise<void> {
    await agent.prompt(userMessage, signal);
  }

  private commitRun(turnStager: TurnStager): void {
    this.appendEntries(turnStager.flushPendingEntries());
  }

  private handleRunError(
    err: unknown,
    turnStager: TurnStager,
    turnId?: string,
    agentError?: { error: ErrorEntry["error"]; fatal: boolean },
  ): void {
    const pendingEntries = turnStager.flushPendingEntries();
    this.appendEntries(pendingEntries);
    const serializable = agentError?.error ?? toSerializableError(err);
    console.error(
      "[SessionManager] Run error session=%s %s lastPersisted=%s",
      this.persistence.sessionId,
      formatSerializableErrorForLog(serializable),
      summarizeLastPersistedMessage(this.state.getCommittedEntries()),
    );
    this.appendError(serializable, { fatal: false, turnId, persist: true });
  }

  private finishRun(unsubscribe: () => void): void {
    this.state.clearPending();
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
    recentUserMessages?: Message[];
    compactionSummary?: Record<string, unknown>;
    tokensBefore: number;
    tokensAfter: number;
  }): void {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(),
      parentId: this.state.getCommittedLeafId(),
      timestamp: new Date().toISOString(),
      summary: event.summary,
      displaySummary: event.compactionSummary ? "Compacted" : event.displaySummary,
      recentUserMessages: event.recentUserMessages,
      compactionSummary: event.compactionSummary,
      tokensBefore: event.tokensBefore,
      tokensAfter: event.tokensAfter,
    };
    this.appendAndPersist(entry);
  }

  /** Queue a steering message. If agent is active, steers directly; otherwise queues locally. */
  steer(message: Message | string): void {
    const msg: Message =
      typeof message === "string"
        ? {
            role: "user",
            content: message,
            timestamp: Date.now(),
          }
        : message;
    if (this._agent) {
      this._agent.steer(msg);
    } else {
      this.pendingMessages.push(msg);
    }
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
      msgs.push(...this._agent.drainPendingMessages());
    }

    msgs.push(...this.pendingMessages.splice(0));

    if (msgs.length === 0) return null;
    return msgs.map((m) => (m.role === "user" && typeof m.content === "string" ? m.content : ""));
  }

  appendModeChange(mode: Mode, changedBy: ModeChangeEntry["changedBy"] = "command"): void {
    const entry: ModeChangeEntry = {
      type: "mode_change",
      id: generateEntryId(),
      parentId: this.state.getCommittedLeafId(),
      timestamp: new Date().toISOString(),
      mode,
      changedBy,
    };
    this.appendAndPersist(entry);
  }

  appendEffortChange(
    effort: "none" | "low" | "medium" | "high" | "max",
    changedBy: EffortChangeEntry["changedBy"] = "command",
  ): void {
    const entry: EffortChangeEntry = {
      type: "effort_change",
      id: generateEntryId(),
      parentId: this.state.getCommittedLeafId(),
      timestamp: new Date().toISOString(),
      effort,
      changedBy,
    };
    this.appendAndPersist(entry);
  }

  appendError(error: ErrorEntry["error"], options?: { fatal?: boolean; turnId?: string; persist?: boolean }): void {
    const entry: ErrorEntry = {
      type: "error",
      id: generateEntryId(),
      parentId: this.state.getCommittedLeafId(),
      timestamp: new Date().toISOString(),
      turnId: options?.turnId,
      fatal: options?.fatal ?? false,
      error,
    };
    this.memoryErrors.push(entry);
    if (options?.persist) {
      this.appendAndPersist(entry);
    }
  }

  private appendMessageEntry(message: Message): SessionEntry {
    const entry = this.createMessageEntry(message, this.state.getCommittedLeafId());
    this.appendEntries([entry]);
    return entry;
  }

  private handleUsageEvent(usage: { cacheReadTokens: number }): void {
    const sessionId = this.persistence.sessionId;
    const prevCacheRead = this.prevCacheReadBySession.get(sessionId) ?? 0;
    const currCacheRead = usage.cacheReadTokens;
    const turn = this.promptSignatureCountBySession.get(sessionId) ?? 0;
    const prevPromptHashes = this.prevPromptHashesBySession.get(sessionId) ?? [];
    const currPromptHashes = this.currPromptHashesBySession.get(sessionId) ?? [];
    const commonPrefix = sharedPrefixLength(prevPromptHashes, currPromptHashes);

    if (prevCacheRead - currCacheRead >= 4096) {
      this.emitPrefixCompareLog({
        sessionId,
        turn,
        prevCacheRead,
        currCacheRead,
        commonPrefix,
        prevPromptHashes,
        currPromptHashes,
        reason: "cache_read_decreased",
      });
    }
    if (turn >= 2 && currCacheRead === 0) {
      this.emitPrefixCompareLog({
        sessionId,
        turn,
        prevCacheRead,
        currCacheRead,
        commonPrefix,
        prevPromptHashes,
        currPromptHashes,
        reason: "turn_ge_2_cache_read_zero",
      });
    }

    this.prevCacheReadBySession.set(sessionId, currCacheRead);
  }

  private handlePromptSignatureEvent(hashes: string[]): void {
    const sessionId = this.persistence.sessionId;
    const prev = this.currPromptHashesBySession.get(sessionId);
    if (prev) {
      this.prevPromptHashesBySession.set(sessionId, prev);
    }
    this.currPromptHashesBySession.set(sessionId, hashes);
    this.promptSignatureCountBySession.set(sessionId, (this.promptSignatureCountBySession.get(sessionId) ?? 0) + 1);
  }

  private emitPrefixCompareLog(payload: {
    sessionId: string;
    turn: number;
    prevCacheRead: number;
    currCacheRead: number;
    commonPrefix: number;
    prevPromptHashes: string[];
    currPromptHashes: string[];
    reason: "cache_read_decreased" | "turn_ge_2_cache_read_zero";
  }): void {
    console.error(
      `[usage:prefix-compare] session=${payload.sessionId} turn=${payload.turn} prevCacheRead=${payload.prevCacheRead} currCacheRead=${payload.currCacheRead} commonPrefix=${payload.commonPrefix} prevHashes=${JSON.stringify(payload.prevPromptHashes)} currHashes=${JSON.stringify(payload.currPromptHashes)} reason=${payload.reason}`,
    );
  }

  private resetUsageDebugState(): void {
    this.prevCacheReadBySession.clear();
    this.prevPromptHashesBySession.clear();
    this.currPromptHashesBySession.clear();
    this.promptSignatureCountBySession.clear();
  }

  private createMessageEntry(message: Message, parentId: string | null): SessionEntry {
    return {
      type: "message",
      id: generateEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      message,
    };
  }

  private appendAndPersist(entry: SessionEntry): void {
    this.state.appendCommitted([entry]);
    this.persistence.append(entry, (error) => {
      const detail = entry.type === "message" ? entry.message.role : entry.type;
      console.error(
        "[SessionManager] Failed to persist %s for session=%s: %s",
        detail,
        this.persistence.sessionId,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private appendEntries(entries: SessionEntry[]): void {
    if (entries.length === 0) return;
    this.state.appendCommitted(entries);
    this.persistence.appendMany(entries, (error, entry) => {
      const detail = entry.type === "message" ? entry.message.role : entry.type;
      console.error(
        "[SessionManager] Failed to persist %s for session=%s: %s",
        detail,
        this.persistence.sessionId,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private flushTurnProgress(turnStager: TurnStager): void {
    const entries = turnStager.flushPendingEntries();
    if (entries.length === 0) return;
    this.appendEntries(entries);
    this.state.clearPending();
  }

  private emitToListeners(event: CoreAgentEvent): void {
    const enriched: AgentEvent =
      event.type === "usage" && this._agent
        ? { ...event, cost: calculateUsageCost(this._agent.model, event.usage) }
        : event.type === "tool_start"
          ? {
              ...event,
              render: createToolStartRenderPayload(event.toolName, event.input),
            }
          : (event as AgentEvent);
    for (const fn of this.listeners) fn(enriched);
  }

  /**
   * Resolve the agent. When the factory returns a Promise, this returns a Promise.
   * When it returns synchronously, this returns synchronously.
   */
  private resolveAgent(): Agent | Promise<Agent> {
    return typeof this.config.agent === "function" ? this.config.agent() : this.config.agent;
  }

  get sessionPath(): string | null {
    return this.persistence.sessionPath;
  }

  get sessionId(): string {
    return this.persistence.sessionId;
  }

  get entryCount(): number {
    return this.state.entryCount;
  }

  dispose(): void {
    this.resetUsageDebugState();
  }
}

function summarizeLastPersistedMessage(entries: SessionEntry[]): string {
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

function summarizeTailEntryIds(entries: SessionEntry[], count = 3): string {
  if (entries.length === 0) return "-";
  return entries
    .slice(Math.max(0, entries.length - count))
    .map((entry) => entry.id)
    .join(",");
}

function shouldFlushTurnProgress(event: CoreAgentEvent): boolean {
  return (event.type === "message_end" && event.message.stopReason === "tool_use") || event.type === "tool_end";
}

function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) {
    index += 1;
  }
  return index;
}
