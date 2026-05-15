// @summary Collapsible thinking/reasoning block — streams live while thinking, collapses when done

interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
  duration?: string | null;
}

function summarize(text: string): string {
  const first = text.split(/[.\n]/)[0].trim();
  if (!first) return "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export function ThinkingBlock({ text, streaming = false, duration = null }: ThinkingBlockProps) {
  if (streaming) {
    return (
      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-transparent py-1 font-mono text-xs leading-relaxed text-muted/65">
        {text}
      </div>
    );
  }

  const summary = summarize(text);

  return (
    <details className="rounded-lg bg-transparent py-1 opacity-70 transition hover:opacity-100">
      <summary className="inline-flex list-none cursor-pointer select-none items-center gap-2 font-mono text-xs uppercase tracking-[0.12em]">
        <span className="text-text-secondary">Thought</span>
        {duration ? <span className="text-muted/70">{duration}</span> : null}
        {summary && <span className="max-w-[40ch] truncate normal-case tracking-normal text-muted/80">{summary}</span>}
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-text/78">
        {text}
      </pre>
    </details>
  );
}
