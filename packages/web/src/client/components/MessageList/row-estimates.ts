// @summary Height estimates for dynamic MessageList rows before browser measurement

import type { ContentBlock } from "@diligent/protocol";
import type { RenderItem } from "../../lib/thread-store";
import { isRenderableAssistantContentBlock, isToolLikeAssistantContentBlock } from "../AssistantContentBlocks";
import {
  COLLAPSED_TOOL_BLOCK_ESTIMATE_PX,
  DEFAULT_ESTIMATED_ROW_HEIGHT_PX,
  MESSAGE_LIST_VERTICAL_PADDING_PX,
  MESSAGE_ROW_GAP_PX,
} from "./constants";
import type { CollabItem, VirtualMessageRow } from "./types";

export function estimateRowOuterHeight(row: VirtualMessageRow, index: number, rowCount: number): number {
  return (
    row.estimatedSize +
    (index === 0 ? MESSAGE_LIST_VERTICAL_PADDING_PX : 0) +
    (index < rowCount - 1 ? MESSAGE_ROW_GAP_PX : MESSAGE_LIST_VERTICAL_PADDING_PX)
  );
}

function estimateTextHeight(text: string, baseHeight: number): number {
  if (!text) return baseHeight;
  const visualLines = text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 90)), 0);
  return baseHeight + Math.min(visualLines, 28) * 24;
}

function estimateContentBlockHeight(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTextHeight(block.text, 4) + (block.citations?.length ?? 0) * 20;
    case "provider_tool_use":
    case "web_search_result":
    case "web_fetch_result":
      return COLLAPSED_TOOL_BLOCK_ESTIMATE_PX;
    default:
      return 0;
  }
}

function estimateContentBlocksHeight(blocks: ContentBlock[]): number {
  const renderableBlocks = blocks.filter(isRenderableAssistantContentBlock);
  if (renderableBlocks.length === 0) return 0;
  const blockHeights = renderableBlocks.reduce((total, block) => total + estimateContentBlockHeight(block), 0);
  return blockHeights + Math.max(0, renderableBlocks.length - 1) * MESSAGE_ROW_GAP_PX;
}

function estimateAssistantThinkingHeight(item: Extract<RenderItem, { kind: "assistant" }>): number {
  if (!item.thinking) return 0;
  return item.thinkingDone ? 32 : estimateTextHeight(item.thinking, 4);
}

export function estimateCollabGroupHeight(items: CollabItem[]): number {
  const childToolCount = items.reduce((count, item) => count + item.childTools.length, 0);
  return 112 + items.length * 54 + childToolCount * 24;
}

export function estimateMessageHeight(item: RenderItem): number {
  switch (item.kind) {
    case "assistant": {
      const contentBlocksHeight = estimateContentBlocksHeight(item.contentBlocks);
      const textHeight = contentBlocksHeight > 0 ? 0 : estimateTextHeight(item.text, 4);
      const thinkingHeight = estimateAssistantThinkingHeight(item);
      const hasToolLikeBlocks = item.contentBlocks
        .filter(isRenderableAssistantContentBlock)
        .some(isToolLikeAssistantContentBlock);
      const dividerHeight = item.thinkingDone && !hasToolLikeBlocks ? 28 : 0;
      return Math.max(28, textHeight + thinkingHeight + contentBlocksHeight + dividerHeight + 8);
    }
    case "user":
      return estimateTextHeight(item.text, 60) + item.images.length * 112 + (item.contextItems?.length ?? 0) * 28;
    case "context":
      return 112;
    case "tool":
      return item.status === "streaming" ? 52 : 68;
    case "collab":
      return DEFAULT_ESTIMATED_ROW_HEIGHT_PX;
  }
}
