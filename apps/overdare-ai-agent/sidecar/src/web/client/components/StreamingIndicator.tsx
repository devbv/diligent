// @summary Bouncing dots streaming indicator shown while the agent is thinking

export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border/10 bg-surface/50 px-4 py-2 text-sm text-muted shadow-sm">
      <span className="flex gap-1">
        <span className="h-1 w-1 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
      </span>
      Thinking…
    </div>
  );
}
