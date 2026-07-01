// @summary Shared polished activity row for tool execution state, summaries, and expansion affordance

import { cn } from "../lib/cn";
import type { ToolIconName, ToolInfo } from "../lib/tool-info";
import { focusRingClasses } from "./ui-styles";

interface ToolActivityRowProps {
  title: string;
  detail?: string;
  outputSummary?: string;
  icon: ToolIconName;
  category: ToolInfo["category"];
  status: "streaming" | "done";
  isError: boolean;
  isBusy: boolean;
  durationLabel?: string | null;
  expanded: boolean;
  expandable: boolean;
  showMeta?: boolean;
  compact?: boolean;
  onToggle: () => void;
}

function IconSvg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

function ToolIcon({ name, className }: { name: ToolIconName; className?: string }) {
  switch (name) {
    case "agent":
      return (
        <IconSvg className={className}>
          <path d="M12 3.5v3" />
          <path d="M7.5 8h9A3.5 3.5 0 0 1 20 11.5v4A3.5 3.5 0 0 1 16.5 19h-9A3.5 3.5 0 0 1 4 15.5v-4A3.5 3.5 0 0 1 7.5 8Z" />
          <path d="M9 13h.01" />
          <path d="M15 13h.01" />
          <path d="M10 16h4" />
        </IconSvg>
      );
    case "book":
      return (
        <IconSvg className={className}>
          <path d="M5 4.5h9a3 3 0 0 1 3 3v12H8a3 3 0 0 0-3 3v-18Z" />
          <path d="M17 7.5h2v12h-2" />
        </IconSvg>
      );
    case "checklist":
      return (
        <IconSvg className={className}>
          <path d="m4 7 2 2 3-4" />
          <path d="M12 7h8" />
          <path d="m4 16 2 2 3-4" />
          <path d="M12 16h8" />
        </IconSvg>
      );
    case "clock":
      return (
        <IconSvg className={className}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 2" />
        </IconSvg>
      );
    case "edit":
      return (
        <IconSvg className={className}>
          <path d="M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17l-1 3Z" />
          <path d="m14 6 4 4" />
        </IconSvg>
      );
    case "file":
      return (
        <IconSvg className={className}>
          <path d="M7 3.5h6l4 4V20H7V3.5Z" />
          <path d="M13 3.5v4h4" />
          <path d="M9.5 13h5" />
          <path d="M9.5 16h4" />
        </IconSvg>
      );
    case "globe":
      return (
        <IconSvg className={className}>
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16" />
          <path d="M12 4a12 12 0 0 1 0 16" />
          <path d="M12 4a12 12 0 0 0 0 16" />
        </IconSvg>
      );
    case "input":
      return (
        <IconSvg className={className}>
          <path d="M4 5h16v14H4V5Z" />
          <path d="M8 9h8" />
          <path d="M8 13h5" />
        </IconSvg>
      );
    case "list":
      return (
        <IconSvg className={className}>
          <path d="M8 6h12" />
          <path d="M8 12h12" />
          <path d="M8 18h12" />
          <path d="M4 6h.01" />
          <path d="M4 12h.01" />
          <path d="M4 18h.01" />
        </IconSvg>
      );
    case "plan":
      return (
        <IconSvg className={className}>
          <path d="M6 5h12v14H6V5Z" />
          <path d="M9 9h6" />
          <path d="M9 13h6" />
          <path d="M9 17h3" />
        </IconSvg>
      );
    case "search":
      return (
        <IconSvg className={className}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4 4" />
        </IconSvg>
      );
    case "send":
      return (
        <IconSvg className={className}>
          <path d="M4 12 20 5l-7 16-2-7-7-2Z" />
          <path d="m11 14 4-4" />
        </IconSvg>
      );
    case "sparkles":
      return (
        <IconSvg className={className}>
          <path d="M12 3.5 13.6 9l5.4 1.5-5.4 1.6L12 17.5l-1.6-5.4L5 10.5 10.4 9 12 3.5Z" />
          <path d="M18 16v3" />
          <path d="M16.5 17.5h3" />
        </IconSvg>
      );
    case "terminal":
      return (
        <IconSvg className={className}>
          <path d="M4 5h16v14H4V5Z" />
          <path d="m7 9 3 3-3 3" />
          <path d="M12 15h5" />
        </IconSvg>
      );
    default:
      return (
        <IconSvg className={className}>
          <path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" />
          <path d="M12 3.5v2" />
          <path d="M12 18.5v2" />
          <path d="M3.5 12h2" />
          <path d="M18.5 12h2" />
        </IconSvg>
      );
  }
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("h-4 w-4 transition-transform duration-150", expanded ? "rotate-180" : "rotate-0")}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

export function ToolActivityRow({
  title,
  detail,
  outputSummary,
  icon,
  category,
  status,
  isError,
  isBusy,
  durationLabel,
  expanded,
  expandable,
  showMeta = false,
  compact = false,
  onToggle,
}: ToolActivityRowProps) {
  const statusLabel = isError ? "Failed" : isBusy ? "Running…" : null;
  const showDuration = !statusLabel && status === "done" && durationLabel;
  const detailText = detail?.trim();
  const outputText = outputSummary?.trim();
  const hasMeta = (expanded || showMeta) && Boolean(detailText || outputText);

  return (
    <div className={cn("w-full max-w-tool-row", compact ? "py-0.5" : "py-1")}>
      <button
        type="button"
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
        onClick={onToggle}
        className={cn(
          "group inline-flex max-w-full min-w-0 items-center rounded-md pr-1 text-left text-muted transition-colors",
          compact ? "gap-2 py-0.5" : "gap-2 py-1",
          expandable ? `hover:text-text ${focusRingClasses}` : "cursor-default",
          isBusy && "tool-activity-running px-1 pr-2 text-info/85",
          isError && "text-danger/90",
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center text-muted/75",
            category === "context" && "text-muted/85",
            isBusy && "tool-activity-icon-running text-info",
            isError && "text-danger",
          )}
        >
          <ToolIcon name={icon} className={compact ? "h-3.5 w-3.5" : undefined} />
        </span>

        <span className="min-w-0 truncate text-sm font-medium leading-5">{title}</span>

        {showDuration ? (
          <span className="shrink-0 font-mono text-2xs leading-5 text-muted/60 tabular-nums">{durationLabel}</span>
        ) : null}

        {statusLabel ? (
          <span
            className={cn(
              "shrink-0 text-2xs font-medium uppercase tracking-wide",
              isError ? "text-danger" : "text-info",
            )}
          >
            {statusLabel}
          </span>
        ) : null}

        {expandable ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted/70 transition-colors group-hover:text-text">
            <ChevronIcon expanded={expanded} />
          </span>
        ) : null}
      </button>

      {hasMeta ? (
        <div className="ml-7 mt-0.5 min-w-0 space-y-0.5 text-sm leading-6 text-text-secondary">
          {detailText ? <div className="truncate font-mono text-xs text-text-tertiary">{detailText}</div> : null}
          {outputText ? <div className="truncate text-xs text-muted/85">{outputText}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
