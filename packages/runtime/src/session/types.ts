import type { Agent, SerializableError } from "@diligent/core/agent";
import type { Message } from "@diligent/core/message-contract";
import type { ProviderName, ThinkingEffort } from "@diligent/core/provider-contract";
import type { ContextPresentation } from "@diligent/protocol";
import type { Mode } from "../agent/mode";
import type { DiligentPaths } from "../infrastructure";

/** Session file format version. Increment when entry schema changes. */
export const SESSION_VERSION = 12;

/** Unique entry ID — 8-char hex */
export function generateEntryId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

let lastSessionTimeMs = 0;
let sameMillisecondSessionCounter = 0;

/** Unique session ID — timestamp + monotonic counter + random suffix for sorting */
export function generateSessionId(): string {
  const nowMs = Date.now();
  if (nowMs === lastSessionTimeMs) {
    sameMillisecondSessionCounter += 1;
  } else {
    lastSessionTimeMs = nowMs;
    sameMillisecondSessionCounter = 0;
  }

  const iso = new Date(nowMs).toISOString();
  const ts = iso.replace(/[-:TZ.]/g, "").slice(0, 17);
  const counter = sameMillisecondSessionCounter.toString().padStart(3, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${ts}${counter}-${rand}`;
}

/** Whether an externally supplied session ID is a safe single path segment. */
export function isSafeSessionId(sessionId: string): boolean {
  return sessionId.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId);
}

// --- Session Header (first line of JSONL) ---

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string; // ISO 8601
  cwd: string;
  parentSession?: string;
  /** Sub-agent metadata — present only on child sessions spawned via collab */
  nickname?: string;
  description?: string;
}

// --- Session Entries (subsequent lines) ---

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Message;
  visibility?: "internal";
  source?: string;
  presentation?: ContextPresentation;
}

export interface ModelChangeEntry {
  type: "model_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  provider: ProviderName;
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
  summary?: string;
  displaySummary?: string;
  compactionSummary?: Record<string, unknown>;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ModeChangeEntry {
  type: "mode_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  mode: Mode;
  /** Who triggered the change */
  changedBy: "cli" | "command" | "config";
}

export interface EffortChangeEntry {
  type: "effort_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  effort: ThinkingEffort;
  /** Who triggered the change */
  changedBy: "cli" | "command" | "config";
}

export interface ErrorEntry {
  type: "error";
  id: string;
  parentId: string | null;
  timestamp: string;
  turnId?: string;
  fatal: boolean;
  error: SerializableError;
}

export type SessionEntry =
  | SessionMessageEntry
  | ErrorEntry
  | ModelChangeEntry
  | SessionInfoEntry
  | CompactionEntry
  | ModeChangeEntry
  | EffortChangeEntry;

/** Any line in a session file */
export type SessionFileLine = SessionHeader | SessionEntry;

/** Sub-agent identity metadata stored in child session headers */
export interface CollabSessionMeta {
  nickname: string;
  description?: string;
}

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
  parentSession?: string;
}

// --- Session Manager Config ---

/**
 * Context passed to {@link SessionManagerConfig.onEntryAppended} after a session
 * entry is durably written. `seq` is monotonic per session (seeded from the existing
 * line count on resume) — the dedup half-key for downstream sinks like diligent-gateway.
 * `userId` is filled in at the app-server layer before fan-out to observers.
 */
export interface AppendedEntryInfo {
  sessionId: string;
  sessionPath: string | null;
  cwd: string;
  entry: SessionEntry;
  seq: number;
  userId?: string;
}

export interface SessionManagerConfig {
  cwd: string;
  paths: DiligentPaths;
  // D087: Factory allows per-run config (e.g. collaboration mode, mid-session knowledge refresh)
  agent: Agent | (() => Agent | Promise<Agent>);
  compaction?: {
    enabled: boolean;
    reservePercent: number;
    timeoutMs?: number;
  };
  knowledgePath?: string;
  sessionId?: string;
  parentSession?: string;
  /** When spawned as a sub-agent, identity info persisted in session header */
  collabMeta?: CollabSessionMeta;
  /**
   * Runs external Stop lifecycle work after a successful turn (not abort or error).
   * The callback is awaited, but its output cannot add messages or re-run the model.
   */
  onStop?: (context: Message[]) => Promise<void>;
  /**
   * Called after each session entry is durably appended to the JSONL file.
   * Fire-and-forget — must never block or throw into the write path. Used to
   * mirror records to external sinks (e.g. diligent-gateway).
   */
  onEntryAppended?: (info: AppendedEntryInfo) => void;
}

export interface ResumeSessionOptions {
  sessionId?: string;
  mostRecent?: boolean;
}
