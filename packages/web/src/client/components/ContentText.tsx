// @summary Expandable preformatted text block with copy button

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";
import {
  microLabelClasses,
  toolBlockHeaderSpreadClasses,
  toolBlockPreClasses,
  toolBlockShellClasses,
} from "./ui-styles";

interface ContentTextProps {
  text: string;
  label?: string;
  maxLines?: number;
  isError?: boolean;
}

const DEFAULT_MAX_LINES = 12;

export function ContentText({ text, label, maxLines = DEFAULT_MAX_LINES, isError = false }: ContentTextProps) {
  const lineCount = text.split("\n").length;
  const isLong = lineCount > maxLines;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={toolBlockShellClasses}>
      <div className={toolBlockHeaderSpreadClasses}>
        {label ? <span className={microLabelClasses}>{label}</span> : <span />}
        <CopyButton text={text} />
      </div>
      <pre
        className={`${toolBlockPreClasses} font-mono text-xs ${isError ? "text-muted" : "text-text/80"}`}
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
