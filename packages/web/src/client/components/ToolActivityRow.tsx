// @summary Shared polished activity row for tool execution state, summaries, and expansion affordance

import { cn } from "../lib/cn";
import type { ToolIconName, ToolInfo } from "../lib/tool-info";
import {
  BookOpen,
  Bot,
  ChevronDown,
  ClipboardList,
  Clock,
  Database,
  FileText,
  Globe,
  type IconComponent,
  List,
  ListChecks,
  Pencil,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  TextCursorInput,
} from "./icons";
import { focusRingClasses } from "./ui-styles";

interface ToolActivityRowProps {
  title: string;
  detail?: string;
  outputSummary?: string;
  icon: ToolIconName;
  category: ToolInfo["category"];
  isError: boolean;
  isBusy: boolean;
  durationLabel?: string | null;
  metaLabel?: string | null;
  metaTone?: "muted" | "success" | "danger" | "info";
  expanded: boolean;
  expandable: boolean;
  showMeta?: boolean;
  compact?: boolean;
  onToggle: () => void;
}

const TOOL_ICONS: Record<ToolIconName, IconComponent> = {
  agent: Bot,
  book: BookOpen,
  checklist: ListChecks,
  clock: Clock,
  database: Database,
  edit: Pencil,
  file: FileText,
  globe: Globe,
  input: TextCursorInput,
  list: List,
  plan: ClipboardList,
  search: Search,
  send: Send,
  settings: SlidersHorizontal,
  sparkles: Sparkles,
  terminal: SquareTerminal,
};

function ToolIcon({ name, className }: { name: ToolIconName; className?: string }) {
  const Icon = TOOL_ICONS[name];
  return <Icon aria-hidden="true" className={cn("h-4 w-4", className)} strokeWidth={1.8} />;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={cn("h-4 w-4 transition-transform duration-150", expanded ? "rotate-180" : "rotate-0")}
      strokeWidth={1.8}
    />
  );
}

export function ToolActivityRow({
  title,
  detail,
  outputSummary,
  icon,
  category,
  isError,
  isBusy,
  durationLabel,
  metaLabel,
  metaTone = "muted",
  expanded,
  expandable,
  showMeta = false,
  compact = false,
  onToggle,
}: ToolActivityRowProps) {
  const statusLabel = isError ? "Failed" : isBusy ? "running" : null;
  const showDuration = !statusLabel && durationLabel;
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
          isBusy && "tool-activity-running text-info/85",
          isError && "text-muted/85",
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center text-muted/75",
            category === "context" && "text-muted/85",
            isBusy && "tool-activity-icon-running text-info",
            isError && "text-muted/70",
          )}
        >
          <ToolIcon name={icon} className={compact ? "h-3.5 w-3.5" : undefined} />
        </span>

        <span className="min-w-0 truncate text-sm font-medium leading-5">{title}</span>

        {metaLabel ? (
          <span
            className={cn(
              "shrink-0 text-xs leading-5",
              metaTone === "success" && "text-success/85",
              metaTone === "danger" && "text-danger",
              metaTone === "info" && "text-info",
              metaTone === "muted" && "text-muted/65",
            )}
          >
            {metaLabel}
          </span>
        ) : null}

        {showDuration ? (
          <span className="shrink-0 font-mono text-2xs leading-5 text-muted/55 tabular-nums">{durationLabel}</span>
        ) : null}

        {statusLabel ? (
          <span className={cn("shrink-0 text-xs font-medium leading-5", isError ? "text-muted/65" : "text-info")}>
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
