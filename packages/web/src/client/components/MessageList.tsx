// @summary Scrollable message feed with auto-scroll, scroll-to-bottom button, and inline prompts

import type {
  ApprovalRequest,
  ContentBlock,
  ThreadReadResponse,
  ThreadStatus,
  UserInputRequest,
} from "@diligent/protocol";
import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent as ReactWheelEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Components,
  type ContextProp,
  type ItemProps,
  type SizeFunction,
  Virtuoso,
  type VirtuosoHandle,
} from "react-virtuoso";
import { CHAT_NEAR_BOTTOM_THRESHOLD_PX } from "../lib/scroll-utils";
import type { RenderItem } from "../lib/thread-store";
import { normalizeToolName } from "../lib/thread-utils";
import { ApprovalCard } from "./ApprovalCard";
import { isRenderableAssistantContentBlock, isToolLikeAssistantContentBlock } from "./AssistantContentBlocks";
import { AssistantMessage } from "./AssistantMessage";
import { CollabGroup } from "./CollabGroup";
import { CompactingIndicator } from "./CompactingIndicator";
import { ContextMessage } from "./ContextMessage";
import { EmptyState } from "./EmptyState";
import { QuestionCard } from "./QuestionCard";
import { ScrollToBottom } from "./ScrollToBottom";
import { StreamingIndicator } from "./StreamingIndicator";
import { ToolBlock } from "./ToolBlock";
import { UserMessage } from "./UserMessage";

