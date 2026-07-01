// @summary Subtle divider-style compaction marker for visible transcript context resets

import { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { detailPanelClasses, focusRingClasses } from "./ui-styles";

interface ContextMessageProps {
  summary: string;
}

export function ContextMessage({ summary }: ContextMessageProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="py-2">
      <button
        type="button"
        className={`group flex w-full items-center gap-3 rounded-md py-1 text-muted transition-colors hover:text-text ${focusRingClasses}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="h-px min-w-6 flex-1 bg-border/25" />
        <span className="inline-flex shrink-0 items-center gap-2 text-xs font-medium leading-5">
          <svg
            aria-hidden="true"
            className="h-4 w-4 text-muted/80 transition-colors group-hover:text-text"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path d="M4 6h16" />
            <path d="M4 18h16" />
            <path d="m8 10 4 4 4-4" />
          </svg>
          <span>Context compacted</span>
          <svg
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-180" : "rotate-0"}`}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="m7 10 5 5 5-5" />
          </svg>
        </span>
        <span className="h-px min-w-6 flex-1 bg-border/25" />
      </button>

      {open ? (
        <div className="mt-2">
          <div className={detailPanelClasses}>
            <MarkdownContent text={summary} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
