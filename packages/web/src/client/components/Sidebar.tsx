// @summary Collapsible sidebar with thread list, new thread button, and relative timestamps

import type { SessionSummary } from "@diligent/protocol";
import { memo } from "react";
import { formatRelativeTime } from "../lib/format-time";
import { Panel } from "./Panel";

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
  cwd,
  threadList,
  activeThreadId,
  attentionThreadIds,
  onNewThread,
  onOpenThread,
  onDeleteThread,
  onClose,
}: SidebarProps) {
  const _cwdShort = cwd ? cwd.replace(/\\/g, "/").split("/").slice(-2).join("/") : "-";

  return (
    <Panel className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-border/100 bg-surface-default">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/100 bg-surface-dark px-3 md:hidden">
        <span className="min-w-0 truncate text-sm font-medium text-text">Conversations</span>
        {onClose ? (
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-surface-light hover:text-text"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>
      {/* Header */}
      {/* <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/100 bg-surface-dark px-5">
        <div className="min-w-0">
          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-accent">
            {APP_PROJECT_MARK}
          </span>
          <p className="truncate font-mono text-xs- text-muted/90" title={cwd}>
            {cwdShort}
          </p>
        </div>
      </div> */}

      {/* Thread list */}
      <div className="flex-1 space-y-2 overflow-y-auto bg-bg-sunken px-2 py-3">
        <button
          type="button"
          onClick={onNewThread}
          className="flex w-full items-center gap-2 rounded border border-border/100 bg-surface-light px-3.5 py-3 text-left text-sm font-medium text-text transition hover:bg-[#424A54]"
        >
          <span className="text-lg leading-none">+</span>
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
                className={`w-full rounded px-3.5 py-3 text-left transition ${
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
                <div className="mt-1 flex items-center gap-1.5 text-xs- text-muted">
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
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted opacity-0 transition hover:text-danger group-hover:opacity-100"
                >
                  ×
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