function ErrorMessage({
  item,
  onOpenProviders,
}: {
  item: Extract<RenderItem, { kind: "error" }>;
  onOpenProviders?: () => void;
}) {
  const isAuthError = item.providerErrorType === "auth";
  return (
    <div className="py-1">
      <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-text-soft">
        <div className="font-medium">{item.name ? `${item.name}: ${item.message}` : item.message}</div>
        {item.turnId ? <div className="mt-1 text-xs text-danger/80">Turn: {item.turnId}</div> : null}
        {isAuthError && onOpenProviders ? (
          <button
            type="button"
            onClick={onOpenProviders}
            className="mt-2 rounded-md border border-danger/40 bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger transition hover:bg-danger/25"
          >
            Reconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface MessageListProps {
  items: RenderItem[];
  threadStatus: ThreadStatus;
  threadCwd?: string;
  hasProvider: boolean;
  oauthPending?: boolean;
  onOpenProviders: () => void;
  onQuickConnectChatGPT?: () => void;
  isCompacting?: boolean;
  approvalPrompt?: {
    request: ApprovalRequest;
    onDecide: (decision: "once" | "always" | "reject") => void;
  } | null;
  questionPrompt?: {
    request: UserInputRequest;
    answers: Record<string, string | string[]>;
    onAnswerChange: (id: string, value: string | string[]) => void;
    onSubmit: () => void;
    onCancel: () => void;
  } | null;
  onLoadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}

type CollabItem = Extract<RenderItem, { kind: "collab" }>;

const MESSAGE_ROW_GAP_PX = 12;
const MESSAGE_LIST_VERTICAL_PADDING_PX = 24;
const DEFAULT_ESTIMATED_ROW_HEIGHT_PX = 132;
const COLLAPSED_TOOL_BLOCK_ESTIMATE_PX = 44;
const VIRTUOSO_VIEWPORT_INCREASE_PX = { bottom: 600, top: 1_500 };
const VIRTUOSO_MIN_OVERSCAN_ITEMS = { bottom: 4, top: 6 };
const VIRTUOSO_OVERSCAN_PX = { main: 600, reverse: 1_100 };
const ROW_SIZE_CACHE_LIMIT = 2_000;
const measuredRowSizes = new Map<string, number>();

interface MessageListRow {
  key: string;
  estimatedSize: number;
}

type MessageContentItem = Exclude<RenderItem, { kind: "collab" }>;
type ApprovalPrompt = NonNullable<MessageListProps["approvalPrompt"]>;
type QuestionPrompt = NonNullable<MessageListProps["questionPrompt"]>;
type VirtuosoScrollBehavior = "auto" | "smooth";

interface VirtuosoMessageListContext {
  rowCount: number;
  transcriptKey: string;
}

type VirtualMessageRow =
  | (MessageListRow & { kind: "collab"; items: CollabItem[] })
  | (MessageListRow & { kind: "message"; item: MessageContentItem; suppressThinking?: boolean })
  | (MessageListRow & { kind: "streaming" })
  | (MessageListRow & { kind: "compacting" })
  | (MessageListRow & { kind: "approval"; prompt: ApprovalPrompt })
  | (MessageListRow & { kind: "question"; prompt: QuestionPrompt })
  | (MessageListRow & { kind: "bottom" });

function getRowSizeCacheKey(transcriptKey: string, row: VirtualMessageRow): string {
  return `${transcriptKey}:${row.key}:${row.estimatedSize}`;
}

function rememberMeasuredRowSize(cacheKey: string, size: number): void {
  if (!Number.isFinite(size) || size <= 0) return;
  measuredRowSizes.delete(cacheKey);
  measuredRowSizes.set(cacheKey, size);
  if (measuredRowSizes.size <= ROW_SIZE_CACHE_LIMIT) return;

  const oldestKey = measuredRowSizes.keys().next().value;
  if (oldestKey !== undefined) {
    measuredRowSizes.delete(oldestKey);
  }
}

function estimateRowOuterHeight(row: VirtualMessageRow, index: number, rowCount: number): number {
  return (
    row.estimatedSize +
    (index === 0 ? MESSAGE_LIST_VERTICAL_PADDING_PX : 0) +
    (index < rowCount - 1 ? MESSAGE_ROW_GAP_PX : MESSAGE_LIST_VERTICAL_PADDING_PX)
  );
}

function estimateTextHeight(text: string, baseHeight: number): number {
  if (!text) return baseHeight;
  const visualLines = text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 90)), 0);
  return baseHeight + Math.min(visualLines, 28) * 24;
}

function estimateContentBlockHeight(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTextHeight(block.text, 4) + (block.citations?.length ?? 0) * 20;
    case "provider_tool_use":
    case "web_search_result":
    case "web_fetch_result":
      return COLLAPSED_TOOL_BLOCK_ESTIMATE_PX;
    default:
      return 0;
  }
}

function estimateContentBlocksHeight(blocks: ContentBlock[]): number {
  const renderableBlocks = blocks.filter(isRenderableAssistantContentBlock);
  if (renderableBlocks.length === 0) return 0;
  const blockHeights = renderableBlocks.reduce((total, block) => total + estimateContentBlockHeight(block), 0);
  return blockHeights + Math.max(0, renderableBlocks.length - 1) * MESSAGE_ROW_GAP_PX;
}

function estimateAssistantThinkingHeight(item: Extract<RenderItem, { kind: "assistant" }>): number {
  if (!item.thinking) return 0;
  return item.thinkingDone ? 32 : estimateTextHeight(item.thinking, 4);
}

function estimateCollabGroupHeight(items: CollabItem[]): number {
  const childToolCount = items.reduce((count, item) => count + item.childTools.length, 0);
  return 112 + items.length * 54 + childToolCount * 24;
}

