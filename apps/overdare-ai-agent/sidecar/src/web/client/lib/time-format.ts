// @summary Small shared formatting helpers for transcript timing labels

export function formatDurationLabel(durationMs?: number): string | null {
  if (durationMs === undefined || Number.isNaN(durationMs) || durationMs < 1000) return null;

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
