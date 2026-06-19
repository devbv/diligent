// @summary Builds stable virtual row descriptors from thread render items and prompts

import type { RenderItem } from "../../lib/thread-store";
import { normalizeToolName } from "../../lib/thread-utils";
import { isRenderableAssistantContentBlock } from "../AssistantContentBlocks";
import { estimateCollabGroupHeight, estimateMessageHeight } from "./row-estimates";
import type { CollabItem, MessageContentItem, MessageListProps, VirtualMessageRow } from "./types";

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
  return (
    (!suppressThinking && item.thinking.length > 0) ||
    item.text.length > 0 ||
    item.contentBlocks.some(isRenderableAssistantContentBlock)
  );
}

/** Group consecutive collab items, render everything else as virtualizer rows. */
export function buildGroupedRows(items: RenderItem[]): VirtualMessageRow[] {
  const result: VirtualMessageRow[] = [];
  let collabBuf: CollabItem[] = [];

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

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    switch (item.kind) {
      case "collab":
        collabBuf.push(item);
        break;
      case "context":
      case "error":
      case "tool":
      case "user":
        flushCollab();
        result.push(createMessageRow(item));
        break;
      case "assistant": {
        flushCollab();
        const nextItem = items[idx + 1];
        const isFollowedByUserInputTool =
          nextItem?.kind === "tool" && normalizeToolName(nextItem.toolName) === "request_user_input";
        const displayItem = isFollowedByUserInputTool ? { ...item, text: "" } : item;
        if (shouldRenderAssistantRow(displayItem)) {
          result.push(createMessageRow(displayItem, false));
        }
        break;
      }
    }
  }
  flushCollab();
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
  threadStatus,
  isCompacting,
  approvalPrompt,
  questionPrompt,
}: Pick<MessageListProps, "threadStatus" | "isCompacting" | "approvalPrompt" | "questionPrompt">): VirtualMessageRow[] {
  const rows: VirtualMessageRow[] = [];

  if (threadStatus === "busy" && !isCompacting && !approvalPrompt && !questionPrompt) {
    rows.push({
      kind: "streaming",
      key: "status:streaming",
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
