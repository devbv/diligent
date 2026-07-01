// @summary Assistant message with left decoration bar, agent icon, thinking block, and markdown content

import type { RenderItem } from "../lib/thread-store";
import {
  AssistantContentBlocks,
  isRenderableAssistantContentBlock,
  isToolLikeAssistantContentBlock,
} from "./AssistantContentBlocks";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingBlock } from "./ThinkingBlock";

function formatMs(ms?: number): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

interface AssistantMessageProps {
  item: Extract<RenderItem, { kind: "assistant" }>;
  suppressThinking?: boolean;
}

export function AssistantMessage({ item, suppressThinking = false }: AssistantMessageProps) {
  const hasThinking = item.thinking.length > 0;
  const hasText = item.text.length > 0;
  const renderableContentBlocks = item.contentBlocks.filter(isRenderableAssistantContentBlock);
  const hasStructuredBlocks = renderableContentBlocks.length > 0;
  const hasToolLikeBlocks = renderableContentBlocks.some(isToolLikeAssistantContentBlock);
  const turnDuration = formatMs(item.turnDurationMs);
  const reasoningDuration = formatMs(item.reasoningDurationMs);
  const showTurnFooter = item.thinkingDone && !hasToolLikeBlocks && Boolean(turnDuration);

  if (!hasThinking && !hasText && !hasStructuredBlocks) return null;

  return (
    <div className="pb-1">
      {hasThinking && !suppressThinking && (
        <div className="pb-3">
          <ThinkingBlock
            text={item.thinking}
            streaming={!item.thinkingDone}
            duration={item.thinkingDone ? reasoningDuration : null}
          />
        </div>
      )}
      {hasStructuredBlocks ? (
        <AssistantContentBlocks blocks={item.contentBlocks} />
      ) : hasText ? (
        <MarkdownContent text={item.text} />
      ) : null}
      {showTurnFooter ? (
        <div className="pt-1 text-xs uppercase tracking-wide text-muted/65">
          <span>{`Completed in ${turnDuration}`}</span>
        </div>
      ) : null}
    </div>
  );
}
