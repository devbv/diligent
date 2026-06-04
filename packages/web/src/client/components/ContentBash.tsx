// @summary Terminal-style bash display: command header + expandable output

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";

interface ContentBashProps {
  command?: string;
  output?: string;
  isError?: boolean;
}

const OUTPUT_MAX_LINES = 15;

export function ContentBash({ command, output, isError = false }: ContentBashProps) {
  const outputLines = output?.split("\n") ?? [];
  const isLong = outputLines.length > OUTPUT_MAX_LINES;
  const [expanded, setExpanded] = useState(false);

  const visibleOutput = !expanded && isLong ? outputLines.slice(0, OUTPUT_MAX_LINES).join("\n") : output;

  return (
    <div className="overflow-hidden rounded-lg border border-border/10 bg-bg/60 font-mono text-xs">
      {command && (
        <div className="flex items-start gap-2 border-b border-border/10 bg-surface/60 px-3 py-2">
          <span className="shrink-0 text-muted">$</span>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap text-text">{command}</pre>
          <CopyButton text={command} />
        </div>
      )}
      {output !== undefined && output !== "" && (
        <div>
          <pre
            className={`overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed ${
              isError ? "text-danger/90" : "text-text/80"
            }`}
          >
            {visibleOutput}
          </pre>
          {isLong && (
            <ExpandButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              detail={`${outputLines.length} lines`}
            />
          )}
        </div>
      )}
    </div>
  );
}
