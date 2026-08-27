// @summary Copy and report actions shared by request and response messages

import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import { formatMessageTimestamp, formatMessageTimestampTooltip } from "../lib/time-format";
import { useMinuteNow } from "../lib/use-minute-now";
import { Check, Flag, type IconProps } from "./icons";

interface MessageActionsProps {
  targetKind: "request" | "response";
  copyText: string;
  timestamp: number;
  onReport: () => void;
  alwaysVisible?: boolean;
}

function CopyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" focusable="false" aria-hidden="true" data-icon="copy" {...props}>
      <rect width="14" height="14" x="8" y="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function MessageActions({
  targetKind,
  copyText,
  timestamp,
  onReport,
  alwaysVisible = false,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useMinuteNow();
  const timestampLabel = formatMessageTimestamp(timestamp, { now });
  const timestampTooltip = formatMessageTimestampTooltip(timestamp);
  const dateTime = new Date(timestamp).toISOString();
  const visibilityClasses = alwaysVisible
    ? "visible opacity-100"
    : "invisible opacity-0 group-hover/message:visible group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:opacity-100 [@media(hover:none)]:visible [@media(hover:none)]:opacity-100";

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (!(await copyTextToClipboard(copyText))) return;
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 1_000);
  };

  const buttonClasses =
    "inline-flex h-4 w-4 items-center justify-center rounded p-0.5 text-[#565f69] transition hover:bg-[#2a3038] hover:text-[#88929c] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";
  const alignmentClasses = targetKind === "request" ? "justify-end" : "justify-start";
  const positionClasses = targetKind === "request" ? "right-0" : "left-0";
  const tooltipAlignmentClasses = targetKind === "request" ? "right-0" : "left-0";

  return (
    <div
      className={`absolute top-full ${positionClasses} mt-1 flex h-4 w-max whitespace-nowrap items-center gap-2 transition-opacity ${alignmentClasses} ${visibilityClasses}`}
    >
      <span className="group/time relative inline-flex h-3 items-center">
        <time dateTime={dateTime} className="text-[10px] leading-3 text-[#565f69]">
          {timestampLabel}
        </time>
        <span
          role="tooltip"
          className={`pointer-events-none invisible absolute top-full z-20 mt-1.5 whitespace-nowrap rounded border border-[#353c44] bg-[#181b1f] px-2 py-1.5 text-xs leading-4 text-[#dce2e8] opacity-0 shadow-panel transition group-hover/time:visible group-hover/time:opacity-100 ${tooltipAlignmentClasses}`}
        >
          {timestampTooltip}
        </span>
      </span>
      <button type="button" title={`Copy ${targetKind}`} onClick={() => void handleCopy()} className={buttonClasses}>
        {copied ? (
          <Check className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <CopyIcon className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className="sr-only">Copy {targetKind}</span>
      </button>
      <button type="button" title={`Report ${targetKind}`} onClick={onReport} className={buttonClasses}>
        <Flag className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
        <span className="sr-only">Report {targetKind}</span>
      </button>
    </div>
  );
}
