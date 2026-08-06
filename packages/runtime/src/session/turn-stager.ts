// @summary Turn staging helper for session runs with compaction-aware pending entries

import type { CoreAgentEvent } from "@diligent/core/agent";
import type { Message } from "@diligent/core/message-contract";
import { readContextPresentation } from "../agent/context-presentation";
import type { CompactionEntry, SessionEntry } from "./types";
import { generateEntryId } from "./types";

export interface TurnStagerSnapshot {
  entries: SessionEntry[];
  leafId: string | null;
}

export interface TurnStagerEventResult {
  messageId?: string;
}

export class TurnStager {
  private pendingEntries: SessionEntry[] = [];
  private currentLeafId: string | null;
  private readonly assistantEntryIds = new Map<string, string>();

  constructor(baseLeafId: string | null, userMessage: Message, userMessageId = generateEntryId()) {
    this.currentLeafId = baseLeafId;
    this.stageMessage(userMessage, undefined, userMessageId);
  }

  handleEvent(event: CoreAgentEvent): TurnStagerEventResult {
    if (event.type === "message_start" || event.type === "message_delta" || event.type === "message_discarded") {
      return { messageId: this.getAssistantEntryId(event.itemId) };
    }

    if (event.type === "message_end") {
      const messageId = this.getAssistantEntryId(event.itemId);
      this.stageMessage(event.message, undefined, messageId);
      return { messageId };
    }

    if (event.type === "tool_end") {
      this.stageMessage({
        role: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        outputImages: event.outputImages,
        isError: event.isError,
        timestamp: Date.now(),
        render: event.render,
        metadata: event.metadata,
      });
      return {};
    }

    if (event.type === "steering_injected") {
      for (const [index, msg] of event.messages.entries()) {
        this.stageMessage(msg, undefined, event.steerIds[index] ?? generateEntryId());
      }
      return {};
    }

    if (event.type === "context_injected") {
      for (const injection of event.injections) {
        this.stageMessage(injection.message, {
          visibility: "internal",
          source: injection.source,
          presentation: readContextPresentation(injection.metadata),
        });
      }
      return {};
    }

    if (event.type === "compaction_end") {
      this.stageCompactionBeforePending({
        summary: event.summary,
        displaySummary: event.compactionSummary ? "Compacted" : event.summary,
        compactionSummary: event.compactionSummary,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      });
    }
    return {};
  }

  getSnapshot(): TurnStagerSnapshot {
    return {
      entries: [...this.pendingEntries],
      leafId: this.currentLeafId,
    };
  }

  flushPendingEntries(): SessionEntry[] {
    if (this.pendingEntries.length === 0) return [];
    const entries = [...this.pendingEntries];
    this.pendingEntries = [];
    return entries;
  }

  private stageMessage(
    message: Message,
    metadata?: {
      visibility: "internal";
      source: string;
      presentation?: import("@diligent/protocol").ContextPresentation;
    },
    entryId = generateEntryId(),
  ): void {
    this.stageEntry({
      type: "message",
      id: entryId,
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      message,
      ...metadata,
    });
  }

  private getAssistantEntryId(itemId: string): string {
    const existing = this.assistantEntryIds.get(itemId);
    if (existing) return existing;
    const entryId = generateEntryId();
    this.assistantEntryIds.set(itemId, entryId);
    return entryId;
  }

  private stageCompaction(event: {
    summary: string;
    displaySummary?: string;
    compactionSummary?: Record<string, unknown>;
    tokensBefore: number;
    tokensAfter: number;
  }): void {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(),
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      summary: event.summary,
      displaySummary: event.displaySummary,
      compactionSummary: event.compactionSummary,
      tokensBefore: event.tokensBefore,
      tokensAfter: event.tokensAfter,
    };
    this.stageEntry(entry);
  }

  private stageCompactionBeforePending(event: {
    summary: string;
    displaySummary?: string;
    compactionSummary?: Record<string, unknown>;
    tokensBefore: number;
    tokensAfter: number;
  }): void {
    if (this.pendingEntries.length === 0) {
      this.stageCompaction(event);
      return;
    }

    const pending = this.pendingEntries;
    const baseLeafId = pending[0]?.parentId ?? null;
    this.pendingEntries = [];
    this.currentLeafId = baseLeafId;
    this.stageCompaction(event);
    for (const entry of pending) {
      entry.parentId = this.currentLeafId;
      this.stageEntry(entry);
    }
  }

  private stageEntry(entry: SessionEntry): void {
    this.pendingEntries.push(entry);
    this.currentLeafId = entry.id;
  }
}
