// @summary Session file persistence with JSONL format, immediate writing, and session listing
import { appendFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { externalizeEntryImages, materializeEntryImages } from "./image-sidecar";
import type {
  AppendedEntryInfo,
  CollabSessionMeta,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionInfoEntry,
  SessionMessageEntry,
} from "./types";
import { generateSessionId, SESSION_VERSION } from "./types";

/**
 * Write a session header to a new JSONL file.
 */
export async function createSessionFile(
  sessionsDir: string,
  cwd: string,
  parentSession?: string,
  collabMeta?: CollabSessionMeta,
  sessionId?: string,
): Promise<{ path: string; header: SessionHeader }> {
  const id = sessionId ?? generateSessionId();
  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession,
    nickname: collabMeta?.nickname,
    description: collabMeta?.description,
  };
  const path = join(sessionsDir, `${id}.jsonl`);
  await Bun.write(path, `${JSON.stringify(header)}\n`);
  return { path, header };
}

/**
 * Append a single entry to a session file.
 * Append-only: never modifies existing lines.
 *
 * Tool-result images are externalized to a sidecar blob directory before the
 * entry is serialized, so the JSONL line stays small (typically <1 KB even
 * for 5 MB image attachments). Without this, image-heavy sessions inflate
 * the file by megabytes per entry and make listSessions O(image bytes).
 */
export async function appendEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
  const sessionsDir = dirname(sessionPath);
  const externalized = await externalizeEntryImages(sessionsDir, entry);
  await appendFile(sessionPath, `${JSON.stringify(externalized)}\n`, "utf8");
}

/**
 * Read all lines from a session file.
 * Validates header version.
 *
 * Pass `{ materializeImages: false }` for code paths that only need text
 * content (e.g. listSessions building first-user-message previews) so the
 * sidecar blob files don't have to be read.
 */
export async function readSessionFile(
  path: string,
  options?: { materializeImages?: boolean },
): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
  const text = await Bun.file(path).text();
  const lines = text.trim().split("\n").filter(Boolean);

  if (lines.length === 0) {
    throw new Error(`Empty session file: ${path}`);
  }

  const header = JSON.parse(lines[0]) as SessionHeader;
  if (header.type !== "session") {
    throw new Error(`Invalid session header in: ${path}`);
  }
  if (header.version > SESSION_VERSION) {
    throw new Error(
      `Session file version ${header.version} is newer than supported version ${SESSION_VERSION}. ` +
        "Please update diligent.",
    );
  }

  const rawEntries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
  if (options?.materializeImages === false) {
    return { header, entries: rawEntries };
  }
  const sessionsDir = dirname(path);
  const entries = await Promise.all(rawEntries.map((entry) => materializeEntryImages(sessionsDir, entry)));
  return { header, entries };
}

/**
 * List all sessions in a directory.
 * Returns SessionInfo sorted by modified date (most recent first).
 */
export async function listSessions(sessionsDir: string): Promise<SessionInfo[]> {
  const glob = new Bun.Glob("*.jsonl");
  const sessions: SessionInfo[] = [];

  for await (const file of glob.scan(sessionsDir)) {
    try {
      const path = join(sessionsDir, file);
      // listSessions only needs text content for previews — skip blob materialization.
      const { header, entries } = await readSessionFile(path, { materializeImages: false });

      const messageEntries = entries.filter(
        (e): e is SessionMessageEntry => e.type === "message" && e.visibility !== "internal",
      );
      const firstUserEntry = messageEntries.find((e) => e.message.role === "user");
      const lastEntry = entries[entries.length - 1];
      const nameEntry = entries.findLast((e): e is SessionInfoEntry => e.type === "session_info" && !!e.name);

      let firstUserMessage: string | undefined;
      if (firstUserEntry && firstUserEntry.message.role === "user") {
        const content = firstUserEntry.message.content;
        if (typeof content === "string") {
          firstUserMessage = content.slice(0, 100);
        } else {
          const text = content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join(" ")
            .slice(0, 100);
          const imageCount = content.filter((block) => block.type === "local_image").length;
          firstUserMessage = text || (imageCount > 0 ? `[image${imageCount > 1 ? "s" : ""}]` : undefined);
        }
      }

      sessions.push({
        id: header.id,
        path,
        cwd: header.cwd,
        name: nameEntry?.name,
        created: new Date(header.timestamp),
        modified: lastEntry ? new Date(lastEntry.timestamp) : new Date(header.timestamp),
        messageCount: messageEntries.length,
        firstUserMessage,
        parentSession: header.parentSession,
      });
    } catch {
      // Skip corrupted session files
    }
  }

  return sessions.sort((a, b) => {
    const modifiedDelta = b.modified.getTime() - a.modified.getTime();
    if (modifiedDelta !== 0) return modifiedDelta;
    return b.id.localeCompare(a.id);
  });
}

