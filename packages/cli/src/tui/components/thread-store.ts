// @summary Renderer-agnostic transcript state container for chat, tool results, thinking blocks, and active prompts

import type { ToolResultMessage } from "@diligent/core/message-contract";
import type { AgentEvent, ThreadReadResponse, ToolRenderPayload } from "@diligent/protocol";
import { formatClientError } from "../error-presentation";
import type { Component } from "../framework/types";
import { renderToolPayload } from "../render-blocks";
import { t } from "../theme";
import { MarkdownView } from "./markdown-view";
import {
  type ReducerOverlayStatus,
  reduceThreadEvent,
  type ThreadEventReducerEffect,
  type ThreadEventReducerState,
} from "./thread-event-reducer";
import { type ThreadItem, UserMessageView } from "./thread-store-primitives";
import {
  buildChildDetailLines,
  buildThinkingItem,
  buildToolEndItem,
  buildToolHeader,
  buildToolSummaryLine,
  createToolResultItem,
  deriveToolStartState,
  deriveToolUpdateMessage,
  formatElapsedSeconds,
  formatTokensRoundedK,
  getWorkingSpinnerFrame,
  isChildScopedStreamEvent,
  parseSpawnChildThreadId,
  renderAssistantMessageBlocks,
  renderAssistantStructuredItems,
  TOOL_MAX_LINES,
  toProtocolRenderPayload,
  truncateMiddle,
} from "./thread-store-utils";

type OverlayStatus = ReducerOverlayStatus;

export interface ThreadStoreOptions {
  requestRender: () => void;
  cwd?: string;
  loadChildThread?: (threadId: string) => Promise<ThreadReadResponse | null>;
}

export class ThreadStore {
  private items: ThreadItem[] = [];
  private activeMarkdown: MarkdownView | null = null;
  private thinkingStartTime: number | null = null;
  private thinkingText = "";
  private overlayStatus: OverlayStatus | null = null;
  private statusBeforeCompaction: string | null = null;
  private threadStatus: string | null = null;
  private isThreadBusy = false;
  private busyStartedAt: number | null = null;
  private statusBlinkVisible = true;
  private statusBlinkStartedAt = Date.now();
  private statusBlinkTimer: ReturnType<typeof setInterval> | null = null;
  private statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastUsage: { input: number; output: number; cost: number } | null = null;
  private toolCalls: Record<string, { startedAt: number; input?: unknown; startRender?: ToolRenderPayload }> = {};
  private collabByToolCallId: Record<string, { toolName: string; label: string; prompt?: string }> = {};
  private collabAgentNamesByThreadId: Record<string, string> = {};
  private planCallCount = 0;
  private pendingSteers: string[] = [];
  private activeQuestion: (Component & { handleInput(data: string): void }) | null = null;
  private toolResultsExpanded = false;
  private hasCommittedAssistantChunkInMessage = false;
  private childDetailCache = new Map<
    string,
    { status: "loaded"; lines: string[] } | { status: "error"; error: string }
  >();
  private childDetailPending = new Map<string, Promise<void>>();

  constructor(private options: ThreadStoreOptions) {}

  getItems(): ThreadItem[] {
    return this.items;
  }

  drainCommittedItems(): ThreadItem[] {
    if (this.items.length === 0) {
      return [];
    }
    const drainedItems = this.items;
    this.items = [];
    return drainedItems;
  }

  getActiveMarkdown(): MarkdownView | null {
    return this.activeMarkdown;
  }

  getActiveQuestion(): (Component & { handleInput(data: string): void }) | null {
    return this.activeQuestion;
  }

  isToolResultsExpanded(): boolean {
    return this.toolResultsExpanded;
  }

  getLastUsage(): { input: number; output: number; cost: number } | null {
    return this.lastUsage;
  }

  getPendingSteers(): string[] {
    return this.pendingSteers;
  }

