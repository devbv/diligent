export type { SessionContext, SessionTranscriptEntry } from "./context-builder";
export { buildSessionContext, buildSessionTranscript } from "./context-builder";
export { externalizeEntryImages, materializeEntryImages } from "./image-sidecar";
export type { ResumeSessionOptions, SessionManagerConfig } from "./manager";
export { SessionManager } from "./manager";
export type { SessionPersistenceConfig, SessionReconcileResult } from "./persistence";
export {
  appendEntry,
  createSessionFile,
  deleteSession,
  listSessions,
  readSessionFile,
  SessionPersistence,
  SessionWriter,
} from "./persistence";
export { SessionStateStore } from "./state-store";
export { TurnStager } from "./turn-stager";
export type {
  CompactionEntry,
  ModeChangeEntry,
  ModelChangeEntry,
  SessionEntry,
  SessionFileLine,
  SessionHeader,
  SessionInfo,
  SessionInfoEntry,
  SessionMessageEntry,
} from "./types";
export { generateEntryId, generateSessionId, SESSION_VERSION } from "./types";
