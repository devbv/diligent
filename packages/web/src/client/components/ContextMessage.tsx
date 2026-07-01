// @summary Collapsible system checkpoint block for compaction summaries in the visible transcript

import { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { SystemCard } from "./SystemCard";
import { detailPanelClasses, focusRingClasses, pillBadgeClasses } from "./ui-styles";

interface ContextMessageProps {
  summary: string;
}

export function ContextMessage({ summary }: ContextMessageProps) {
  const [open, setOpen] = useState(false);

  const previewLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"))
    ?.slice(0, 140);

  return (
    <SystemCard>
      <div className="space-y-3">
        <button
          type="button"
          className={`grid w-full grid-cols-context-checkpoint items-start gap-3 rounded-md text-left ${focusRingClasses}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-info/35 bg-info/10 text-info">
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 16 16">
              <path d="M11.5 5.1A4.5 4.5 0 1 0 12 8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
              <path d="M11.5 2.8v2.3H9.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-semibold uppercase leading-5 tracking-wider text-info">
                Context checkpoint
              </span>
              <span className={`${pillBadgeClasses} border-info/30 bg-info/10 text-text-soft/85`}>Compacted</span>
            </div>
            <div className="mt-1 text-sm leading-6 text-text/90">
              Older conversation was compressed to keep the thread efficient.
            </div>
            {previewLine ? (
              <div className="mt-1 text-xs text-muted">
                {previewLine}
                {summary.length > previewLine.length ? "…" : ""}
              </div>
            ) : null}
          </div>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted/80 transition hover:bg-fill-ghost-hover hover:text-text">
            <svg
              aria-hidden="true"
              className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 16 16"
            >
              <path
                d="m6 4 4 4-4 4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
              />
            </svg>
          </span>
        </button>

        {open ? (
          <div className={detailPanelClasses}>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Summary details</div>
            <MarkdownContent text={summary} />
          </div>
        ) : null}
      </div>
    </SystemCard>
  );
}
