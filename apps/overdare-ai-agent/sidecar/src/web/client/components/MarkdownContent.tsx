// @summary Markdown renderer using dangerouslySetInnerHTML with prose styles

import { cn } from "../lib/cn";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownContentProps {
  text: string;
  className?: string;
}

export function MarkdownContent({ text, className }: MarkdownContentProps) {
  return (
    <div
      className={cn("prose-content", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: agent output only — external input echoing requires DOMPurify
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