  renderLiveStackStatusLines(): string[] {
    const lines: string[] = [];
    const nowMs = Date.now();
    if (this.overlayStatus) {
      const overlayDot =
        this.overlayStatus.kind === "tool"
          ? this.statusBlinkVisible
            ? `${t.text}⏺${t.reset}`
            : `${t.text} ${t.reset}`
          : this.statusBlinkVisible
            ? `${t.dim}⏺${t.reset}`
            : `${t.dim} ${t.reset}`;
      const message =
        this.overlayStatus.kind === "tool"
          ? `${t.text}${this.overlayStatus.message}${t.reset}`
          : this.overlayStatus.message;
      if (this.isCompleteStatusMessage(this.overlayStatus.message)) {
        lines.push(`${overlayDot} ${message}`);
      } else {
        const overlayElapsed = formatElapsedSeconds(nowMs - this.overlayStatus.startedAt) ?? "0s";
        lines.push(`${overlayDot} ${message} ${t.dim}(${overlayElapsed})${t.reset}`);
      }
    }

    if (this.busyStartedAt !== null) {
      if (lines.length > 0) {
        lines.push("");
      }
      const spinner = `${t.accent}${getWorkingSpinnerFrame(nowMs)}${t.reset}`;
      lines.push(`${spinner} Working…`);
    }

    return lines;
  }

  shouldPadBelowLiveStatusLine(): boolean {
    return false;
  }

  handleEvent(event: AgentEvent): void {
    if (isChildScopedStreamEvent(event)) {
      return;
    }

    const reduced = reduceThreadEvent(this.snapshotState(), event, this.reducerDeps());

    if (reduced.handled) {
      this.applyReducerState(reduced.state);
      this.runReducerEffects(reduced.effects);

      if (event.type === "message_delta" && event.delta.type === "content_block_delta") {
        const structuredItems = renderAssistantStructuredItems({
          ...event.message,
          content: [event.delta.block],
        });
        if (structuredItems.length > 0) {
          this.items.push(...structuredItems);
        }
      }

      if (event.type === "message_end" && "message" in event && event.message) {
        const messageContent = Array.isArray(event.message.content) ? event.message.content : [];
        const rendered = renderAssistantMessageBlocks({
          ...event.message,
          content: messageContent.filter(
            (block) =>
              block.type !== "provider_tool_use" &&
              block.type !== "web_search_result" &&
              block.type !== "web_fetch_result",
          ),
        });
        if (rendered.extras.length > 0) {
          this.items.push({ kind: "plain", lines: rendered.extras });
        }
      }

      if (reduced.requestRender) {
        this.options.requestRender();
      }
      return;
    }
  }

  private snapshotState(): ThreadEventReducerState<ThreadItem> {
    return {
      items: this.items,
      thinkingStartTime: this.thinkingStartTime,
      thinkingText: this.thinkingText,
      overlayStatus: this.overlayStatus,
      statusBeforeCompaction: this.statusBeforeCompaction,
      threadStatus: this.threadStatus,
      isThreadBusy: this.isThreadBusy,
      busyStartedAt: this.busyStartedAt,
      lastUsage: this.lastUsage,
      planCallCount: this.planCallCount,
      hasCommittedAssistantChunkInMessage: this.hasCommittedAssistantChunkInMessage,
      toolCalls: this.toolCalls,
      collabByToolCallId: this.collabByToolCallId,
      collabAgentNamesByThreadId: this.collabAgentNamesByThreadId,
    };
  }

  private applyReducerState(state: ThreadEventReducerState<ThreadItem>): void {
    this.items = state.items;
    this.thinkingStartTime = state.thinkingStartTime;
    this.thinkingText = state.thinkingText;
    this.overlayStatus = state.overlayStatus;
    this.statusBeforeCompaction = state.statusBeforeCompaction;
    this.threadStatus = state.threadStatus;
    this.isThreadBusy = state.isThreadBusy;
    this.busyStartedAt = state.busyStartedAt;
    this.lastUsage = state.lastUsage;
    this.planCallCount = state.planCallCount;
    this.hasCommittedAssistantChunkInMessage = state.hasCommittedAssistantChunkInMessage;
    this.toolCalls = state.toolCalls;
    this.collabByToolCallId = state.collabByToolCallId;
    this.collabAgentNamesByThreadId = state.collabAgentNamesByThreadId;
  }

