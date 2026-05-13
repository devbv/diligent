// @summary Scrollable message feed with auto-scroll, scroll-to-bottom button, and inline prompts

import type { ApprovalRequest, ThreadReadResponse, ThreadStatus, UserInputRequest } from "@diligent/protocol";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CHAT_NEAR_BOTTOM_THRESHOLD_PX, isNearBottom } from "../lib/scroll-utils";
import type { RenderItem } from "../lib/thread-store";
import { normalizeToolName } from "../lib/thread-utils";
import { ApprovalCard } from "./ApprovalCard";
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

/** Group consecutive collab items, render everything else individually. */
function renderGroupedItems(
  items: RenderItem[],
  threadCwd?: string,
  onLoadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>,
  onOpenProviders?: () => void,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let collabBuf: CollabItem[] = [];

  const flushCollab = () => {
    if (collabBuf.length === 0) return;
    const groupKey = collabBuf.map((c) => c.id).join("+");
    result.push(<CollabGroup key={groupKey} items={[...collabBuf]} loadChildThread={onLoadChildThread} />);
    collabBuf = [];
  };

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (item.kind === "collab") {
      collabBuf.push(item);
      continue;
    }
    flushCollab();
    if (item.kind === "context") {
      result.push(<ContextMessage key={item.id} summary={item.summary} />);
    } else if (item.kind === "error") {
      result.push(<ErrorMessage key={item.id} item={item} onOpenProviders={onOpenProviders} />);
    } else if (item.kind === "tool") {
      result.push(<ToolBlock key={item.id} item={item} threadCwd={threadCwd} />);
    } else if (item.kind === "user") {
      result.push(<UserMessage key={item.id} text={item.text} images={item.images} contextItems={item.contextItems} />);
    } else if (item.kind === "assistant") {
      const assistantItem = item as Extract<RenderItem, { kind: "assistant" }>;
      const nextItem = items[idx + 1];
      const isFollowedByUserInputTool =
        nextItem?.kind === "tool" && normalizeToolName(nextItem.toolName) === "request_user_input";
      const displayItem = isFollowedByUserInputTool ? { ...assistantItem, text: "" } : assistantItem;
      result.push(<AssistantMessage key={item.id} item={displayItem} suppressThinking={false} />);
    }
  }
  flushCollab();
  return result;
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isAtBottomRef = useRef(true);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = isNearBottom(
      {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
      },
      CHAT_NEAR_BOTTOM_THRESHOLD_PX,
    );
    isAtBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  };

  // Auto-scroll when content updates (including streaming deltas) if user is already near bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: items reference and threadStatus are intentional triggers
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({
        behavior: threadStatus === "busy" ? "auto" : "smooth",
      });
    }
  }, [items, threadStatus]);

  // Watch for content height changes (e.g. plan updates) and auto-scroll / re-evaluate button visibility
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    isAtBottomRef.current = isNearBottom(
      {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
      },
      CHAT_NEAR_BOTTOM_THRESHOLD_PX,
    );
    setShowScrollBtn(!isAtBottomRef.current);

    const observer = new ResizeObserver(() => {
      const nearBottom = isNearBottom(
        {
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
          clientHeight: container.clientHeight,
        },
        CHAT_NEAR_BOTTOM_THRESHOLD_PX,
      );
      if (isAtBottomRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        setShowScrollBtn(false);
      } else {
        setShowScrollBtn(!nearBottom);
      }
    });
    // Observe the scrollable container's inner content
    const inner = container.firstElementChild;
    if (inner) observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const hasPrompt = approvalPrompt || questionPrompt;
  const groupedItems = useMemo(
    () => renderGroupedItems(items, threadCwd, onLoadChildThread, onOpenProviders),
    [items, threadCwd, onLoadChildThread, onOpenProviders],
  );
  const visibleItems = useMemo(
    () =>
      isCompacting
        ? items.map((item) =>
            item.kind === "assistant" ? <AssistantMessage key={item.id} item={item} suppressThinking /> : null,
          )
        : null,
    [items, isCompacting],
  );

  return (
    <div className="relative min-h-0 flex-1 bg-bg-sunken">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto bg-bg-sunken px-7 py-6">
        {items.length === 0 && !hasPrompt ? (
          <EmptyState
            hasProvider={hasProvider}
            oauthPending={oauthPending}
            onOpenProviders={onOpenProviders}
            onQuickConnectChatGPT={onQuickConnectChatGPT}
          />
        ) : (
          <div className="space-y-3">
            {isCompacting ? groupedItems.map((node, index) => visibleItems?.[index] ?? node) : groupedItems}

            {threadStatus === "busy" && !isCompacting && !approvalPrompt && !questionPrompt ? (
              <div className="py-1">
                <div className="flex items-center pt-1">
                  <StreamingIndicator />
                </div>
              </div>
            ) : null}

            {isCompacting ? (
              <div className="py-1">
                <div className="flex items-center pt-1">
                  <CompactingIndicator />
                </div>
              </div>
            ) : null}

            {approvalPrompt ? (
              <div className="py-1">
                <ApprovalCard request={approvalPrompt.request} onDecide={approvalPrompt.onDecide} />
              </div>
            ) : null}

            {questionPrompt ? (
              <div className="py-1">
                <QuestionCard
                  request={questionPrompt.request}
                  answers={questionPrompt.answers}
                  onAnswerChange={questionPrompt.onAnswerChange}
                  onSubmit={questionPrompt.onSubmit}
                  onCancel={questionPrompt.onCancel}
                />
              </div>
            ) : null}

            <div ref={bottomRef} className="h-px" />
          </div>
        )}
      </div>

      {showScrollBtn && <ScrollToBottom onClick={scrollToBottom} />}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);
