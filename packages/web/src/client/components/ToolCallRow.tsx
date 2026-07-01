// @summary Compact tool call row with one-line summary and click-to-expand detail panel

import { useState } from "react";
import { cn } from "../lib/cn";
import type { RenderItem } from "../lib/thread-store";
import { normalizeToolName } from "../lib/thread-utils";
import { getToolHeaderTitle, summarizeInput, summarizeOutput } from "../lib/tool-info";
import { ContentText } from "./ContentText";
import { StatusDot } from "./StatusDot";

interface ToolCallRowProps {
  item: Extract<RenderItem, { kind: "tool" }>;
}

export function ToolCallRow({ item }: ToolCallRowProps) {
  const [open, setOpen] = useState(false);
  const renderPayload = item.render;
  const headerTitle = getToolHeaderTitle(item.toolName, renderPayload);
  const normalizedToolName = normalizeToolName(item.toolName);
  const isUserInput = normalizedToolName === "request_user_input";
  const outputSummary = renderPayload && !isUserInput && item.status === "done" ? summarizeOutput(renderPayload) : "";
  const showOutputSummary = Boolean(outputSummary) && outputSummary !== summarizeInput(renderPayload);

  const statusEl = item.isError ? (
    <span className="shrink-0 text-xs text-danger">error</span>
  ) : item.status === "streaming" ? (
    <span className="flex shrink-0 items-center gap-1 text-xs text-accent">
      <StatusDot color="accent" pulse />
    </span>
  ) : null;

  const chevronEl =
    item.status !== "streaming" && !item.isError ? (
      <span
        className={cn(
          "shrink-0 text-sm leading-none text-muted transition-transform",
          open ? "rotate-180" : "rotate-0",
        )}
      >
        ▾
      </span>
    ) : null;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-tool-row rounded-lg bg-surface-dark">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex max-w-full flex-col gap-0.5 text-left"
          disabled={item.status === "streaming"}
        >
          {/* Header row */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-muted">{headerTitle}</span>
            {chevronEl}
            {statusEl}
          </div>
          {/* Summary rows */}
          {showOutputSummary ? (
            <div className="flex flex-col gap-0.5">
              <span className="max-w-tool-summary truncate font-mono text-xs text-text-tertiary">
                ↳ {outputSummary}
              </span>
            </div>
          ) : null}
        </button>

        {open ? (
          <div className="space-y-2">
            {item.inputText ? <ContentText text={item.inputText} label="Input" /> : null}
            {item.outputText ? <ContentText text={item.outputText} label="Output" isError={item.isError} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