  private reducerDeps() {
    return {
      nowMs: Date.now(),
      getCommittedMarkdownText: () => {
        this.activeMarkdown?.finalize();
        return this.activeMarkdown?.takeCommittedText() ?? "";
      },
      deriveToolStartState,
      deriveToolUpdateMessage,
      buildCompactionItem: (compactionEvent: Extract<AgentEvent, { type: "compaction_end" }>) => {
        const summaryText = compactionEvent.summary.trim();
        const summaryPrefix = summaryText.length > 0 ? `${summaryText}, ` : "";
        return {
          kind: "plain" as const,
          lines: [
            `${t.success}⏺${t.reset} ${t.dim}Compacted: ${summaryPrefix}${formatTokensRoundedK(compactionEvent.tokensBefore)} → ${formatTokensRoundedK(compactionEvent.tokensAfter)} tokens${t.reset}`,
          ],
        };
      },
      buildKnowledgeSavedItem: () => ({
        kind: "plain" as const,
        lines: [`${t.success}⏺${t.reset} ${t.dim}knowledge saved${t.reset}`],
      }),
      buildContextNoticeItem: (event: Extract<AgentEvent, { type: "context_notice" }>) => ({
        kind: "plain" as const,
        separateBefore: true,
        lines: [
          `${t.success}✎ ${event.presentation.title}${t.reset}`,
          ...event.presentation.content.split("\n").map((line) => `${t.dim}  ${line}${t.reset}`),
        ],
      }),
      buildErrorItem: (error: Extract<AgentEvent, { type: "error" }>["error"]) => {
        const { message, hint } = formatClientError(error);
        return {
          kind: "plain" as const,
          lines: [`${t.error}✗ ${message}${t.reset}`, ...(hint ? [`${t.dim}  ${hint}${t.reset}`] : [])],
        };
      },
      buildThinkingItem,
      buildAssistantChunkItem: (text: string, continued: boolean) => ({
        kind: "assistant_chunk" as const,
        text,
        continued,
      }),
      buildToolEndItem,
    };
  }

