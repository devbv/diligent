import { agentLoop } from "../agent/loop";
import type { AgentEvent, AgentLoopConfig } from "../agent/types";
import type { EventStream } from "../event-stream";
import type { DiligentPaths } from "../infrastructure/diligent-dir";
import type { Message } from "../types";
import { buildSessionContext } from "./context-builder";
import { DeferredWriter, listSessions, readSessionFile } from "./persistence";
import type { SessionEntry, SessionInfo } from "./types";
import { generateEntryId } from "./types";

export interface SessionManagerConfig {
  cwd: string;
  paths: DiligentPaths;
  agentConfig: AgentLoopConfig;
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
   * The returned EventStream can be consumed by the TUI (for await).
   * SessionManager subscribes as an observer for persistence.
   */
  run(userMessage: Message): EventStream<AgentEvent, Message[]> {
    // 1. Add user message to entries (queued persistence)
    this.appendEntry({ type: "message", message: userMessage });

    // 2. Build context from tree
    const context = buildSessionContext(this.entries, this.leafId);

    // 3. Run agent loop
    const stream = agentLoop(context.messages, this.config.agentConfig);

    // 4. Subscribe to events to persist responses
    stream.subscribe((event) => this.handleEvent(event));

    return stream;
  }

  /** Wait for all pending writes to complete. */
  async waitForWrites(): Promise<void> {
    await this.writeQueue;
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === "message_end") {
      this.appendEntry({ type: "message", message: event.message });
    } else if (event.type === "turn_end") {
      for (const toolResult of event.toolResults) {
        this.appendEntry({ type: "message", message: toolResult });
      }
    }
  }

  private appendEntry(data: { type: "message"; message: Message }): SessionEntry {
    const entry: SessionEntry = {
      ...data,
      id: generateEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;

    // Chain writes to avoid concurrent file access
    this.writeQueue = this.writeQueue.then(() => this.writer.write(entry)).catch(() => {});

    return entry;
  }

  get sessionPath(): string | null {
    return this.writer.path;
  }

  get entryCount(): number {
    return this.entries.length;
  }
}
