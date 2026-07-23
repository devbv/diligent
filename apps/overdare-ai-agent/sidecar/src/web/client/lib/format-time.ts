// @summary Relative time formatter: "just now", "2m ago", "3h ago", "yesterday", "Jan 5"

export function formatRelativeTime(ts: number | string): string {
  const date = typeof ts === "string" ? new Date(ts) : new Date(ts);
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;

  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
