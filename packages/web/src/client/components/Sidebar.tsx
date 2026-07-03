// @summary Collapsible sidebar with thread list, new thread button, and relative timestamps

import type { SessionSummary } from "@diligent/protocol";
import { SquarePen, Trash2, X } from "lucide-react";
import { memo } from "react";
import { formatRelativeTime } from "../lib/format-time";
import { Panel } from "./Panel";
import { iconButtonClasses, sidebarItemClasses, sidebarListClasses } from "./ui-styles";

interface SidebarProps {
  cwd: string;
  threadList: SessionSummary[];
  activeThreadId: string | null;
  attentionThreadIds?: Set<string>;
  onNewThread: () => void;
  onOpenThread: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onClose?: () => void;
}

function SidebarImpl({
  threadList,
  activeThreadId,
  attentionThreadIds,
  onNewThread,
  onOpenThread,
  onDeleteThread,
  onClose,
}: SidebarProps) {
  return (
    <Panel className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-border/100 bg-surface-default">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/100 bg-surface-dark px-3 sm:hidden">
        <span className="min-w-0 truncate text-sm font-medium text-text">Conversations</span>
        {onClose ? (
          <button
            type="button"
            aria-label="Close sidebar"
            data-sidebar-initial-focus
            onClick={onClose}
            className={iconButtonClasses}
          >
            <X className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {/* Thread list */}
      <div className={sidebarListClasses}>
        <button
          type="button"
          onClick={onNewThread}
          className={`${sidebarItemClasses} flex items-center gap-2 border border-border/100 bg-surface-light text-sm font-medium text-text hover:bg-surface-strong`}
        >
          <SquarePen className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          <span>New conversation</span>
        </button>

        {threadList.map((thread) => {
          const isActive = activeThreadId === thread.id;
          const needsAttention = !isActive && (attentionThreadIds?.has(thread.id) ?? false);
          const title = thread.firstUserMessage || thread.name || "New conversation";
          const time = formatRelativeTime(thread.modified);

          return (
            <div key={thread.id} className="group relative">
              <button
                type="button"
                onClick={() => onOpenThread(thread.id)}
                className={`${sidebarItemClasses} ${
                  isActive
                    ? "bg-surface-composer text-text"
                    : needsAttention
                      ? "bg-bg-sunken hover:bg-surface-light"
                      : "bg-bg-sunken hover:bg-surface-light"
                }`}
              >
                <div className="flex items-center gap-2 pr-5">
                  {needsAttention ? (
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-attention" title="Needs attention" />
                  ) : null}
                  <span className="truncate text-sm leading-snug text-text">{title}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                  <span>{time}</span>
                  <span className="opacity-40">·</span>
                  <span>{thread.messageCount} msg</span>
                </div>
              </button>
              {onDeleteThread ? (
                <button
                  type="button"
                  aria-label="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteThread(thread.id);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted opacity-0 transition hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export const Sidebar = memo(SidebarImpl);
