import { join } from "node:path";
import type { SessionEntry, SessionHeader, SessionInfo, SessionInfoEntry, SessionMessageEntry } from "./types";
import { generateSessionId, SESSION_VERSION } from "./types";

/**
 * Write a session header to a new JSONL file.
 */
export async function createSessionFile(
  sessionsDir: string,
  cwd: string,
  parentSession?: string,
): Promise<{ path: string; header: SessionHeader }> {
  const id = generateSessionId();
  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession,
  };
  const path = join(sessionsDir, `${id}.jsonl`);
  await Bun.write(path, `${JSON.stringify(header)}\n`);
  return { path, header };
}

/**
 * Append a single entry to a session file.
 * Append-only: never modifies existing lines.
 */
export async function appendEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
  const file = Bun.file(sessionPath);
  const existing = await file.text();
  await Bun.write(sessionPath, `${existing}${JSON.stringify(entry)}\n`);
}

/**
 * Read all lines from a session file.
 * Validates header version.
 */
export async function readSessionFile(path: string): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
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

  const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
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
      const { header, entries } = await readSessionFile(path);

      const messageEntries = entries.filter((e): e is SessionMessageEntry => e.type === "message");
      const firstUserEntry = messageEntries.find((e) => e.message.role === "user");
      const lastEntry = entries[entries.length - 1];
      const nameEntry = entries.findLast((e): e is SessionInfoEntry => e.type === "session_info" && !!e.name);

      let firstUserMessage: string | undefined;
      if (firstUserEntry && firstUserEntry.message.role === "user") {
        const content = firstUserEntry.message.content;
        if (typeof content === "string") {
          firstUserMessage = content.slice(0, 100);
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
      });
    } catch {
      // Skip corrupted session files
    }
  }

  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Deferred persistence manager (D042).
 * Accumulates entries in memory until the first assistant message arrives,
 * then flushes all at once. Prevents abandoned empty session files.
 */
export class DeferredWriter {
  private pendingEntries: SessionEntry[] = [];
  private flushed = false;
  private sessionPath: string | null = null;

  constructor(
    private sessionsDir: string,
    private cwd: string,
    existingPath?: string,
  ) {
    if (existingPath) {
      this.sessionPath = existingPath;
      this.flushed = true;
    }
  }

  /** Queue an entry. Triggers flush if first assistant message. */
  async write(entry: SessionEntry): Promise<void> {
    this.pendingEntries.push(entry);

    if (!this.flushed && entry.type === "message" && entry.message.role === "assistant") {
      await this.flush();
    } else if (this.flushed && this.sessionPath) {
      await appendEntry(this.sessionPath, entry);
    }
  }

  /** Force flush all pending entries to disk. */
  async flush(): Promise<string> {
    if (this.flushed && this.sessionPath) return this.sessionPath;

    const { path } = await createSessionFile(this.sessionsDir, this.cwd);
    this.sessionPath = path;

    for (const entry of this.pendingEntries) {
      await appendEntry(path, entry);
    }

    this.flushed = true;
    this.pendingEntries = [];
    return path;
  }

  get path(): string | null {
    return this.sessionPath;
  }

  get isFlushed(): boolean {
    return this.flushed;
  }
}
