// @summary Builds model context and raw transcript views from tree-structured session entries with compaction support
import { buildMessagesFromCompaction } from "@diligent/core/agent/compaction";
import { resolveModel } from "@diligent/core/llm/models";
import type { Message } from "@diligent/core/types";
import type { AssistantMessage } from "@diligent/protocol";
import type { CompactionEntry, SessionEntry } from "./types";

export interface SessionContext {
  messages: Message[];
  providerMessages: Message[];
  compactionSummary?: Record<string, unknown>;
  currentModel?: { provider: string; modelId: string };
  currentEffort?: "none" | "low" | "medium" | "high" | "max";
}

export type BuildSessionContextOptions = {
  includeCompactionSummary?: boolean;
};

export type SessionTranscriptEntry =
  | {
      type: "message";
      id: string;
      timestamp: string;
      message: Message;
    }
  | {
      type: "compaction";
      id: string;
      timestamp: string;
      summary: string;
      displaySummary?: string;
    };

function getPathEntries(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  const leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (!leaf) {
    return [];
  }

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/**
 * Build linear context from tree-structured entries.
 *
 * Algorithm:
 * 1. Build byId index
 * 2. Walk from leafId to root via parentId chain
 * 3. Reverse to chronological order
 * 4. If a CompactionEntry exists, inject summary and skip older entries
 * 5. Extract messages + track latest model setting
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { includeCompactionSummary = true } = options;
  const path = getPathEntries(entries, leafId);
  if (path.length === 0) {
    return { messages: [], providerMessages: [] };
  }
  // Find the latest CompactionEntry on the path
  let lastCompaction: CompactionEntry | undefined;
  let compactionIndex = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === "compaction") {
      lastCompaction = path[i] as CompactionEntry;
      compactionIndex = i;
      break;
    }
  }

  const messages: Message[] = [];
  const providerMessages: Message[] = [];
  let currentModel: { provider: string; modelId: string } | undefined;
  let currentEffort: "none" | "low" | "medium" | "high" | "max" | undefined;
  let lastAssistantModelId: string | undefined;

  if (lastCompaction && includeCompactionSummary) {
    if (lastCompaction.compactionSummary) {
      if (lastCompaction.displaySummary?.trim()) {
        messages.push({
          role: "user",
          content: lastCompaction.displaySummary,
          timestamp: Date.parse(lastCompaction.timestamp),
        });
      }
    } else if (lastCompaction.summary && lastCompaction.recentUserMessages) {
      const rebuilt = buildMessagesFromCompaction(
        lastCompaction.recentUserMessages,
        lastCompaction.summary,
        Date.parse(lastCompaction.timestamp),
      );
      messages.push(...rebuilt);
      providerMessages.push(...rebuilt);
    }

    // 3. Process entries AFTER compactionIndex only (new turns)
    for (let i = compactionIndex + 1; i < path.length; i++) {
      const entry = path[i];
      if (entry.type === "compaction") continue;
      switch (entry.type) {
        case "message":
          messages.push(entry.message);
          providerMessages.push(entry.message);
          if (entry.message.role === "assistant") {
            lastAssistantModelId = (entry.message as AssistantMessage).model;
          }
          break;
        case "model_change":
          currentModel = { provider: entry.provider, modelId: entry.modelId };
          break;
        case "effort_change":
          currentEffort = entry.effort;
          break;
      }
    }
  } else {
    for (const entry of path) {
      switch (entry.type) {
        case "message":
          messages.push(entry.message);
          providerMessages.push(entry.message);
          if (entry.message.role === "assistant") {
            lastAssistantModelId = (entry.message as AssistantMessage).model;
          }
          break;
        case "model_change":
          currentModel = { provider: entry.provider, modelId: entry.modelId };
          break;
        case "effort_change":
          currentEffort = entry.effort;
          break;
      }
    }
  }

  return {
    messages,
    providerMessages,
    compactionSummary: lastCompaction?.compactionSummary,
    currentModel: currentModel ?? resolveModelFromId(lastAssistantModelId),
    currentEffort,
  };
}

function resolveModelFromId(modelId: string | undefined): { provider: string; modelId: string } | undefined {
  if (!modelId) return undefined;
  try {
    const model = resolveModel(modelId);
    return { provider: model.provider, modelId: model.id };
  } catch {
    return undefined;
  }
}

/**
 * Build the human-readable transcript from raw session entries.
 * Unlike buildSessionContext(), this preserves the full visible conversation history
 * and records compaction as an explicit transcript event instead of replacing older turns.
 */
export function buildSessionTranscript(entries: SessionEntry[], leafId?: string | null): SessionTranscriptEntry[] {
  const path = getPathEntries(entries, leafId);
  const transcript: SessionTranscriptEntry[] = [];

  for (const entry of path) {
    switch (entry.type) {
      case "message":
        transcript.push({
          type: "message",
          id: entry.id,
          timestamp: entry.timestamp,
          message: entry.message,
        });
        break;
      case "compaction":
        transcript.push({
          type: "compaction",
          id: entry.id,
          timestamp: entry.timestamp,
          summary: entry.summary ?? entry.displaySummary ?? "Compacted",
          displaySummary: entry.displaySummary,
        });
        break;
    }
  }

  return transcript;
}
