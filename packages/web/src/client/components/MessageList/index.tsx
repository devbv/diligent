// @summary Scrollable message feed with auto-scroll, scroll-to-bottom button, and inline prompts

import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent as ReactWheelEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SizeFunction, Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { CHAT_NEAR_BOTTOM_THRESHOLD_PX } from "../../lib/scroll-utils";
import { EmptyState } from "../EmptyState";
import { ScrollToBottom } from "../ScrollToBottom";
import {
  DEFAULT_ESTIMATED_ROW_HEIGHT_PX,
  VIRTUOSO_MIN_OVERSCAN_ITEMS,
  VIRTUOSO_OVERSCAN_PX,
  VIRTUOSO_VIEWPORT_INCREASE_PX,
} from "./constants";
import { MessageListRowContent } from "./MessageListRowContent";
import { applyCompactingVisibility, buildGroupedRows, buildTrailingRows } from "./row-builder";
import { estimateRowOuterHeight } from "./row-estimates";
import { getMeasuredRowSize, getRowSizeCacheKey, rememberMeasuredRowSize } from "./row-size-cache";
import type { MessageListProps, VirtualMessageRow, VirtuosoScrollBehavior } from "./types";
import { VIRTUOSO_COMPONENTS } from "./VirtuosoMessageItem";

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
          getMeasuredRowSize(getRowSizeCacheKey(transcriptKey, row)) ?? estimateRowOuterHeight(row, index, rows.length),
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
      <MessageListRowContent row={row} threadCwd={threadCwd} onLoadChildThread={onLoadChildThread} />
    ),
    [onLoadChildThread, threadCwd],
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
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.key} data-message-list-row={row.key}>
                <MessageListRowContent row={row} threadCwd={threadCwd} onLoadChildThread={onLoadChildThread} />
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