function estimateMessageHeight(item: RenderItem): number {
  switch (item.kind) {
    case "assistant": {
      const contentBlocksHeight = estimateContentBlocksHeight(item.contentBlocks);
      const textHeight = contentBlocksHeight > 0 ? 0 : estimateTextHeight(item.text, 4);
      const thinkingHeight = estimateAssistantThinkingHeight(item);
      const hasToolLikeBlocks = item.contentBlocks
        .filter(isRenderableAssistantContentBlock)
        .some(isToolLikeAssistantContentBlock);
      const dividerHeight = item.thinkingDone && !hasToolLikeBlocks ? 28 : 0;
      return Math.max(28, textHeight + thinkingHeight + contentBlocksHeight + dividerHeight + 8);
    }
    case "user":
      return estimateTextHeight(item.text, 60) + item.images.length * 112 + (item.contextItems?.length ?? 0) * 28;
    case "context":
      return 112;
    case "error":
      return 80;
    case "tool":
      return item.status === "streaming" ? 52 : 68;
    case "collab":
      return DEFAULT_ESTIMATED_ROW_HEIGHT_PX;
  }
}

function createMessageRow(
  item: MessageContentItem,
  suppressThinking?: boolean,
  estimatedItem: MessageContentItem = item,
): VirtualMessageRow {
  return {
    kind: "message",
    key: item.id,
    estimatedSize: estimateMessageHeight(estimatedItem),
    item,
    suppressThinking,
  };
}

function shouldRenderAssistantRow(item: Extract<RenderItem, { kind: "assistant" }>, suppressThinking = false): boolean {
  return (
    (!suppressThinking && item.thinking.length > 0) ||
    item.text.length > 0 ||
    item.contentBlocks.some(isRenderableAssistantContentBlock)
  );
}

/** Group consecutive collab items, render everything else as virtualizer rows. */
function buildGroupedRows(items: RenderItem[]): VirtualMessageRow[] {
  const result: VirtualMessageRow[] = [];
  let collabBuf: CollabItem[] = [];

  const flushCollab = () => {
    if (collabBuf.length === 0) return;
    const groupKey = collabBuf.map((c) => c.id).join("+");
    result.push({
      kind: "collab",
      key: `collab:${groupKey}`,
      estimatedSize: estimateCollabGroupHeight(collabBuf),
      items: [...collabBuf],
    });
    collabBuf = [];
  };

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    switch (item.kind) {
      case "collab":
        collabBuf.push(item);
        break;
      case "context":
      case "error":
      case "tool":
      case "user":
        flushCollab();
        result.push(createMessageRow(item));
        break;
      case "assistant": {
        flushCollab();
        const nextItem = items[idx + 1];
        const isFollowedByUserInputTool =
          nextItem?.kind === "tool" && normalizeToolName(nextItem.toolName) === "request_user_input";
        const displayItem = isFollowedByUserInputTool ? { ...item, text: "" } : item;
        if (shouldRenderAssistantRow(displayItem)) {
          result.push(createMessageRow(displayItem, false));
        }
        break;
      }
    }
  }
  flushCollab();
  return result;
}

function applyCompactingVisibility(groupedRows: VirtualMessageRow[], isCompacting?: boolean): VirtualMessageRow[] {
  if (!isCompacting) return groupedRows;

  return groupedRows.flatMap((row) => {
    if (row.kind !== "message" || row.item.kind !== "assistant") return [row];
    if (!shouldRenderAssistantRow(row.item, true)) return [];
    return [createMessageRow(row.item, true, { ...row.item, thinking: "" })];
  });
}

function buildTrailingRows({
  threadStatus,
  isCompacting,
  approvalPrompt,
  questionPrompt,
}: Pick<MessageListProps, "threadStatus" | "isCompacting" | "approvalPrompt" | "questionPrompt">): VirtualMessageRow[] {
  const rows: VirtualMessageRow[] = [];

  if (threadStatus === "busy" && !isCompacting && !approvalPrompt && !questionPrompt) {
    rows.push({
      kind: "streaming",
      key: "status:streaming",
      estimatedSize: 44,
    });
  }

  if (isCompacting) {
    rows.push({
      kind: "compacting",
      key: "status:compacting",
      estimatedSize: 44,
    });
  }

  if (approvalPrompt) {
    rows.push({
      kind: "approval",
      key: `prompt:approval:${approvalPrompt.request.toolName}:${approvalPrompt.request.permission}`,
      estimatedSize: 220,
      prompt: approvalPrompt,
    });
  }

  if (questionPrompt) {
    rows.push({
      kind: "question",
      key: `prompt:question:${questionPrompt.request.questions.map((question) => question.id).join("+")}`,
      estimatedSize: 320,
      prompt: questionPrompt,
    });
  }

  rows.push({
    kind: "bottom",
    key: "sentinel:bottom",
    estimatedSize: 1,
  });

  return rows;
}

