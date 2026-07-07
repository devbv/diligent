// @summary Session manager orchestrating agent loop, persistence, compaction, and steering

import type { Message } from "@diligent/core/types";
import type { PendingSteer } from "@diligent/protocol";
import type { Mode } from "../agent/mode";
import type { AgentEvent } from "../agent-event";
import { CollabSessionHandler } from "./collab-session-handler";
import { buildSessionContext, buildSessionTranscript } from "./context-builder";
import { SessionPersistence, type SessionReconcileResult } from "./persistence";
import { SessionCache } from "./session-cache";
import { SessionStateStore } from "./state-store";
import { summarizeLastPersistedMessage, TurnOrchestrator } from "./turn-orchestrator";
import type {
  EffortChangeEntry,
  ErrorEntry,
  ModeChangeEntry,
  ModelChangeEntry,
  ResumeSessionOptions,
  SessionEntry,
  SessionInfo,
  SessionManagerConfig,
} from "./types";
import { generateEntryId } from "./types";

export type { ResumeSessionOptions, SessionManagerConfig };

export class SessionManager {
  private state = new SessionStateStore();
  private persistence: SessionPersistence;
  private sessionCache = new SessionCache();
  private listeners = new Set<(event: AgentEvent) => void>();
  private memoryErrors: ErrorEntry[] = [];
  private collabHandler: CollabSessionHandler;
  private orchestrator: TurnOrchestrator;

  constructor(config: SessionManagerConfig) {
    this.persistence = new SessionPersistence({
      sessionsDir: config.paths.sessions,
      cwd: config.cwd,
      parentSession: config.parentSession,
      collabMeta: config.collabMeta,
      sessionId: config.sessionId,
      onEntryAppended: config.onEntryAppended,
    });
    this.collabHandler = new CollabSessionHandler(() => this.state.getCommittedEntries());
    this.orchestrator = new TurnOrchestrator({
      state: this.state,
      persistence: this.persistence,
      config,
      sessionCache: this.sessionCache,
      emit: (event) => this.emitToListeners(event),
      appendEntries: (entries) => this.appendEntries(entries),
      appendAndPersist: (entry) => this.appendAndPersist(entry),
      appendError: (error, opts) => this.appendError(error, opts),
      repairEntries: () => this.repairEntries(),
      getContext: () => this.getContext(),
    });
  }

  /** Create a new session */
  async create(): Promise<void> {
    this.state.reset();
    this.sessionCache.reset();
    this.orchestrator.resetAgentState();
    this.persistence.resetForCreate();
    await this.persistence.create();
  }

  /** Resume an existing session */
  async resume(options: ResumeSessionOptions): Promise<boolean> {
    this.sessionCache.reset();
    this.orchestrator.resetAgentState();
    const entries = await this.persistence.resume(options);
    if (!entries) return false;

    this.state.replaceCommitted(entries);

    this.repairEntries();

    return true;
  }

  /** Repair orphaned tool_calls on resume/run — inject synthetic "interrupted" tool_results. */
  private repairEntries(): void {
    const path = this.state.getPathEntries();
    if (path.length === 0) return;

    for (let index = 0; index < path.length; index++) {
      const entry = path[index];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;

      const toolCalls = entry.message.content.filter((block) => block.type === "tool_call");
      if (toolCalls.length === 0) continue;

      const expectedIds = new Set(toolCalls.map((block) => block.id));
      const seenIds = new Set<string>();
      let parentId = entry.id;
      for (let nextIndex = index + 1; nextIndex < path.length; nextIndex++) {
        const nextEntry = path[nextIndex];
        if (nextEntry.type !== "message" || nextEntry.message.role !== "tool_result") break;
        parentId = nextEntry.id;
        if (expectedIds.has(nextEntry.message.toolCallId)) {
          seenIds.add(nextEntry.message.toolCallId);
        }
      }

      const repairEntries: SessionEntry[] = [];
      for (const toolCall of toolCalls) {
        if (seenIds.has(toolCall.id)) continue;

        const repairEntry = this.createMessageEntry(
          {
            role: "tool_result",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            output: "[Cancelled]",
            isError: false,
            timestamp: entry.message.timestamp,
          },
          parentId,
        );
        repairEntries.push(repairEntry);
        parentId = repairEntry.id;
      }

      if (repairEntries.length > 0) {
        this.appendEntries(repairEntries);
        return;
      }
    }
  }

  /** List available sessions */
  async list(): Promise<SessionInfo[]> {
    return this.persistence.list();
  }

  /** Scan session entries for spawn_agent tool results to restore collab thread IDs on resume. */
  getHistoricalCollabAgents(): Array<{ threadId: string; nickname: string }> {
    return this.collabHandler.getHistoricalCollabAgents();
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

  getCurrentMode(): Mode | undefined {
    return buildSessionContext(this.state.getCommittedEntries(), this.state.getCommittedLeafId(), {}).currentMode;
  }

  async compactNow(): Promise<{
    compacted: boolean;
    entryCount: number;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
  }> {
    return this.orchestrator.compactNow();
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
    await this.orchestrator.run(userMessage, opts);
  }

  /** Wait for all pending writes to complete. */
  async waitForWrites(): Promise<void> {
    await this.persistence.waitForWrites();
  }

  /** Queue a steering message. If agent is active, steers directly; otherwise queues locally. */
  steer(message: Message | string, id?: string): string {
    return this.orchestrator.steer(message, id);
  }

  cancelPendingMessage(id: string): boolean {
    return this.orchestrator.cancelPendingMessage(id);
  }

  updatePendingMessage(id: string, content: string): boolean {
    return this.orchestrator.updatePendingMessage(id, content);
  }

  getPendingSteers(): PendingSteer[] {
    return this.orchestrator.getPendingSteers();
  }

  /** Check if pending messages exist (steering or follow-up). */
  hasPendingMessages(): boolean {
    return this.orchestrator.hasPendingMessages();
  }

  /** Pop any undrained pending messages (from agent queue or pre-agent queue). Returns null if empty. */
  popPendingMessages(): string[] | null {
    return this.orchestrator.popPendingMessages();
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

  private emitToListeners(event: AgentEvent): void {
    for (const fn of this.listeners) fn(event);
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
    this.sessionCache.reset();
  }
}

function summarizeTailEntryIds(entries: SessionEntry[], count = 3): string {
  if (entries.length === 0) return "-";
  return entries
    .slice(Math.max(0, entries.length - count))
    .map((entry) => entry.id)
    .join(",");
}
