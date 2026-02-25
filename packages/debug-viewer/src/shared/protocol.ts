import type { KnowledgeEntry, SessionEntry, SessionMeta } from "./types.js";

// REST response types
export interface SessionListResponse {
  sessions: SessionMeta[];
}

export interface SessionDataResponse {
  id: string;
  entries: SessionEntry[];
}

export interface SessionTreeResponse {
  id: string;
  tree: {
    entries: Record<string, SessionEntry>;
    children: Record<string, string[]>;
    roots: string[];
  };
}

export interface KnowledgeResponse {
  entries: KnowledgeEntry[];
}

export interface SearchResult {
  sessionId: string;
  entryId: string;
  field: string;
  snippet: string;
  matchIndex: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

// WebSocket message types
export type WsClientMessage = { type: "subscribe"; sessionId: string } | { type: "unsubscribe"; sessionId: string };

export type WsServerMessage =
  | { type: "session_updated"; sessionId: string; newEntries: SessionEntry[] }
  | { type: "session_created"; session: SessionMeta }
  | { type: "connected"; timestamp: number };
