// @summary Edit/Write-tool panel: file path header with diff-style old→new display

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";
import {
  badgeClasses,
  diffStackClasses,
  microLabelClasses,
  subtleDividerClasses,
  toolBlockHeaderClasses,
  toolBlockPreClasses,
  toolBlockShellClasses,
} from "./ui-styles";

interface ContentEditProps {
  filePath?: string;
  /** "edit" shows old→new diff, "write" shows full content */
  mode: "edit" | "write";
  oldString?: string;
  newString?: string;
  /** For write tool: full file content */
  content?: string;
  output?: string;
  isError?: boolean;
}

const PREVIEW_LINES = 12;

function DiffBlock({ label, text, color }: { label: string; text: string; color: "danger" | "success" }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const isLong = lines.length > PREVIEW_LINES;
  const visible = !expanded && isLong ? lines.slice(0, PREVIEW_LINES).join("\n") : text;
  const prefix = color === "danger" ? "−" : "+";
  const borderClass = color === "danger" ? "border-danger/20" : "border-success/30";
  const bgClass = color === "danger" ? "bg-danger/10" : "bg-success/10";
  const textClass = color === "danger" ? "text-danger/80" : "text-success";
  const labelClass = color === "danger" ? "text-danger/70" : "text-success";

  return (
    <div className={`overflow-hidden rounded-md border ${borderClass} ${bgClass}`}>
      <div className={`flex items-center justify-between border-b px-2 py-1 ${subtleDividerClasses}`}>
        <span className={`${microLabelClasses} ${labelClass}`}>
          {prefix} {label}
        </span>
        <CopyButton text={text} />
      </div>
      <pre className={`${toolBlockPreClasses} ${textClass}`}>{visible}</pre>
      {isLong ? (
        <ExpandButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} detail={`${lines.length} lines`} />
      ) : null}
    </div>
  );
}

export function ContentEdit({
  filePath,
  mode,
  oldString,
  newString,
  content,
  output,
  isError = false,
}: ContentEditProps) {
  return (
    <div className={toolBlockShellClasses}>
      {/* File header */}
      <div className={toolBlockHeaderClasses}>
        <span className="shrink-0 text-text-secondary">✎</span>
        <span className="min-w-0 flex-1 truncate text-text/80">{filePath ?? "file"}</span>
        <span className={`shrink-0 border-border/100 bg-fill-active text-text ${badgeClasses}`}>
          {mode === "edit" ? "edit" : "write"}
        </span>
      </div>

      {/* Diff view for edit */}
      {mode === "edit" && (oldString || newString) ? (
        <div className={diffStackClasses}>
          {oldString ? <DiffBlock label="old" text={oldString} color="danger" /> : null}
          {newString ? <DiffBlock label="new" text={newString} color="success" /> : null}
        </div>
      ) : null}

      {/* Full content for write */}
      {mode === "write" && content ? (
        <div className={diffStackClasses}>
          <ContentPreview text={content} isError={isError} />
        </div>
      ) : null}

      {/* Result message */}
      {output ? (
        <div className={`border-t border-border/20 px-3 py-2 ${isError ? "text-muted" : "text-muted/80"}`}>
          {output.split("\n")[0]}
        </div>
      ) : null}
    </div>
  );
}

function ContentPreview({ text, isError }: { text: string; isError: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const isLong = lines.length > PREVIEW_LINES;
  const visible = !expanded && isLong ? lines.slice(0, PREVIEW_LINES).join("\n") : text;

  return (
    <div className="overflow-hidden rounded-md border border-border/100 bg-surface-default">
      <div className={`flex items-center justify-end border-b px-2 py-1 ${subtleDividerClasses}`}>
        <CopyButton text={text} />
      </div>
      <pre className={`${toolBlockPreClasses} ${isError ? "text-muted" : "text-text/70"}`}>{visible}</pre>
      {isLong ? (
        <ExpandButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} detail={`${lines.length} lines`} />
      ) : null}
    </div>
  );
}
