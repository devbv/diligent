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

export class TurnStager {
  private pendingEntries: SessionEntry[] = [];
  private currentLeafId: string | null;

  constructor(baseLeafId: string | null, userMessage: Message) {
    this.currentLeafId = baseLeafId;
    this.stageMessage(userMessage);
  }

  handleEvent(event: CoreAgentEvent): void {
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
        this.stageMessage(injection.message, {
          visibility: "internal",
          source: injection.source,
          presentation: readContextPresentation(injection.metadata),
        });
      }
      return;
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
  ): void {
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
