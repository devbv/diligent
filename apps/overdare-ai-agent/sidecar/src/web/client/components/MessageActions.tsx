// @summary Copy and report actions shared by request and response messages

import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import { Check, Flag, type IconProps } from "./icons";

interface MessageActionsProps {
  targetKind: "request" | "response";
  copyText: string;
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

export function MessageActions({ targetKind, copyText, onReport, alwaysVisible = false }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    resetTimerRef.current = setTimeout(() => setCopied(false), 1_500);
  };

  const buttonClasses =
    "rounded-md p-1.5 text-muted transition hover:bg-surface-light hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <div className={`flex h-7 justify-end gap-0.5 transition-opacity ${visibilityClasses}`}>
      <button type="button" title={`Copy ${targetKind}`} onClick={() => void handleCopy()} className={buttonClasses}>
        {copied ? (
          <Check className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <CopyIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className="sr-only">Copy {targetKind}</span>
      </button>
      <button type="button" title={`Report ${targetKind}`} onClick={onReport} className={buttonClasses}>
        <Flag className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
        <span className="sr-only">Report {targetKind}</span>
      </button>
    </div>
  );
}
