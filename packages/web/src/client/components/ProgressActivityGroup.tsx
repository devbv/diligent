// @summary Groups assistant thinking with the activity rows that follow it

import type { ThreadReadResponse } from "@diligent/protocol";
import { useState } from "react";
import type { RenderItem } from "../lib/thread-store";
import { isRenderableAssistantContentBlock } from "./AssistantContentBlocks";
import { AssistantMessage } from "./AssistantMessage";
import { CollabGroup } from "./CollabGroup";
import { MarkdownContent } from "./MarkdownContent";
import type { ProgressActivityRow } from "./MessageList/types";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { ToolActivityRow } from "./ToolActivityRow";
import { ToolBlock } from "./ToolBlock";

type AssistantItem = Extract<RenderItem, { kind: "assistant" }>;

function stripMarkdownMarkers(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function summarizeThinking(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => stripMarkdownMarkers(line))
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  return firstLine.length > 96 ? `${firstLine.slice(0, 95)}...` : firstLine;
}

function hasAssistantBody(item: AssistantItem): boolean {
  return item.text.trim().length > 0 || item.contentBlocks.some(isRenderableAssistantContentBlock);
}

function ActivityRow({
  row,
  threadCwd,
  loadChildThread,
}: {
  row: ProgressActivityRow;
  threadCwd?: string;
  loadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}) {
  switch (row.kind) {
    case "collab":
      return <CollabGroup items={row.items} loadChildThread={loadChildThread} />;
    case "toolGroup":
      return <ToolActivityGroup items={row.items} initialOpen={false} />;
    case "message":
      return <ToolBlock item={row.item} threadCwd={threadCwd} showPreviewWhenCollapsed />;
  }
}

export function ProgressActivityGroup({
  assistant,
  activityRows,
  suppressThinking = false,
  threadCwd,
  loadChildThread,
}: {
  assistant: AssistantItem;
  activityRows: ProgressActivityRow[];
  suppressThinking?: boolean;
  threadCwd?: string;
  loadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}) {
  const [open, setOpen] = useState(!assistant.thinkingDone);
  const hasThinking = !suppressThinking && assistant.thinking.trim().length > 0;
  const hasBody = hasAssistantBody(assistant);
  const thinkingSummary = hasThinking ? summarizeThinking(assistant.thinking) : "";
  const titlePrefix = assistant.thinkingDone ? "Thought" : "Thinking";
  const title = thinkingSummary ? `${titlePrefix}: ${thinkingSummary}` : titlePrefix;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-tool-row">
        <ToolActivityRow
          title={title}
          icon="sparkles"
          category="context"
          status={assistant.thinkingDone ? "done" : "streaming"}
          isError={false}
          isBusy={!assistant.thinkingDone}
          durationLabel={null}
          expanded={open}
          expandable={hasThinking || hasBody || activityRows.length > 0}
          onToggle={() => setOpen((value) => !value)}
        />

        {open ? (
          <div className="mt-0.5 space-y-0">
            {hasThinking ? <MarkdownContent text={assistant.thinking} className="thinking-content py-0.5" /> : null}
            {hasBody ? (
              <div className="py-0.5">
                <AssistantMessage item={assistant} suppressThinking />
              </div>
            ) : null}
            {activityRows.map((activityRow) => (
              <ActivityRow
                key={activityRow.key}
                row={activityRow}
                threadCwd={threadCwd}
                loadChildThread={loadChildThread}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