  private runReducerEffects(effects: ThreadEventReducerEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "markdown_open":
          this.activeMarkdown = new MarkdownView(this.options.requestRender);
          break;
        case "markdown_push":
          this.activeMarkdown?.pushDelta(effect.delta);
          break;
        case "markdown_finalize":
          this.activeMarkdown?.finalize();
          this.activeMarkdown = null;
          break;
        case "markdown_reset":
          this.activeMarkdown?.reset();
          this.activeMarkdown = null;
          break;
        case "start_status_timers":
          this.ensureStatusTimers();
          break;
        case "cleanup_status_timers_if_idle":
          this.cleanupStatusTimersIfIdle();
          break;
      }
    }
  }

  addUserMessage(text: string, options?: { requestRender?: boolean }): void {
    this.items.push(new UserMessageView(text));
    if (options?.requestRender !== false) {
      this.options.requestRender();
    }
  }

  addLines(lines: string[], options?: { separateBefore?: boolean }): void {
    this.items.push({ kind: "plain", lines, separateBefore: options?.separateBefore === true });
    this.options.requestRender();
  }

  addStructuredItem(item: ThreadItem): void {
    this.items.push(item);
    this.options.requestRender();
  }

  addAssistantMessage(text: string): void {
    if (!text) return;
    this.items.push({ kind: "assistant_chunk", text, continued: false });
    this.options.requestRender();
  }

  addToolResultMessage(message: ToolResultMessage): void {
    const renderPayload: ToolRenderPayload | undefined = toProtocolRenderPayload(message.render);
    const icon = message.isError ? `${t.error}✗${t.reset}` : `${t.success}⏺${t.reset}`;
    const headerLabel = buildToolHeader(message.toolName, renderPayload);

    if (renderPayload) {
      const rendered = renderToolPayload(renderPayload);
      const lines: string[] = [`${icon} ${headerLabel}`];
      if (rendered.length > 0) {
        lines.push(...rendered.map((line) => `  ${line}`));
      }
      this.items.push(createToolResultItem(lines, buildToolSummaryLine(renderPayload)));
    } else if (message.output) {
      const rawLines = message.output.split("\n");
      const display = truncateMiddle(rawLines, TOOL_MAX_LINES);
      const lines: string[] = [`${icon} ${headerLabel}`];
      for (const line of display) {
        lines.push(`${t.dim}  ${line}${t.reset}`);
      }
      const item = createToolResultItem(lines);
      if (message.toolName === "spawn_agent") {
        const childThreadId = parseSpawnChildThreadId(message.output);
        if (childThreadId) {
          item.childDetail = {
            childThreadId,
            status: "idle",
          };
        }
      }
      this.items.push(item);
    } else {
      this.items.push({ kind: "plain", lines: [`${icon} ${headerLabel}`] });
    }

    this.options.requestRender();
  }

  addThinkingMessage(text: string, elapsedMs?: number): void {
    this.items.push(buildThinkingItem(text, elapsedMs));
    this.options.requestRender();
  }

  toggleToolResultsCollapsed(): void {
    this.toolResultsExpanded = !this.toolResultsExpanded;
    if (this.toolResultsExpanded) {
      this.loadExpandedChildDetails();
    }
    this.options.requestRender();
  }

  private loadExpandedChildDetails(): void {
    if (!this.options.loadChildThread) return;

    for (const item of this.items) {
      if (item instanceof UserMessageView || item.kind !== "tool_result") continue;
      const detail = item.childDetail;
      if (!detail) continue;

      const cached = this.childDetailCache.get(detail.childThreadId);
      if (cached?.status === "loaded") {
        item.childDetail = { ...detail, status: "loaded", lines: cached.lines, error: undefined };
        continue;
      }
      if (cached?.status === "error") {
        item.childDetail = { ...detail, status: "error", lines: undefined, error: cached.error };
        continue;
      }
      if (detail.status === "loading" || this.childDetailPending.has(detail.childThreadId)) {
        continue;
      }

      item.childDetail = { ...detail, status: "loading", lines: undefined, error: undefined };
      this.options.requestRender();

      const pending = this.options
        .loadChildThread(detail.childThreadId)
        .then((thread) => {
          if (!thread) {
            const error = "child thread not found";
            this.childDetailCache.set(detail.childThreadId, { status: "error", error });
            this.applyChildDetailError(detail.childThreadId, error);
            return;
          }
          const lines = buildChildDetailLines(thread);
          this.childDetailCache.set(detail.childThreadId, { status: "loaded", lines });
          this.applyChildDetailSuccess(detail.childThreadId, lines);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.childDetailCache.set(detail.childThreadId, { status: "error", error: message });
          this.applyChildDetailError(detail.childThreadId, message);
        })
        .finally(() => {
          this.childDetailPending.delete(detail.childThreadId);
        });

      this.childDetailPending.set(detail.childThreadId, pending);
    }
  }

  private applyChildDetailSuccess(childThreadId: string, lines: string[]): void {
    for (const item of this.items) {
      if (item instanceof UserMessageView || item.kind !== "tool_result") continue;
      if (item.childDetail?.childThreadId !== childThreadId) continue;
      item.childDetail = {
        childThreadId,
        status: "loaded",
        lines,
      };
    }
    this.options.requestRender();
  }

  private applyChildDetailError(childThreadId: string, message: string): void {
    for (const item of this.items) {
      if (item instanceof UserMessageView || item.kind !== "tool_result") continue;
      if (item.childDetail?.childThreadId !== childThreadId) continue;
      item.childDetail = {
        childThreadId,
        status: "error",
        error: message,
      };
    }
    this.options.requestRender();
  }

  clearHistory(): void {
    this.clearActive();
    this.items = [];
    this.lastUsage = null;
    this.toolCalls = {};
    this.collabByToolCallId = {};
    this.collabAgentNamesByThreadId = {};
    this.options.requestRender();
  }

  clearActive(): void {
    this.isThreadBusy = false;
    this.busyStartedAt = null;
    this.stopOverlayStatus();
    this.cleanupStatusTimersIfIdle();
    this.statusBeforeCompaction = null;
    this.thinkingStartTime = null;
    this.thinkingText = "";
    this.planCallCount = 0;
    this.toolCalls = {};
    this.collabByToolCallId = {};
    this.activeMarkdown = null;
  }

  clearActiveWithCommit(): void {
    this.isThreadBusy = false;
    this.busyStartedAt = null;
    this.stopOverlayStatus();
    this.cleanupStatusTimersIfIdle();
    this.statusBeforeCompaction = null;
    if (this.thinkingText.length > 0) {
      const elapsedMs = this.thinkingStartTime !== null ? Date.now() - this.thinkingStartTime : undefined;
      this.items.push(buildThinkingItem(this.thinkingText, elapsedMs));
      this.thinkingText = "";
      this.thinkingStartTime = null;
    }
    this.planCallCount = 0;
    this.toolCalls = {};
    this.collabByToolCallId = {};
    if (this.activeMarkdown) {
      this.activeMarkdown.finalize();
      const text = this.activeMarkdown.takeCommittedText();
      if (text) {
        this.items.push({ kind: "assistant_chunk", text, continued: this.hasCommittedAssistantChunkInMessage });
        this.hasCommittedAssistantChunkInMessage = true;
      }
      this.activeMarkdown = null;
    }
    this.hasCommittedAssistantChunkInMessage = false;
    this.options.requestRender();
  }

  finishTurn(): void {
    this.clearActiveWithCommit();
  }

  setActiveQuestion(q: (Component & { handleInput(data: string): void }) | null): void {
    this.activeQuestion = q;
    this.options.requestRender();
  }

  setPendingSteers(steers: string[], options?: { requestRender?: boolean }): void {
    this.pendingSteers = [...steers];
    if (options?.requestRender !== false) {
      this.options.requestRender();
    }
  }

  consumePendingSteers(): string[] {
    if (this.pendingSteers.length === 0) return [];
    const drained = [...this.pendingSteers];
    this.pendingSteers = [];
    this.options.requestRender();
    return drained;
  }

  hasActiveQuestion(): boolean {
    return this.activeQuestion !== null;
  }

  handleQuestionInput(data: string): void {
    this.activeQuestion?.handleInput(data);
  }

  invalidate(): void {
    for (const item of this.items) {
      if (item instanceof UserMessageView) {
        item.invalidate();
      }
    }
    this.activeMarkdown?.invalidate();
  }

  private isCompleteStatusMessage(message: string): boolean {
    const normalized = message.trim();
    return normalized === "Complete" || normalized.startsWith("Complete") || normalized.includes("Complete");
  }

  private stopOverlayStatus(): void {
    if (!this.overlayStatus) return;
    this.overlayStatus = null;
    this.cleanupStatusTimersIfIdle();
  }

  private hasVisibleStatus(): boolean {
    return this.overlayStatus !== null || this.busyStartedAt !== null;
  }

  private ensureStatusTimers(): void {
    if (!this.hasVisibleStatus()) return;
    if (this.statusBlinkTimer === null) {
      this.statusBlinkTimer = setInterval(() => {
        if (!this.hasVisibleStatus()) return;
        const phaseMs = (Date.now() - this.statusBlinkStartedAt) % 1500;
        this.statusBlinkVisible = phaseMs < 1000;
        this.options.requestRender();
      }, 100);
    }
    if (this.statusRefreshTimer === null) {
      this.statusRefreshTimer = setInterval(() => {
        if (!this.hasVisibleStatus()) return;
        this.options.requestRender();
      }, 120);
    }
  }

  private cleanupStatusTimersIfIdle(): void {
    if (this.hasVisibleStatus()) return;
    if (this.statusBlinkTimer !== null) {
      clearInterval(this.statusBlinkTimer);
      this.statusBlinkTimer = null;
    }
    if (this.statusRefreshTimer !== null) {
      clearInterval(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }
    this.statusBlinkVisible = true;
    this.statusBlinkStartedAt = Date.now();
  }
}

export { UserMessageView };
export type { ThreadItem };
