// @summary Message stream renderer for user, assistant (markdown), and thinking (collapsible) blocks

import type { RenderItem } from "../lib/thread-store";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingBlock } from "./ThinkingBlock";

interface StreamBlockProps {
  item: Extract<RenderItem, { kind: "user" | "assistant" }>;
}

export function StreamBlock({ item }: StreamBlockProps) {
  const isUser = item.kind === "user";

  if (isUser) {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-message rounded-lg border border-accent/40 bg-surface-light px-4 py-2.5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{item.text}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-assistant">
        {item.thinking ? <ThinkingBlock text={item.thinking} /> : null}
        <MarkdownContent text={item.text} />
      </div>
    </div>
  );
}