export interface SessionPersistenceConfig {
  sessionsDir: string;
  cwd: string;
  parentSession?: string;
  collabMeta?: CollabSessionMeta;
  sessionId?: string;
  /** Fire-and-forget observer invoked after each entry is durably written. */
  onEntryAppended?: (info: AppendedEntryInfo) => void;
}

export interface SessionReconcileResult {
  changed: boolean;
  reason: "no_session_path" | "memory_newer" | "already_equal" | "updated_from_disk";
  sessionPath: string | null;
  memoryEntries: number;
  diskEntries: number;
  memoryLeafId: string | null;
  diskLeafId: string | null;
  memoryTailEntryIds: string;
  diskTailEntryIds: string;
  memoryTailMessage: string;
  diskTailMessage: string;
}

export class SessionPersistence {
  private writer: SessionWriter;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Monotonic per-session line counter; seeded from existing entries on resume. */
  private seq = 0;

  constructor(private readonly config: SessionPersistenceConfig) {
    this.writer = this.createWriter(config.sessionId);
  }

  resetForCreate(): void {
    this.writeQueue = Promise.resolve();
    this.seq = 0;
    this.writer = this.createWriter(this.config.sessionId ?? this.writer.id);
  }

  async create(): Promise<void> {
    await this.writer.create();
  }

  async resume(options: { sessionId?: string; mostRecent?: boolean }): Promise<SessionEntry[] | null> {
    let sessionPath: string | undefined;

    if (options.sessionId) {
      const sessions = await listSessions(this.config.sessionsDir);
      const session = sessions.find((s) => s.id === options.sessionId);
      sessionPath = session?.path;
    } else if (options.mostRecent) {
      const sessions = await listSessions(this.config.sessionsDir);
      sessionPath = sessions.find((s) => !s.parentSession)?.path;
    }

    if (!sessionPath) return null;

    const { entries } = await readSessionFile(sessionPath);
    this.writeQueue = Promise.resolve();
    // Seed seq from existing lines so resumed sessions keep (session_id, seq) unique.
    this.seq = entries.length;
    this.writer = new SessionWriter(this.config.sessionsDir, this.config.cwd, sessionPath);
    return entries;
  }

  async list(): Promise<SessionInfo[]> {
    return listSessions(this.config.sessionsDir);
  }

