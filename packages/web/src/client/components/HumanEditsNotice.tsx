// @summary Prominent notice that the creator's Studio edits were detected and handed to the agent

import { useState } from "react";
import { ChevronDown, Pencil } from "./icons";
import { MarkdownContent } from "./MarkdownContent";
import { detailPanelClasses, focusRingClasses } from "./ui-styles";

interface HumanEditsNoticeProps {
  summary: string;
}

const COUNT_SECTIONS = ["Added", "Removed", "Moved", "Modified", "Script source changed"] as const;

/** Total change count parsed from the diff section headers, e.g. "3 changes". */
function countLabel(summary: string): string {
  let total = 0;
  for (const section of COUNT_SECTIONS) {
    const match = summary.match(new RegExp(`^${section} \\((\\d+)\\):`, "m"));
    if (match) total += Number(match[1]);
  }
  if (total === 0) return "";
  return total === 1 ? "1 change" : `${total} changes`;
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
          <span className="text-xs font-medium leading-5 text-text">Continuing from your edits</span>
          {counts ? <span className="text-xs leading-5 text-muted">{counts}</span> : null}
          <ChevronDown
            aria-hidden="true"
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 group-hover:text-text ${open ? "rotate-180" : "rotate-0"}`}
            strokeWidth="2"
          />
        </button>
        <p className="mt-1 text-xs leading-5 text-muted">
          The agent noticed what you changed in Studio and will keep your edits in mind as it continues.
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
