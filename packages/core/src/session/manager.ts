import { agentLoop } from "../agent/loop";
import type { AgentEvent, AgentLoopConfig, ModeKind } from "../agent/types";
import { EventStream } from "../event-stream";
import type { DiligentPaths } from "../infrastructure/diligent-dir";
import { ProviderError } from "../provider/types";
import type { Message } from "../types";
import { estimateTokens, extractFileOperations, findCutPoint, generateSummary, shouldCompact } from "./compaction";
import { buildSessionContext } from "./context-builder";
import { DeferredWriter, listSessions, readSessionFile } from "./persistence";
import type { CompactionEntry, ModeChangeEntry, SessionEntry, SessionInfo, SessionMessageEntry } from "./types";
import { generateEntryId } from "./types";

export interface SessionManagerConfig {
  cwd: string;
  paths: DiligentPaths;
  // D087: Factory allows per-run config (e.g. collaboration mode, mid-session knowledge refresh)
  agentConfig: AgentLoopConfig | (() => AgentLoopConfig);
  compaction?: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
  knowledgePath?: string;
  sessionId?: string;
}

export interface ResumeSessionOptions {
  sessionId?: string;
  mostRecent?: boolean;
}

export class SessionManager {
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private writer: DeferredWriter;
  private byId = new Map<string, SessionEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private config: SessionManagerConfig) {
    this.writer = new DeferredWriter(config.paths.sessions, config.cwd);
  }

  /** Create a new session */
  async create(): Promise<void> {
    this.entries = [];
    this.leafId = null;
    this.byId.clear();
    this.writeQueue = Promise.resolve();
    this.writer = new DeferredWriter(this.config.paths.sessions, this.config.cwd);
  }

  /** Resume an existing session */
  async resume(options: ResumeSessionOptions): Promise<boolean> {
    let sessionPath: string | undefined;

    if (options.sessionId) {
      const sessions = await listSessions(this.config.paths.sessions);
      const session = sessions.find((s) => s.id === options.sessionId);
      sessionPath = session?.path;
    } else if (options.mostRecent) {
      const sessions = await listSessions(this.config.paths.sessions);
      sessionPath = sessions[0]?.path;
    }

    if (!sessionPath) return false;

    const { entries } = await readSessionFile(sessionPath);
    this.entries = entries;
    this.byId.clear();
    for (const entry of entries) {
      this.byId.set(entry.id, entry);
    }
    this.leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
    this.writeQueue = Promise.resolve();
    this.writer = new DeferredWriter(this.config.paths.sessions, this.config.cwd, sessionPath);

    return true;
  }

  /** List available sessions */
  async list(): Promise<SessionInfo[]> {
    return listSessions(this.config.paths.sessions);
  }

  /** Get the current message context for display (e.g., after resume) */
  getContext(): Message[] {
    const context = buildSessionContext(this.entries, this.leafId);
    return context.messages;
  }

  /**
   * Run the agent loop with the current session context.
   * Persists user message and agent response to session.
   * Handles proactive and reactive compaction.
   */
  run(userMessage: Message): EventStream<AgentEvent, Message[]> {
    // 1. Add user message to entries (queued persistence)
    this.appendMessageEntry(userMessage);

    // 2. Build context from tree
    const context = buildSessionContext(this.entries, this.leafId);

    // 3. Compaction config
    const compactionConfig = this.config.compaction ?? {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    };

    // 4. Create outer stream that wraps the agent loop
    const outerStream = new EventStream<AgentEvent, Message[]>(
      (event) => event.type === "agent_end",
      (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
    );

    this.runWithCompaction(context.messages, compactionConfig, outerStream).catch((err) => {
      outerStream.push({
        type: "error",
        error: { message: String(err), name: err?.name ?? "Error" },
        fatal: true,
      });
      outerStream.push({ type: "agent_end", messages: context.messages });
      outerStream.end(context.messages);
    });

    return outerStream;
  }

  /** Wait for all pending writes to complete. */
  async waitForWrites(): Promise<void> {
    await this.writeQueue;
  }

  private async runWithCompaction(
    messages: Message[],
    compactionConfig: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
    outerStream: EventStream<AgentEvent, Message[]>,
  ): Promise<void> {
    let currentMessages = messages;

    // Proactive compaction check
    if (compactionConfig.enabled) {
      const tokens = estimateTokens(currentMessages);
      if (shouldCompact(tokens, this.resolveAgentConfig().model.contextWindow, compactionConfig.reserveTokens)) {
        currentMessages = await this.performCompaction(tokens, compactionConfig, outerStream);
      }
    }

    // Run agent loop and proxy events
    try {
      await this.proxyAgentLoop(currentMessages, outerStream);
    } catch (err) {
      // Reactive compaction on context overflow
      if (err instanceof ProviderError && err.errorType === "context_overflow" && compactionConfig.enabled) {
        const tokens = estimateTokens(currentMessages);
        currentMessages = await this.performCompaction(tokens, compactionConfig, outerStream);
        await this.proxyAgentLoop(currentMessages, outerStream);
        return;
      }
      throw err;
    }
  }

  private async proxyAgentLoop(messages: Message[], outerStream: EventStream<AgentEvent, Message[]>): Promise<void> {
    const agentStream = agentLoop(messages, this.resolveAgentConfig());

    let fatalError: AgentEvent | null = null;

    for await (const event of agentStream) {
      this.handleEvent(event);

      // Intercept fatal errors before forwarding — check if it's context_overflow
      if (event.type === "error" && event.fatal) {
        fatalError = event;
        continue;
      }

      outerStream.push(event);
    }

    // If we got a fatal error, check if it's context_overflow
    if (fatalError && fatalError.type === "error") {
      const msg = fatalError.error.message.toLowerCase();
      const isContextOverflow =
        msg.includes("context") ||
        msg.includes("too many tokens") ||
        msg.includes("maximum") ||
        msg.includes("context_overflow");

      if (isContextOverflow) {
        throw new ProviderError(fatalError.error.message, "context_overflow", false);
      }

      // Not context overflow — forward the error
      outerStream.push(fatalError);
    }

    const result = await agentStream.result();
    outerStream.push({ type: "agent_end", messages: result });
    outerStream.end(result);
  }

  private async performCompaction(
    tokensBefore: number,
    compactionConfig: { reserveTokens: number; keepRecentTokens: number },
    stream: EventStream<AgentEvent, Message[]>,
  ): Promise<Message[]> {
    stream.push({ type: "compaction_start", estimatedTokens: tokensBefore });

    // Find cut point from path entries
    const pathEntries = this.getPathEntries();
    const cutResult = findCutPoint(pathEntries, compactionConfig.keepRecentTokens);

    if (cutResult.entriesToSummarize.length === 0) {
      // Nothing to compact — all entries fit in the keep budget
      const context = buildSessionContext(this.entries, this.leafId);
      stream.push({
        type: "compaction_end",
        tokensBefore,
        tokensAfter: tokensBefore,
        summary: "(no compaction needed)",
      });
      return context.messages;
    }

    // Find previous compaction for iterative updating
    const previousCompaction = this.findPreviousCompaction();

    // Extract messages to summarize
    const messagesToSummarize = cutResult.entriesToSummarize
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);

    // Extract file operations (D039)
    const details = extractFileOperations(messagesToSummarize, previousCompaction?.details);

    // Generate summary (D037)
    const summary = await generateSummary(
      messagesToSummarize,
      this.resolveAgentConfig().streamFunction,
      this.resolveAgentConfig().model,
      { previousSummary: previousCompaction?.summary, signal: this.resolveAgentConfig().signal },
    );

    // Save CompactionEntry
    const firstKept = cutResult.entriesToKeep[0];
    const compactionEntry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId: firstKept.id,
      tokensBefore,
      tokensAfter: 0, // will be calculated after rebuild
      details,
    };

    this.entries.push(compactionEntry);
    this.byId.set(compactionEntry.id, compactionEntry);
    this.leafId = compactionEntry.id;
    this.writeQueue = this.writeQueue.then(() => this.writer.write(compactionEntry)).catch(() => {});

    // Rebuild context with compaction
    const newContext = buildSessionContext(this.entries, this.leafId);
    const tokensAfter = estimateTokens(newContext.messages);

    // Update tokensAfter in the entry
    compactionEntry.tokensAfter = tokensAfter;

    stream.push({
      type: "compaction_end",
      tokensBefore,
      tokensAfter,
      summary: summary.length > 200 ? `${summary.slice(0, 200)}...` : summary,
    });

    return newContext.messages;
  }

  /** Get the linear path of entries from root to leaf */
  private getPathEntries(): SessionEntry[] {
    if (this.entries.length === 0 || !this.leafId) return [];

    const path: SessionEntry[] = [];
    let current: SessionEntry | undefined = this.byId.get(this.leafId);
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  /** Find the most recent CompactionEntry in the current path */
  private findPreviousCompaction(): CompactionEntry | undefined {
    const path = this.getPathEntries();
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].type === "compaction") {
        return path[i] as CompactionEntry;
      }
    }
    return undefined;
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === "message_end") {
      this.appendMessageEntry(event.message);
    } else if (event.type === "turn_end") {
      for (const toolResult of event.toolResults) {
        this.appendMessageEntry(toolResult);
      }
    }
  }

  appendModeChange(mode: ModeKind, changedBy: ModeChangeEntry["changedBy"] = "command"): void {
    const entry: ModeChangeEntry = {
      type: "mode_change",
      id: generateEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      mode,
      changedBy,
    };
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.writeQueue = this.writeQueue.then(() => this.writer.write(entry)).catch(() => {});
  }

  private appendMessageEntry(message: Message): SessionEntry {
    const entry: SessionEntry = {
      type: "message",
      id: generateEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };

    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;

    // Chain writes to avoid concurrent file access
    this.writeQueue = this.writeQueue.then(() => this.writer.write(entry)).catch(() => {});

    return entry;
  }

  private resolveAgentConfig(): AgentLoopConfig {
    return typeof this.config.agentConfig === "function" ? this.config.agentConfig() : this.config.agentConfig;
  }

  get sessionPath(): string | null {
    return this.writer.path;
  }

  get entryCount(): number {
    return this.entries.length;
  }
}
