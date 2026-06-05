// @summary Edit/Write-tool panel: file path header with diff-style old→new display

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";

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
    <div className={`overflow-hidden rounded border ${borderClass} ${bgClass}`}>
      <div className="flex items-center justify-between border-b border-border/10 px-2 py-1">
        <span className={`font-mono text-2xs uppercase tracking-wider ${labelClass}`}>
          {prefix} {label}
        </span>
        <CopyButton text={text} />
      </div>
      <pre className={`overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed ${textClass}`}>{visible}</pre>
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
    <div className="overflow-hidden rounded-lg border border-border/100 bg-surface-dark font-mono text-xs">
      {/* File header */}
      <div className="flex items-center gap-2 border-b border-border/100 bg-surface-default px-3 py-2">
        <span className="shrink-0 text-text-secondary">✎</span>
        <span className="min-w-0 flex-1 truncate text-text/80">{filePath ?? "file"}</span>
        <span className="shrink-0 rounded bg-fill-active px-1.5 py-0.5 text-2xs text-text">
          {mode === "edit" ? "edit" : "write"}
        </span>
      </div>

      {/* Diff view for edit */}
      {mode === "edit" && (oldString || newString) ? (
        <div className="space-y-1 p-2">
          {oldString ? <DiffBlock label="old" text={oldString} color="danger" /> : null}
          {newString ? <DiffBlock label="new" text={newString} color="success" /> : null}
        </div>
      ) : null}

      {/* Full content for write */}
      {mode === "write" && content ? (
        <div className="p-2">
          <ContentPreview text={content} isError={isError} />
        </div>
      ) : null}

      {/* Result message */}
      {output ? (
        <div className={`border-t border-border/10 px-3 py-1.5 ${isError ? "text-muted" : "text-muted/80"}`}>
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
    <div className="overflow-hidden rounded border border-border/100 bg-surface-default">
      <div className="flex items-center justify-end border-b border-border/10 px-2 py-1">
        <CopyButton text={text} />
      </div>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed ${
          isError ? "text-muted" : "text-text/70"
        }`}
      >
        {visible}
      </pre>
      {isLong ? (
        <ExpandButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} detail={`${lines.length} lines`} />
      ) : null}
    </div>
  );
}
