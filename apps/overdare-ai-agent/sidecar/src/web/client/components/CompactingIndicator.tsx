// @summary Animated indicator shown while context compaction is in progress

export function CompactingIndicator() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border/10 bg-surface/50 px-4 py-2 text-sm text-muted shadow-sm">
      <span className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info [animation-delay:200ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info [animation-delay:400ms]" />
      </span>
      Compacting…
    </div>
  );
}
