// @summary Builds stable virtual row descriptors from thread render items and prompts

import type { RenderItem } from "../../lib/thread-store";
import { normalizeToolName } from "../../lib/thread-utils";
import { hasRenderableAssistantResponseContent } from "../AssistantContentBlocks";
import { estimateCollabGroupHeight, estimateMessageHeight, estimateToolGroupHeight } from "./row-estimates";
import type { CollabItem, MessageContentItem, MessageListProps, ToolItem, VirtualMessageRow } from "./types";

function createMessageRow(
  item: MessageContentItem,
  suppressThinking?: boolean,
  estimatedItem: MessageContentItem = item,
): VirtualMessageRow {
  return {
    kind: "message",
    key: item.id,
    estimatedSize: estimateMessageHeight(estimatedItem),
    item,
    suppressThinking,
  };
}

function shouldRenderAssistantRow(item: Extract<RenderItem, { kind: "assistant" }>, suppressThinking = false): boolean {
  return (!suppressThinking && item.thinking.length > 0) || hasRenderableAssistantResponseContent(item);
}

function hasAssetGallery(item: ToolItem): boolean {
  return Boolean(item.render?.blocks.some((block) => block.type === "asset_gallery"));
}

function canGroupTool(item: ToolItem): boolean {
  const normalized = normalizeToolName(item.toolName);
  return normalized !== "request_user_input" && !hasAssetGallery(item);
}

/** Group consecutive collab/tool activity items, render everything else as virtualizer rows. */
export function buildGroupedRows(items: RenderItem[]): VirtualMessageRow[] {
  const result: VirtualMessageRow[] = [];
  let collabBuf: CollabItem[] = [];
  let toolBuf: ToolItem[] = [];

  const flushCollab = () => {
    if (collabBuf.length === 0) return;
    const groupKey = collabBuf.map((c) => c.id).join("+");
    result.push({
      kind: "collab",
      key: `collab:${groupKey}`,
      estimatedSize: estimateCollabGroupHeight(collabBuf),
      items: [...collabBuf],
    });
    collabBuf = [];
  };

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    if (toolBuf.length === 1) {
      result.push(createMessageRow(toolBuf[0]));
    } else {
      const groupKey = toolBuf.map((item) => item.id).join("+");
      result.push({
        kind: "toolGroup",
        key: `tool-group:${groupKey}`,
        estimatedSize: estimateToolGroupHeight(toolBuf),
        items: [...toolBuf],
      });
    }
    toolBuf = [];
  };

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    switch (item.kind) {
      case "collab":
        flushTools();
        collabBuf.push(item);
        break;
      case "tool":
        flushCollab();
        if (canGroupTool(item)) {
          toolBuf.push(item);
        } else {
          flushTools();
          result.push(createMessageRow(item));
        }
        break;
      case "context":
      case "user":
        flushCollab();
        flushTools();
        result.push(createMessageRow(item));
        break;
      case "assistant": {
        const nextItem = items[idx + 1];
        const isFollowedByUserInputTool =
          nextItem?.kind === "tool" && normalizeToolName(nextItem.toolName) === "request_user_input";
        const displayItem = isFollowedByUserInputTool ? { ...item, text: "" } : item;
        if (shouldRenderAssistantRow(displayItem)) {
          flushCollab();
          flushTools();
          result.push(createMessageRow(displayItem, false));
        }
        break;
      }
    }
  }
  flushCollab();
  flushTools();
  return result;
}

export function applyCompactingVisibility(
  groupedRows: VirtualMessageRow[],
  isCompacting?: boolean,
): VirtualMessageRow[] {
  if (!isCompacting) return groupedRows;

  return groupedRows.flatMap((row) => {
    if (row.kind !== "message" || row.item.kind !== "assistant") return [row];
    if (!shouldRenderAssistantRow(row.item, true)) return [];
    return [createMessageRow(row.item, true, { ...row.item, thinking: "" })];
  });
}

export function buildTrailingRows({
  items,
  threadStatus,
  isCompacting,
  approvalPrompt,
  questionPrompt,
}: Pick<
  MessageListProps,
  "items" | "threadStatus" | "isCompacting" | "approvalPrompt" | "questionPrompt"
>): VirtualMessageRow[] {
  const rows: VirtualMessageRow[] = [];

  if (threadStatus === "busy" && !isCompacting && !approvalPrompt && !questionPrompt) {
    rows.push({
      kind: "streaming",
      key: "status:streaming",
      estimatedSize: 44,
    });
  }

  const lastItem = items[items.length - 1];
  const hasCompletedResponse = lastItem?.kind === "assistant" && shouldRenderAssistantRow(lastItem);
  if (threadStatus === "idle" && hasCompletedResponse && !isCompacting && !approvalPrompt && !questionPrompt) {
    rows.push({
      kind: "responseComplete",
      key: "status:response-complete",
      estimatedSize: 44,
    });
  }

  if (isCompacting) {
    rows.push({
      kind: "compacting",
      key: "status:compacting",
      estimatedSize: 44,
    });
  }

  if (approvalPrompt) {
    rows.push({
      kind: "approval",
      key: `prompt:approval:${approvalPrompt.request.toolName}:${approvalPrompt.request.permission}`,
      estimatedSize: 220,
      prompt: approvalPrompt,
    });
  }

  if (questionPrompt) {
    rows.push({
      kind: "question",
      key: `prompt:question:${questionPrompt.request.questions.map((question) => question.id).join("+")}`,
      estimatedSize: 320,
      prompt: questionPrompt,
    });
  }

  rows.push({
    kind: "bottom",
    key: "sentinel:bottom",
    estimatedSize: 1,
  });

  return rows;
}
