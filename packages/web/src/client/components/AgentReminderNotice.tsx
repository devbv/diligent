// @summary Subtle system-notice for runtime-injected steering (e.g. plan-completion nudges)

import { useState } from "react";
import { AlignJustify, ChevronDown } from "./icons";
import { MarkdownContent } from "./MarkdownContent";
import { detailPanelClasses, focusRingClasses } from "./ui-styles";

interface AgentReminderNoticeProps {
  text: string;
}

/**
 * Renders a runtime-injected steering message (like the plan-completion nudge)
 * as a subtle, collapsible system notice rather than a user bubble — the user
 * never typed it, so it must not look like their message.
 */
export function AgentReminderNotice({ text }: AgentReminderNoticeProps) {
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
          <AlignJustify
            aria-hidden="true"
            className="h-4 w-4 text-muted/80 transition-colors group-hover:text-text"
            strokeWidth={1.8}
          />
          <span>Continuing with remaining tasks</span>
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-180" : "rotate-0"}`}
            strokeWidth="2"
          />
        </span>
        <span className="h-px min-w-6 flex-1 bg-border/25" />
      </button>

      {open ? (
        <div className="mt-2">
          <div className={detailPanelClasses}>
            <MarkdownContent text={text} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