function MessageListRowContent({
  row,
  threadCwd,
  onLoadChildThread,
  onOpenProviders,
}: {
  row: VirtualMessageRow;
  threadCwd?: string;
  onLoadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
  onOpenProviders?: () => void;
}) {
  switch (row.kind) {
    case "collab":
      return <CollabGroup items={row.items} loadChildThread={onLoadChildThread} />;
    case "message":
      switch (row.item.kind) {
        case "context":
          return <ContextMessage summary={row.item.summary} />;
        case "error":
          return <ErrorMessage item={row.item} onOpenProviders={onOpenProviders} />;
        case "tool":
          return <ToolBlock item={row.item} threadCwd={threadCwd} />;
        case "user":
          return <UserMessage text={row.item.text} images={row.item.images} contextItems={row.item.contextItems} />;
        case "assistant":
          return <AssistantMessage item={row.item} suppressThinking={row.suppressThinking ?? false} />;
      }
      break;
    case "streaming":
      return (
        <div className="py-1">
          <div className="flex items-center pt-1">
            <StreamingIndicator />
          </div>
        </div>
      );
    case "compacting":
      return (
        <div className="py-1">
          <div className="flex items-center pt-1">
            <CompactingIndicator />
          </div>
        </div>
      );
    case "approval":
      return (
        <div className="py-1">
          <ApprovalCard request={row.prompt.request} onDecide={row.prompt.onDecide} />
        </div>
      );
    case "question":
      return (
        <div className="py-1">
          <QuestionCard
            request={row.prompt.request}
            answers={row.prompt.answers}
            onAnswerChange={row.prompt.onAnswerChange}
            onSubmit={row.prompt.onSubmit}
            onCancel={row.prompt.onCancel}
          />
        </div>
      );
    case "bottom":
      return <div className="h-px" />;
  }
}

function VirtuosoMessageItem({
  children,
  context,
  item,
  style,
  ...props
}: ItemProps<VirtualMessageRow> & ContextProp<VirtuosoMessageListContext>) {
  const index = props["data-index"];
  return (
    <div
      {...props}
      data-message-list-row={item.key}
      data-message-list-size-key={getRowSizeCacheKey(context.transcriptKey, item)}
      className="flow-root px-7 [overflow-anchor:none]"
      style={{
        ...style,
        paddingBottom: index < context.rowCount - 1 ? MESSAGE_ROW_GAP_PX : MESSAGE_LIST_VERTICAL_PADDING_PX,
        paddingTop: index === 0 ? MESSAGE_LIST_VERTICAL_PADDING_PX : 0,
      }}
    >
      {children}
    </div>
  );
}

const VIRTUOSO_COMPONENTS = {
  Item: VirtuosoMessageItem,
} satisfies Components<VirtualMessageRow, VirtuosoMessageListContext>;

