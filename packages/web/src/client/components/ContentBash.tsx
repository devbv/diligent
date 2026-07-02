// @summary Terminal-style bash display: command header + expandable output

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";
import { toolBlockHeaderClasses, toolBlockPreClasses, toolBlockShellClasses } from "./ui-styles";

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
    <div className={toolBlockShellClasses}>
      {command && (
        <div className={toolBlockHeaderClasses}>
          <span className="shrink-0 text-muted">$</span>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap text-text">{command}</pre>
          <CopyButton text={command} />
        </div>
      )}
      {output !== undefined && output !== "" && (
        <div>
          <pre className={`${toolBlockPreClasses} ${isError ? "text-muted" : "text-text/80"}`}>{visibleOutput}</pre>
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
