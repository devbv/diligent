// @summary Expandable preformatted text block with copy button

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";

interface ContentTextProps {
  text: string;
  label?: string;
  compact?: boolean;
  maxLines?: number;
  isError?: boolean;
}

const DEFAULT_MAX_LINES = 12;

export function ContentText({
  text,
  label,
  compact = false,
  maxLines = DEFAULT_MAX_LINES,
  isError = false,
}: ContentTextProps) {
  const lineCount = text.split("\n").length;
  const isLong = lineCount > maxLines;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-border/10 bg-bg/34">
      <div className="flex items-center justify-between border-b border-border/10 px-3 py-2">
        {label ? <span className="font-mono text-2xs uppercase tracking-wider text-muted">{label}</span> : <span />}
        <CopyButton text={text} />
      </div>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap px-3 py-3 font-mono leading-relaxed ${isError ? "text-muted" : "text-text/80"} ${compact ? "text-xs-" : "text-xs"}`}
        style={!expanded && isLong ? { maxHeight: `${maxLines * 1.5}em`, overflow: "hidden" } : undefined}
      >
        {text}
      </pre>
      {isLong && (
        <ExpandButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} detail={`${lineCount} lines`} />
      )}
    </div>
  );
}
