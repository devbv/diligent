// @summary Renders structured P040 ToolRenderPayload blocks matching the existing Content* component style

import type {
  CommandBlock,
  DiffBlock,
  DiffFile,
  FileBlock,
  KeyValueBlock,
  ListBlock,
  StatusBadgesBlock,
  SummaryBlock,
  TableBlock,
  ToolRenderBlock,
  ToolRenderPayload,
  ToolRenderTextBlock,
  TreeBlock,
  TreeNode,
} from "@diligent/protocol";
import { useState } from "react";
import { cn } from "../lib/cn";
import { CopyButton } from "./CopyButton";
import { ExpandButton } from "./ExpandButton";

/* ── Shared wrapper ───────────────────────────────────────────────── */

function BlockShell({ title, copyText, children }: { title?: string; copyText?: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/100 bg-surface-dark">
      {title && (
        <div className="flex items-center justify-between border-b border-border/100 bg-surface-default px-3 py-2">
          <span className="font-mono text-2xs uppercase tracking-wider text-muted">{title}</span>
          {copyText && <CopyButton text={copyText} />}
        </div>
      )}
      {children}
    </div>
  );
}

/* ── Tone helpers ─────────────────────────────────────────────────── */

const TONE_TEXT: Record<string, string> = {
  default: "text-text/80",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-text-secondary",
};

function toneText(tone?: string) {
  return TONE_TEXT[tone ?? "default"] ?? TONE_TEXT.default;
}

/* ── SummaryBlock ─────────────────────────────────────────────────── */

function RenderSummary({ block }: { block: SummaryBlock }) {
  return <div className={cn("px-3 py-2 font-mono text-xs", toneText(block.tone))}>{block.text}</div>;
}

/* ── TextBlock ─────────────────────────────────────────────────────── */

function RenderText({ block }: { block: ToolRenderTextBlock }) {
  return (
    <BlockShell title={block.title} copyText={block.text}>
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed",
          block.isError ? "text-danger/90" : "text-text/80",
        )}
      >
        {block.text}
      </pre>
    </BlockShell>
  );
}

/* ── KeyValueBlock ────────────────────────────────────────────────── */

function RenderKeyValue({ block }: { block: KeyValueBlock }) {
  const copyText = block.items.map((i) => `${i.key}: ${i.value}`).join("\n");
  const maxKeyLen = block.items.reduce((m, i) => Math.max(m, i.key.length), 0);

  return (
    <BlockShell title={block.title ?? "key / value"} copyText={copyText}>
      <dl className="px-3 py-2 font-mono text-xs">
        {block.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <div key={i} className="flex gap-3 leading-relaxed">
            <dt className="shrink-0 text-muted" style={{ width: `${maxKeyLen}ch` }}>
              {item.key}
            </dt>
            <dd className="min-w-0 truncate text-text/80">{item.value}</dd>
          </div>
        ))}
      </dl>
    </BlockShell>
  );
}

/* ── ListBlock ────────────────────────────────────────────────────── */