function MessageListImpl({
  items,
  threadStatus,
  threadCwd,
  hasProvider,
  oauthPending,
  onOpenProviders,
  onQuickConnectChatGPT,
  isCompacting,
  approvalPrompt,
  questionPrompt,
  onLoadChildThread,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pendingAutoscrollFrameRef = useRef<number | null>(null);
  const previousTranscriptKeyRef = useRef<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isAtBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const showScrollBtnRef = useRef(false);

  const hasPrompt = approvalPrompt || questionPrompt;
  const showEmptyState = items.length === 0 && !hasPrompt;
  const groupedRows = useMemo(() => buildGroupedRows(items), [items]);
  const messageRows = useMemo(() => applyCompactingVisibility(groupedRows, isCompacting), [groupedRows, isCompacting]);
  const statusRows = useMemo(
    () => buildTrailingRows({ threadStatus, isCompacting, approvalPrompt, questionPrompt }),
    [threadStatus, isCompacting, approvalPrompt, questionPrompt],
  );
  const rows = useMemo(
    () => (showEmptyState ? [] : [...messageRows, ...statusRows]),
    [messageRows, showEmptyState, statusRows],
  );
  const transcriptKey = items[0]?.id ?? rows[0]?.key ?? "empty";
  const heightEstimates = useMemo(
    () =>
      rows.map(
        (row, index) =>
          measuredRowSizes.get(getRowSizeCacheKey(transcriptKey, row)) ??
          estimateRowOuterHeight(row, index, rows.length),
      ),
    [rows, transcriptKey],
  );
  const virtuosoContext = useMemo(() => ({ rowCount: rows.length, transcriptKey }), [rows.length, transcriptKey]);
  const initialTopMostItemIndex = useMemo(
    () => (rows.length > 0 ? { align: "end" as const, index: rows.length - 1 } : 0),
    [rows.length],
  );
  const shouldUseVirtuoso = typeof window !== "undefined";

  const setScrollButtonVisible = useCallback((visible: boolean) => {
    if (showScrollBtnRef.current === visible) return;
    showScrollBtnRef.current = visible;
    setShowScrollBtn(visible);
  }, []);

  const cancelPendingAutoscroll = useCallback(() => {
    if (pendingAutoscrollFrameRef.current === null || typeof window === "undefined") return;
    window.cancelAnimationFrame(pendingAutoscrollFrameRef.current);
    pendingAutoscrollFrameRef.current = null;
  }, []);

  const detachFromBottom = useCallback(() => {
    cancelPendingAutoscroll();
    isAtBottomRef.current = false;
    userDetachedFromBottomRef.current = true;
    setScrollButtonVisible(true);
  }, [cancelPendingAutoscroll, setScrollButtonVisible]);

  const attachToBottom = useCallback(() => {
    userDetachedFromBottomRef.current = false;
    isAtBottomRef.current = true;
    setScrollButtonVisible(false);
  }, [setScrollButtonVisible]);

  const isFollowingBottom = useCallback(() => isAtBottomRef.current && !userDetachedFromBottomRef.current, []);

  const scrollToBottom = useCallback(
    (behavior: VirtuosoScrollBehavior = "auto") => {
      if (rows.length === 0) return;
      attachToBottom();
      cancelPendingAutoscroll();
      virtuosoRef.current?.scrollToIndex({ align: "end", behavior, index: "LAST" });
      if (behavior !== "auto" || typeof window === "undefined") {
        return;
      }
      pendingAutoscrollFrameRef.current = window.requestAnimationFrame(() => {
        pendingAutoscrollFrameRef.current = null;
        virtuosoRef.current?.autoscrollToBottom();
      });
    },
    [attachToBottom, cancelPendingAutoscroll, rows.length],
  );

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      if (atBottom) {
        attachToBottom();
        return;
      }
      isAtBottomRef.current = false;
      setScrollButtonVisible(true);
    },
    [attachToBottom, setScrollButtonVisible],
  );

  const followOutput = useCallback((isAtBottom: boolean) => {
    if (!isAtBottom || userDetachedFromBottomRef.current) return false;
    return "auto";
  }, []);

  const computeItemKey = useCallback((_index: number, row: VirtualMessageRow) => row.key, []);

  const renderRow = useCallback(
    (_index: number, row: VirtualMessageRow) => (
      <MessageListRowContent
        row={row}
        threadCwd={threadCwd}
        onLoadChildThread={onLoadChildThread}
        onOpenProviders={onOpenProviders}
      />
    ),
    [onLoadChildThread, onOpenProviders, threadCwd],
  );

  const measureItemSize = useCallback<SizeFunction>((element, field) => {
    const rect = element.getBoundingClientRect();
    const size = Math.round(field === "offsetHeight" ? rect.height : rect.width);
    if (field === "offsetHeight" && element.dataset.messageListSizeKey) {
      rememberMeasuredRowSize(element.dataset.messageListSizeKey, size);
    }
    return size;
  }, []);

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) {
        detachFromBottom();
      }
    },
    [detachFromBottom],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "ArrowUp":
        case "PageUp":
        case "Home":
          detachFromBottom();
          break;
      }
    },
    [detachFromBottom],
  );

  useEffect(() => {
    const isNewTranscript = previousTranscriptKeyRef.current !== transcriptKey;
    previousTranscriptKeyRef.current = transcriptKey;
    if (!isNewTranscript) {
      return;
    }

    attachToBottom();
    if (shouldUseVirtuoso && rows.length > 0) {
      scrollToBottom("auto");
    }
  }, [attachToBottom, rows.length, scrollToBottom, shouldUseVirtuoso, transcriptKey]);

  useEffect(() => {
    if (!shouldUseVirtuoso || rows.length === 0 || !isFollowingBottom()) {
      return;
    }

    cancelPendingAutoscroll();
    pendingAutoscrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoscrollFrameRef.current = null;
      if (isFollowingBottom()) {
        virtuosoRef.current?.autoscrollToBottom();
      }
    });
  }, [cancelPendingAutoscroll, isFollowingBottom, rows, shouldUseVirtuoso]);

  useEffect(() => {
    return () => {
      cancelPendingAutoscroll();
    };
  }, [cancelPendingAutoscroll]);

  return (
    <div className="relative min-h-0 flex-1 bg-bg-sunken">
      {showEmptyState ? (
        <div className="h-full overflow-y-auto bg-bg-sunken px-7 py-6">
          <EmptyState
            hasProvider={hasProvider}
            oauthPending={oauthPending}
            onOpenProviders={onOpenProviders}
            onQuickConnectChatGPT={onQuickConnectChatGPT}
          />
        </div>
      ) : shouldUseVirtuoso ? (
        <Virtuoso
          key={transcriptKey}
          ref={virtuosoRef}
          components={VIRTUOSO_COMPONENTS}
          context={virtuosoContext}
          data={rows}
          style={{ height: "100%" }}
          className="bg-bg-sunken [overflow-anchor:none]"
          atBottomStateChange={handleAtBottomStateChange}
          atBottomThreshold={CHAT_NEAR_BOTTOM_THRESHOLD_PX}
          alignToBottom={true}
          computeItemKey={computeItemKey}
          defaultItemHeight={DEFAULT_ESTIMATED_ROW_HEIGHT_PX}
          followOutput={followOutput}
          heightEstimates={heightEstimates}
          increaseViewportBy={VIRTUOSO_VIEWPORT_INCREASE_PX}
          initialTopMostItemIndex={initialTopMostItemIndex}
          itemSize={measureItemSize}
          minOverscanItemCount={VIRTUOSO_MIN_OVERSCAN_ITEMS}
          overscan={VIRTUOSO_OVERSCAN_PX}
          skipAnimationFrameInResizeObserver={true}
          onKeyDownCapture={handleKeyDown}
          onWheelCapture={handleWheel}
          itemContent={renderRow}
        />
      ) : (
        <div className="h-full overflow-y-auto bg-bg-sunken px-7 py-6">
          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.key} data-message-list-row={row.key}>
                <MessageListRowContent
                  row={row}
                  threadCwd={threadCwd}
                  onLoadChildThread={onLoadChildThread}
                  onOpenProviders={onOpenProviders}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {showScrollBtn && <ScrollToBottom onClick={() => scrollToBottom("smooth")} />}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);
