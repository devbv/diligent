// @summary Tool call block with icon, summary header, and tool-type-specific expandable content

import { useState } from "react";
import { cn } from "../lib/cn";
import type { RenderItem } from "../lib/thread-store";
import { normalizeToolName } from "../lib/thread-utils";
import { formatToolDurationMs, getToolHeaderTitle, summarizeInput, summarizeOutput } from "../lib/tool-info";
import { ContentText } from "./ContentText";
import { StatusDot } from "./StatusDot";
import { ToolRenderBlocks } from "./ToolRenderBlocks";

interface ToolBlockProps {
  item: Extract<RenderItem, { kind: "tool" }>;
  threadCwd?: string;
}

/* ── Tool-specific expanded content ───────────────────────────────── */

function ToolContent({
  item,
  render,
}: {
  item: Extract<RenderItem, { kind: "tool" }>;
  render?: import("@diligent/protocol").ToolRenderPayload;
}) {
  if (render) {
    return <ToolRenderBlocks payload={render} />;
  }

  // Final fallback: plugins or unknown tools
  return (
    <div className="space-y-2">
      {item.inputText && <ContentText text={item.inputText} label="Input" compact />}
      {item.outputText && <ContentText text={item.outputText} label="Output" compact isError={item.isError} />}
    </div>
  );
}

/* ── Main ToolBlock ─────────────────────────────────────────────── */

export function ToolBlock({ item }: ToolBlockProps) {
  const [open, setOpen] = useState(false);
  const renderPayload = item.render;
  const headerTitle = getToolHeaderTitle(item.toolName, renderPayload);
  const normalizedToolName = normalizeToolName(item.toolName);
  const isUserInput = normalizedToolName === "request_user_input";
  const outputSummary = renderPayload && !isUserInput && item.status === "done" ? summarizeOutput(renderPayload) : "";
  const showOutputSummary =
    normalizedToolName !== "web_action" && Boolean(outputSummary) && outputSummary !== summarizeInput(renderPayload);
  const durationLabel = item.status === "done" ? formatToolDurationMs(item.durationMs) : null;

  const isStreaming = item.status === "streaming";
  const isWebTool = normalizedToolName === "web_action";

  const statusEl =
    isStreaming && !isWebTool ? (
      <span className="flex shrink-0 items-center gap-1 text-xs text-accent">
        <StatusDot color="accent" pulse />
        <span>running</span>
      </span>
    ) : item.isError ? (
      // Recoverable tool error (the agent can self-correct). Rendered muted/gray so it
      // reads as informational rather than a fatal failure (cf. ErrorMessage in MessageList).
      <span className="shrink-0 text-xs text-muted">error</span>
    ) : null;

  const chevronEl = !isStreaming ? (
    <span
      className={cn(
        "shrink-0 text-xs leading-none text-muted transition-transform duration-150",
        open ? "rotate-180" : "rotate-0",
      )}
    >
      ▾
    </span>
  ) : null;

  return (
    <div className="pb-4">
      <div className="min-w-0 rounded-xl bg-surface-dark">
        <button
          type="button"
          onClick={() => !isStreaming && setOpen((v) => !v)}
          disabled={isStreaming}
          className="flex max-w-full flex-col gap-1 rounded-md text-left"
        >
          {/* Header row */}
          <div className="flex items-center gap-2 leading-none">
            <span className="text-sm font-medium leading-none text-text-soft">{headerTitle}</span>
            {durationLabel ? <span className="text-xs leading-none text-text/35">{durationLabel}</span> : null}
            {chevronEl}
            {statusEl}
          </div>
          {/* Summary rows */}
          {showOutputSummary ? (
            <div className="flex flex-col gap-0.5">
              <span className="max-w-[64ch] truncate font-mono text-xs text-text-tertiary">↳ {outputSummary}</span>
            </div>
          ) : null}
        </button>

        {open && (
          <div>
            <ToolContent item={item} render={renderPayload} />
          </div>
        )}
      </div>
    </div>
  );
}
