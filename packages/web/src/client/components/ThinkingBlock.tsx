// @summary Collapsible thinking/reasoning block — streams live while thinking, collapses when done

import { renderInlineMarkdown } from "../lib/markdown";
import { MarkdownContent } from "./MarkdownContent";

interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
  durationLabel?: string | null;
}

function summarize(text: string): string {
  const first = text.split(/[.\n]/)[0].trim();
  if (!first) return "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export function ThinkingBlock({ text, streaming = false, durationLabel = null }: ThinkingBlockProps) {
  if (streaming) {
    return <MarkdownContent text={text} className="thinking-content py-1" />;
  }

  const summary = summarize(text);
  const summaryHtml = summary ? renderInlineMarkdown(summary) : "";

  return (
    <details className="rounded-lg bg-transparent py-1 opacity-70 transition hover:opacity-100">
      <summary className="inline-flex list-none cursor-pointer select-none items-center gap-2 font-mono text-xs uppercase tracking-wider">
        <span className="text-text-secondary">Thought</span>
        {durationLabel ? <span className="text-muted/70">{durationLabel}</span> : null}
        {summary ? (
          <span
            className="max-w-thinking-summary truncate normal-case tracking-normal text-muted/80"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: agent output only — matches MarkdownContent trust boundary
            dangerouslySetInnerHTML={{ __html: summaryHtml }}
          />
        ) : null}
      </summary>
      <MarkdownContent text={text} className="thinking-content mt-2" />
    </details>
  );
}
