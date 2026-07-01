// @summary Read-tool panel: file path header with line range, syntax-highlighted preview

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";
import { toolBlockHeaderClasses, toolBlockPreClasses, toolBlockShellClasses } from "./ui-styles";

interface ContentReadProps {
  filePath?: string;
  offset?: number;
  limit?: number;
  output?: string;
  isError?: boolean;
}

const PREVIEW_LINES = 15;

export function ContentRead({ filePath, offset, limit, output, isError = false }: ContentReadProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = output?.split("\n") ?? [];
  const isLong = lines.length > PREVIEW_LINES;
  const visibleOutput = !expanded && isLong ? lines.slice(0, PREVIEW_LINES).join("\n") : output;

  const rangeLabel =
    offset && limit ? `L${offset}–${offset + limit - 1}` : offset ? `from L${offset}` : limit ? `${limit} lines` : "";

  return (
    <div className={toolBlockShellClasses}>
      {/* File header */}
      <div className={toolBlockHeaderClasses}>
        <span className="shrink-0 text-text-secondary">↗</span>
        <span className="min-w-0 flex-1 truncate text-text/80">{filePath ?? "file"}</span>
        {rangeLabel ? <span className="shrink-0 text-muted/70">{rangeLabel}</span> : null}
        {output ? <CopyButton text={output} /> : null}
      </div>

      {/* Content preview */}
      {output ? (
        <div>
          <pre className={`${toolBlockPreClasses} ${isError ? "text-muted" : "text-text/70"}`}>{visibleOutput}</pre>
          {isLong ? (
            <ExpandButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              detail={`${lines.length} lines`}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
