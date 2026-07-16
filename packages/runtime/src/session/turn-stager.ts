// @summary Turn staging helper for session runs with compaction-aware pending entries

import type { CoreAgentEvent } from "@diligent/core/agent";
import { buildMessagesFromCompaction, selectForCompaction } from "@diligent/core/agent";
import type { Message } from "@diligent/core/types";
import type { CompactionEntry, SessionEntry } from "./types";
import { generateEntryId } from "./types";

export interface TurnStagerSnapshot {
  entries: SessionEntry[];
  leafId: string | null;
}

export class TurnStager {
  private pendingEntries: SessionEntry[] = [];
  private currentLeafId: string | null;
  private stagedConversation: Message[];

  constructor(baseLeafId: string | null, baseConversation: Message[], userMessage: Message) {
    this.currentLeafId = baseLeafId;
    this.stagedConversation = [...baseConversation];
    this.stageMessage(userMessage);
  }

  handleEvent(event: CoreAgentEvent, keepRecentTokens: number): void {
    if (event.type === "message_end") {
      this.stageMessage(event.message);
      return;
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
      return;
    }

    if (event.type === "steering_injected") {
      for (const msg of event.messages) {
        this.stageMessage(msg);
      }
      return;
    }

    if (event.type === "context_injected") {
      for (const injection of event.injections) {
        this.stageMessage(injection.message, { visibility: "internal", source: injection.source });
      }
      return;
    }

    if (event.type === "compaction_end") {
      const recentUserMessages = selectForCompaction(this.stagedConversation, keepRecentTokens).recentUserMessages;
      this.stagedConversation = event.compactionSummary
        ? []
        : buildMessagesFromCompaction(recentUserMessages, event.summary, Date.now());
      this.stageCompaction({
        summary: event.summary,
        displaySummary: event.compactionSummary ? "Compacted" : event.summary,
        recentUserMessages,
        compactionSummary: event.compactionSummary,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      });
    }
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

  private stageMessage(message: Message, metadata?: { visibility: "internal"; source: string }): void {
    if (!metadata) this.stagedConversation.push(message);
    this.stageEntry({
      type: "message",
      id: generateEntryId(),
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      message,
      ...metadata,
    });
  }

  private stageCompaction(event: {
    summary: string;
    displaySummary?: string;
    recentUserMessages?: Message[];
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
      recentUserMessages: event.recentUserMessages,
      compactionSummary: event.compactionSummary,
      tokensBefore: event.tokensBefore,
      tokensAfter: event.tokensAfter,
    };
    this.stageEntry(entry);
  }

  private stageEntry(entry: SessionEntry): void {
    this.pendingEntries.push(entry);
    this.currentLeafId = entry.id;
  }
}
