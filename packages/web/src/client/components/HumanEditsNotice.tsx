// @summary Prominent notice that the creator's Studio edits were detected and handed to the agent

import { useState } from "react";
import { ChevronDown, Pencil } from "./icons";
import { MarkdownContent } from "./MarkdownContent";
import { detailPanelClasses, focusRingClasses } from "./ui-styles";

interface HumanEditsNoticeProps {
  summary: string;
}

const COUNT_SECTIONS = [
  ["Added", "added"],
  ["Removed", "removed"],
  ["Moved", "moved"],
  ["Modified", "modified"],
  ["Script source changed", "script"],
] as const;

/** e.g. "1 added · 2 removed" parsed from the diff section headers. */
function countLabel(summary: string): string {
  const parts: string[] = [];
  for (const [section, word] of COUNT_SECTIONS) {
    const match = summary.match(new RegExp(`^${section} \\((\\d+)\\):`, "m"));
    if (match) parts.push(`${match[1]} ${word}`);
  }
  return parts.join(" · ");
}

export function HumanEditsNotice({ summary }: HumanEditsNoticeProps) {
  const [open, setOpen] = useState(false);
  const counts = countLabel(summary);

  return (
    <div className="py-2">
      <div className="rounded-md border border-border/40 bg-surface-default px-3 py-2">
        <button
          type="button"
          className={`group flex w-full items-center gap-2 rounded-md text-left ${focusRingClasses}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Pencil aria-hidden="true" className="h-4 w-4 shrink-0 text-muted/80" strokeWidth={1.8} />
          <span className="text-xs font-medium leading-5 text-text">Your edits detected</span>
          {counts ? <span className="text-xs leading-5 text-muted">{counts}</span> : null}
          <ChevronDown
            aria-hidden="true"
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 group-hover:text-text ${open ? "rotate-180" : "rotate-0"}`}
            strokeWidth="2"
          />
        </button>
        <p className="mt-1 text-xs leading-5 text-muted">
          You edited the level in Studio since the agent last finished. The changes were shared with the agent so it can
          take them into account before continuing.
        </p>
        {open ? (
          <div className="mt-2">
            <div className={detailPanelClasses}>
              <MarkdownContent text={summary} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