  append(entry: SessionEntry, onError: (error: unknown) => void): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.writer.write(entry);
        this.notifyAppended(entry);
      })
      .catch(onError);
  }

  appendMany(entries: SessionEntry[], onError: (error: unknown, entry: SessionEntry) => void): void {
    for (const entry of entries) {
      this.writeQueue = this.writeQueue
        .then(async () => {
          await this.writer.write(entry);
          this.notifyAppended(entry);
        })
        .catch((error) => onError(error, entry));
    }
  }

  /**
   * Best-effort: notify the per-append observer after a successful write.
   *
   * `seq` is incremented synchronously to preserve append order, but the observer is
   * dispatched on a later macrotask (`setImmediate`) so its work (e.g. masking + network
   * transmission) never runs on the awaited write `.then` tick — `waitForWrites()` (and
   * therefore turn start/end) must never wait on telemetry. Never throws.
   */
  private notifyAppended(entry: SessionEntry): void {
    this.seq += 1;
    const observer = this.config.onEntryAppended;
    if (!observer) return;
    const info = {
      sessionId: this.writer.id,
      sessionPath: this.writer.path,
      cwd: this.config.cwd,
      entry,
      seq: this.seq,
    };
    setImmediate(() => {
      try {
        observer(info);
      } catch {
        // Observer is best-effort; never disrupt persistence.
      }
    });
  }

  async waitForWrites(): Promise<void> {
    await this.writeQueue;
  }

  async reconcile(args: {
    committedEntries: SessionEntry[];
    committedLeafId: string | null;
    summarizeTailEntryIds: (entries: SessionEntry[]) => string;
    summarizeLastPersistedMessage: (entries: SessionEntry[]) => string;
  }): Promise<{ result: SessionReconcileResult; entries?: SessionEntry[] }> {
    const sessionPath = this.writer.path;
    const memoryEntries = args.committedEntries.length;
    const memoryLeafId = args.committedLeafId;
    const memoryTailEntryIds = args.summarizeTailEntryIds(args.committedEntries);
    const memoryTailMessage = args.summarizeLastPersistedMessage(args.committedEntries);

    if (!sessionPath) {
      return {
        result: {
          changed: false,
          reason: "no_session_path",
          sessionPath: null,
          memoryEntries,
          diskEntries: 0,
          memoryLeafId,
          diskLeafId: null,
          memoryTailEntryIds,
          diskTailEntryIds: "-",
          memoryTailMessage,
          diskTailMessage: "-",
        },
      };
    }

    await this.writeQueue.catch(() => {});

    const { entries } = await readSessionFile(sessionPath);
    const diskLeafId = entries.length > 0 ? entries[entries.length - 1].id : null;
    const diskTailEntryIds = args.summarizeTailEntryIds(entries);
    const diskTailMessage = args.summarizeLastPersistedMessage(entries);

    if (entries.length < args.committedEntries.length) {
      return {
        result: {
          changed: false,
          reason: "memory_newer",
          sessionPath,
          memoryEntries,
          diskEntries: entries.length,
          memoryLeafId,
          diskLeafId,
          memoryTailEntryIds,
          diskTailEntryIds,
          memoryTailMessage,
          diskTailMessage,
        },
      };
    }

    if (entries.length === args.committedEntries.length && diskLeafId === args.committedLeafId) {
      return {
        result: {
          changed: false,
          reason: "already_equal",
          sessionPath,
          memoryEntries,
          diskEntries: entries.length,
          memoryLeafId,
          diskLeafId,
          memoryTailEntryIds,
          diskTailEntryIds,
          memoryTailMessage,
          diskTailMessage,
        },
      };
    }

    return {
      result: {
        changed: true,
        reason: "updated_from_disk",
        sessionPath,
        memoryEntries,
        diskEntries: entries.length,
        memoryLeafId,
        diskLeafId,
        memoryTailEntryIds,
        diskTailEntryIds,
        memoryTailMessage,
        diskTailMessage,
      },
      entries,
    };
  }

  get sessionPath(): string | null {
    return this.writer.path;
  }

  get sessionId(): string {
    return this.writer.id;
  }

  private createWriter(sessionId?: string): SessionWriter {
    return new SessionWriter(
      this.config.sessionsDir,
      this.config.cwd,
      undefined,
      this.config.parentSession,
      this.config.collabMeta,
      sessionId,
    );
  }
}

/**
 * Delete a session file by session ID.
 * Returns true if deleted, false if the file did not exist.
 */
export async function deleteSession(sessionsDir: string, sessionId: string): Promise<boolean> {
  const path = join(sessionsDir, `${sessionId}.jsonl`);
  const exists = await Bun.file(path).exists();
  if (!exists) return false;
  await unlink(path);
  return true;
}

/**
 * Immediate persistence manager.
 * Creates the session file up front and appends every entry directly.
 */
/**
 * Immediate persistence manager for session files.
 * SessionPersistence builds on top of this lower-level writer.
 */
export class SessionWriter {
  private sessionPath: string | null = null;
  private readonly preAssignedId: string;

  constructor(
    private sessionsDir: string,
    private cwd: string,
    existingPath?: string,
    private parentSession?: string,
    private collabMeta?: CollabSessionMeta,
    preAssignedId?: string,
  ) {
    if (existingPath) {
      this.sessionPath = existingPath;
      this.preAssignedId = basename(existingPath).replace(".jsonl", "");
    } else {
      this.preAssignedId = preAssignedId ?? generateSessionId();
    }
  }

  /** Ensure the session file exists on disk. */
  async create(): Promise<string> {
    if (this.sessionPath) return this.sessionPath;

    const { path } = await createSessionFile(
      this.sessionsDir,
      this.cwd,
      this.parentSession,
      this.collabMeta,
      this.preAssignedId,
    );
    this.sessionPath = path;
    return path;
  }

  /** Append an entry to disk immediately. */
  async write(entry: SessionEntry): Promise<void> {
    const path = await this.create();
    await appendEntry(path, entry);
  }

  /** Session ID — always available. */
  get id(): string {
    return this.preAssignedId;
  }

  get path(): string | null {
    return this.sessionPath;
  }
}
