import type { Message } from "../types";
import type { SessionEntry } from "./types";

export interface SessionContext {
  messages: Message[];
  currentModel?: { provider: string; modelId: string };
}

/**
 * Build linear context from tree-structured entries.
 *
 * Algorithm:
 * 1. Build byId index
 * 2. Walk from leafId to root via parentId chain
 * 3. Reverse to chronological order
 * 4. Extract messages + track latest model setting
 */
export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  if (entries.length === 0) {
    return { messages: [] };
  }

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  // Find leaf: specified leafId, or last entry
  const leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];

  if (!leaf) {
    return { messages: [] };
  }

  // Walk from leaf to root
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  // Extract messages and settings
  const messages: Message[] = [];
  let currentModel: { provider: string; modelId: string } | undefined;

  for (const entry of path) {
    switch (entry.type) {
      case "message":
        messages.push(entry.message);
        break;
      case "model_change":
        currentModel = { provider: entry.provider, modelId: entry.modelId };
        break;
    }
  }

  return { messages, currentModel };
}
