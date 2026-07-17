// @summary Renders the agent message history and real-time streaming output

import type { ToolResultMessage } from "@diligent/core/message-contract";
import type { AgentEvent, ThreadReadResponse } from "@diligent/protocol";
import { displayWidth } from "../framework/string-width";
import type { Component } from "../framework/types";
import { MarkdownView } from "./markdown-view";
import { ThreadStore, UserMessageView } from "./thread-store";
import type { ThreadItem } from "./thread-store-primitives";
import {
  renderCommittedTranscriptItems,
  renderTranscript,
  renderTranscriptLiveStack,
  renderTranscriptLiveStackBlocks,
} from "./transcript-render";

export interface ChatViewOptions {
  requestRender: () => void;
  requestRenderBatched?: () => void;
  cwd?: string;
  getCommitWidth?: () => number;
  onCommittedLines?: (lines: string[]) => void;
  loadChildThread?: (threadId: string) => Promise<ThreadReadResponse | null>;
}

/**
 * Main conversation view — now a thin adapter over a renderer-agnostic transcript store.
 */
export class ChatView implements Component {
  private store: ThreadStore;
  private historyView: Component;
  private liveStackView: Component;
  private hasCommittedHistory = false;
  private committedHistoryLines: string[] = [];
  private lastCommittedItem: ThreadItem | null = null;
  private readonly requestRender: () => void;
  private readonly getCommitWidth: () => number;
  private readonly onCommittedLines: ((lines: string[]) => void) | null;

  constructor(options: ChatViewOptions) {
    this.requestRender = options.requestRender;
    this.store = new ThreadStore(options);
    this.getCommitWidth = options.getCommitWidth ?? (() => 80);
    this.onCommittedLines = options.onCommittedLines ?? null;
    this.historyView = {
      render: () => [...this.committedHistoryLines],
      renderBlocks: () =>
        this.committedHistoryLines.length > 0
          ? [{ key: "history", lines: [...this.committedHistoryLines], persistence: "persistent" as const }]
          : [],
      invalidate: () => this.store.invalidate(),
    };
    this.liveStackView = {
      render: (width: number) => renderTranscriptLiveStack(this.store, width),
      renderBlocks: (width: number) => renderTranscriptLiveStackBlocks(this.store, width),
      invalidate: () => this.store.invalidate(),
    };
  }

  handleEvent(event: AgentEvent): void {
    this.store.handleEvent(event);
    this.flushPendingCommittedItems();
  }

  addUserMessage(text: string): void {
    this.store.addUserMessage(text);
    this.flushPendingCommittedItems();
  }

  commitSteeringMessages(texts: string[]): void {
    if (texts.length === 0) {
      this.store.setPendingSteers([]);
      return;
    }

    this.store.setPendingSteers([], { requestRender: false });
    for (const text of texts) {
      this.store.addUserMessage(text, { requestRender: false });
    }
    this.flushPendingCommittedItems();
  }

  addLines(lines: string[], options?: { separateBefore?: boolean }): void {
    this.store.addLines(lines, options);
    this.flushPendingCommittedItems();
  }

  addStructuredItem(item: ThreadItem): void {
    this.store.addStructuredItem(item);
    this.flushPendingCommittedItems();
  }

  addAssistantMessage(text: string): void {
    this.store.addAssistantMessage(text);
    this.flushPendingCommittedItems();
  }

  addToolResultMessage(message: ToolResultMessage): void {
    this.store.addToolResultMessage(message);
    this.flushPendingCommittedItems();
  }

  addThinkingMessage(text: string, elapsedMs?: number): void {
    this.store.addThinkingMessage(text, elapsedMs);
    this.flushPendingCommittedItems();
  }

  toggleToolResultsCollapsed(): void {
    this.store.toggleToolResultsCollapsed();
  }

  clearHistory(): void {
    this.store.clearHistory();
    this.hasCommittedHistory = false;
    this.committedHistoryLines = [];
    this.lastCommittedItem = null;
  }

  clearActive(): void {
    this.store.clearActive();
  }

  clearActiveWithCommit(): void {
    this.store.clearActiveWithCommit();
    this.flushPendingCommittedItems();
  }

  finishTurn(): void {
    this.store.finishTurn();
    this.flushPendingCommittedItems();
  }

  getLastUsage(): { input: number; output: number; cost: number } | null {
    return this.store.getLastUsage();
  }

  getLiveStackComponent(): Component {
    return this.liveStackView;
  }

  getHistoryComponent(): Component {
    return this.historyView;
  }

  render(width: number): string[] {
    return renderTranscript(this.store, width);
  }

  setActiveQuestion(q: (Component & { handleInput(data: string): void }) | null): void {
    this.store.setActiveQuestion(q);
  }

  hasActiveQuestion(): boolean {
    return this.store.hasActiveQuestion();
  }

  handleQuestionInput(data: string): void {
    this.store.handleQuestionInput(data);
  }

  setPendingSteers(steers: string[]): void {
    this.store.setPendingSteers(steers);
  }

  consumePendingSteers(): string[] {
    return this.store.consumePendingSteers();
  }

  invalidate(): void {
    this.store.invalidate();
  }

  private flushPendingCommittedItems(): void {
    const items = this.store.drainCommittedItems();
    if (items.length === 0) {
      return;
    }

    const width = Math.max(1, this.getCommitWidth());
    const lines = renderCommittedTranscriptItems(items, width, {
      includeLeadingSeparator: this.hasCommittedHistory,
      toolResultsExpanded: this.store.isToolResultsExpanded(),
      previousItem: this.lastCommittedItem,
    });
    if (lines.length === 0) {
      return;
    }

    this.committedHistoryLines.push(...lines);
    this.lastCommittedItem = items[items.length - 1] ?? this.lastCommittedItem;
    this.onCommittedLines?.(lines);
    this.hasCommittedHistory = true;
    this.requestRender();
  }
}

export { MarkdownView, ThreadStore, UserMessageView, displayWidth };
