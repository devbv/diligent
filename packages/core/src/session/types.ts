import type { ModeKind } from "../agent/types";
import type { Message } from "../types";

/** Session file format version. Increment when entry schema changes. */
export const SESSION_VERSION = 3;

/** Unique entry ID — 8-char hex */
export function generateEntryId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Unique session ID — timestamp + random suffix for sorting */
export function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${ts}-${rand}`;
}

// --- Session Header (first line of JSONL) ---

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string; // ISO 8601
  cwd: string;
  parentSession?: string;
}

// --- Session Entries (subsequent lines) ---

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Message;
}

export interface ModelChangeEntry {
  type: "model_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  provider: string;
  modelId: string;
}

export interface SessionInfoEntry {
  type: "session_info";
  id: string;
  parentId: string | null;
  timestamp: string;
  name?: string;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter: number;
  details?: CompactionDetails;
}

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface ModeChangeEntry {
  type: "mode_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  mode: ModeKind;
  /** Who triggered the change */
  changedBy: "cli" | "command" | "config";
}

export type SessionEntry = SessionMessageEntry | ModelChangeEntry | SessionInfoEntry | CompactionEntry | ModeChangeEntry;

/** Any line in a session file */
export type SessionFileLine = SessionHeader | SessionEntry;

// --- Session Metadata (for listing) ---

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstUserMessage?: string;
}