function RenderList({ block }: { block: ListBlock }) {
  const copyText = block.items.join("\n");

  return (
    <BlockShell title={block.title} copyText={copyText}>
      <ul className="px-3 py-2 font-mono text-xs leading-relaxed text-text/80">
        {block.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <li key={i} className="flex items-baseline gap-2">
            <span className="shrink-0 text-muted">{block.ordered ? `${i + 1}.` : "·"}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </BlockShell>
  );
}

/* ── TableBlock ───────────────────────────────────────────────────── */

function RenderTable({ block }: { block: TableBlock }) {
  const copyText = [block.columns.join("\t"), ...block.rows.map((r) => r.join("\t"))].join("\n");

  return (
    <BlockShell title={block.title} copyText={copyText}>
      <div className="overflow-x-auto px-3 py-2">
        <table className="w-full font-mono text-xs">
          <thead>
            <tr>
              {block.columns.map((col, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static columns
                <th key={i} className="pb-1 pr-4 text-left font-medium text-muted last:pr-0">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static rows
              <tr key={ri} className="border-t border-border/5">
                {block.columns.map((_, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static cells
                  <td key={ci} className="py-0.5 pr-4 text-text/80 last:pr-0">
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BlockShell>
  );
}

/* ── TreeBlock ────────────────────────────────────────────────────── */

function TreeNodeRow({ node, prefix, isLast }: { node: TreeNode; prefix: string; isLast: boolean }) {
  const children = node.children as TreeNode[] | undefined;
  const connector = isLast ? "└─ " : "├─ ";
  const childPrefix = prefix + (isLast ? "   " : "│  ");

  return (
    <>
      <li className="leading-relaxed text-text/80">
        <span className="text-muted">
          {prefix}
          {connector}
        </span>
        {node.label}
      </li>
      {children?.map((child, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static tree
        <TreeNodeRow key={i} node={child} prefix={childPrefix} isLast={i === children.length - 1} />
      ))}
    </>
  );
}

function RenderTree({ block }: { block: TreeBlock }) {
  const nodes = block.nodes as TreeNode[];

  return (
    <BlockShell title={block.title}>
      <ul className="px-3 py-2 font-mono text-xs">
        {nodes.map((node, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static nodes
          <TreeNodeRow key={i} node={node} prefix="" isLast={i === nodes.length - 1} />
        ))}
      </ul>
    </BlockShell>
  );
}

/* ── StatusBadgesBlock ────────────────────────────────────────────── */

const TONE_BADGE: Record<string, string> = {
  default: "bg-fill-secondary text-text/70",
  success: "bg-fill-secondary text-success",
  warning: "bg-fill-secondary text-warning",
  danger: "bg-fill-secondary text-danger",
  info: "bg-fill-active text-text",
};

function toneBadge(tone?: string) {
  return TONE_BADGE[tone ?? "default"] ?? TONE_BADGE.default;
}

function RenderStatusBadges({ block }: { block: StatusBadgesBlock }) {
  return (
    <BlockShell title={block.title}>
      <div className="flex flex-wrap gap-1.5 px-3 py-2">
        {block.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static badges
          <span key={i} className={cn("rounded px-2 py-0.5 font-mono text-xs font-medium", toneBadge(item.tone))}>
            {item.label}
          </span>
        ))}
      </div>
    </BlockShell>
  );
}

/* ── FileBlock ───────────────────────────────────────────────────── */

const FILE_PREVIEW_LINES = 15;

function RenderFile({ block }: { block: FileBlock }) {
  const [expanded, setExpanded] = useState(false);
  const lines = block.content?.split("\n") ?? [];
  const isLong = lines.length > FILE_PREVIEW_LINES;
  const visibleContent = !expanded && isLong ? lines.slice(0, FILE_PREVIEW_LINES).join("\n") : block.content;

  const rangeLabel =
    block.offset && block.limit
      ? `L${block.offset}–${block.offset + block.limit - 1}`
      : block.offset
        ? `from L${block.offset}`
        : block.limit
          ? `${block.limit} lines`
          : "";

  return (
    <div className="overflow-hidden rounded-lg border border-border/100 bg-surface-dark font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-border/100 bg-surface-default px-3 py-2">
        <span className="shrink-0 text-text-secondary">↗</span>
        <span className="min-w-0 flex-1 truncate text-text/80">{block.filePath}</span>
        {rangeLabel ? <span className="shrink-0 text-muted/70">{rangeLabel}</span> : null}
        {block.content ? <CopyButton text={block.content} /> : null}
      </div>
      {block.content ? (
        <div>
          <pre
            className={cn(
              "overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed",
              block.isError ? "text-danger/90" : "text-text/70",
            )}
          >
            {visibleContent}
          </pre>
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

/* ── CommandBlock ────────────────────────────────────────────────── */

const CMD_PREVIEW_LINES = 15;

function RenderCommand({ block }: { block: CommandBlock }) {
  const [expanded, setExpanded] = useState(false);
  const outputLines = block.output?.split("\n") ?? [];
  const isLong = outputLines.length > CMD_PREVIEW_LINES;
  const visibleOutput = !expanded && isLong ? outputLines.slice(0, CMD_PREVIEW_LINES).join("\n") : block.output;

  return (
    <div className="overflow-hidden rounded-lg border border-border/100 bg-surface-dark font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-border/100 bg-surface-default px-3 py-2">
        <span className="shrink-0 text-muted">$</span>
        <pre className="min-w-0 flex-1 whitespace-pre-wrap text-text">{block.command}</pre>
        <CopyButton text={block.command} />
      </div>
      {block.output !== undefined && block.output !== "" && (
        <div>
          <pre
            className={cn(
              "overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed",
              block.isError ? "text-danger/90" : "text-text/80",
            )}
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

/* ── DiffBlock ────────────────────────────────────────────────────── */

const DIFF_PREVIEW_LINES = 12;

function DiffHunkView({ oldString, newString }: { oldString?: string; newString?: string }) {
  const [oldExpanded, setOldExpanded] = useState(false);
  const [newExpanded, setNewExpanded] = useState(false);

  function HalfBlock({
    label,
    text,
    color,
    expanded,
    onToggle,
  }: {
    label: string;
    text: string;
    color: "danger" | "success";
    expanded: boolean;
    onToggle: () => void;
  }) {
    const lines = text.split("\n");
    const isLong = lines.length > DIFF_PREVIEW_LINES;
    const visible = !expanded && isLong ? lines.slice(0, DIFF_PREVIEW_LINES).join("\n") : text;
    const prefix = color === "danger" ? "−" : "+";
    const borderCls = color === "danger" ? "border-danger/20" : "border-success/30";
    const bgCls = color === "danger" ? "bg-danger/10" : "bg-success/10";
    const textCls = color === "danger" ? "text-danger/80" : "text-success";
    const labelCls = color === "danger" ? "text-danger/70" : "text-success";
    return (
      <div className={cn("overflow-hidden rounded border", borderCls, bgCls)}>
        <div className="flex items-center justify-between border-b border-border/10 px-2 py-1">
          <span className={cn("font-mono text-2xs uppercase tracking-wider", labelCls)}>
            {prefix} {label}
          </span>
          <CopyButton text={text} />
        </div>
        <pre className={cn("overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed", textCls)}>{visible}</pre>
        {isLong && <ExpandButton expanded={expanded} onToggle={onToggle} detail={`${lines.length} lines`} />}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {oldString ? (
        <HalfBlock
          label="old"
          text={oldString}
          color="danger"
          expanded={oldExpanded}
          onToggle={() => setOldExpanded((v) => !v)}
        />
      ) : null}
      {newString !== undefined ? (
        <HalfBlock
          label="new"
          text={newString}
          color="success"
          expanded={newExpanded}
          onToggle={() => setNewExpanded((v) => !v)}
        />
      ) : null}
    </div>
  );
}

// Informational status of a diff'd file — past-tense label + a colored status dot
// (intentionally not a filled pill, so it reads as metadata rather than a button/CTA).
const ACTION_STATUS: Record<string, { label: string; color: string }> = {
  Add: { label: "added", color: "text-success" },
  Update: { label: "updated", color: "text-muted" },
  Delete: { label: "deleted", color: "text-danger" },
  Move: { label: "moved", color: "text-warning" },
};

function DiffFileView({ file }: { file: DiffFile }) {
  const status = ACTION_STATUS[file.action ?? "Update"] ?? ACTION_STATUS.Update;
  const displayPath = file.action === "Move" && file.movedTo ? `${file.filePath} → ${file.movedTo}` : file.filePath;

  return (
    <div className="overflow-hidden rounded-lg border border-border/100 bg-surface-dark font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-border/100 bg-surface-default px-3 py-2">
        <span className="shrink-0 text-text-secondary">✎</span>
        <span className="min-w-0 flex-1 truncate text-text/80">{displayPath}</span>
        {file.action ? (
          <span className={cn("flex shrink-0 items-center gap-1.5 text-2xs font-medium", status.color)}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {status.label}
          </span>
        ) : null}
      </div>
      {file.hunks.length > 0 && (
        <div className="space-y-1 p-2">
          {file.hunks.map((hunk, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered hunks
            <DiffHunkView key={i} oldString={hunk.oldString} newString={hunk.newString} />
          ))}
        </div>
      )}
    </div>
  );
}

function RenderDiff({ block }: { block: DiffBlock }) {
  return (
    <div className="space-y-2">
      {block.files.map((file, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered files
        <DiffFileView key={i} file={file} />
      ))}
      {block.output ? (
        <div className={cn("px-1 font-mono text-xs", block.isError ? "text-danger/70" : "text-muted/70")}>
          {block.output.split("\n")[0]}
        </div>
      ) : null}
    </div>
  );
}

/* ── Single block dispatcher ──────────────────────────────────────── */

function RenderBlock({ block }: { block: ToolRenderBlock }) {
  switch (block.type) {
    case "summary":
      return <RenderSummary block={block} />;
    case "text":
      return <RenderText block={block} />;
    case "key_value":
      return <RenderKeyValue block={block} />;
    case "list":
      return <RenderList block={block} />;
    case "table":
      return <RenderTable block={block} />;
    case "tree":
      return <RenderTree block={block} />;
    case "status_badges":
      return <RenderStatusBadges block={block} />;
    case "file":
      return <RenderFile block={block} />;
    case "command":
      return <RenderCommand block={block} />;
    case "diff":
      return <RenderDiff block={block} />;
    default:
      // Unknown block kind — graceful fallback
      return null;
  }
}

/* ── Top-level payload renderer ──────────────────────────────────── */

interface ToolRenderBlocksProps {
  payload: ToolRenderPayload;
  className?: string;
}

export function ToolRenderBlocks({ payload, className }: ToolRenderBlocksProps) {
  if (!payload.blocks || payload.blocks.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {payload.blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered blocks
        <RenderBlock key={i} block={block} />
      ))}
    </div>
  );
}
