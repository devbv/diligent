// @summary Small shared formatting helpers for transcript timing labels

interface MessageTimestampFormatOptions {
  now?: number;
  timeZone?: string;
  hour12?: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function localHour12Preference(): boolean {
  const hourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  return hourCycle === "h11" || hourCycle === "h12";
}

function localYear(timestamp: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", ...(timeZone ? { timeZone } : {}) }).format(timestamp);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function formatDurationLabel(durationMs?: number): string | null {
  if (durationMs === undefined || Number.isNaN(durationMs) || durationMs < 1000) return null;

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatMessageTimestamp(timestamp: number, options: MessageTimestampFormatOptions = {}): string {
  const now = options.now ?? Date.now();
  const elapsed = Math.max(0, now - timestamp);

  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `${minutes}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `${hours}h ago`;
  }

  const includeYear = localYear(timestamp, options.timeZone) !== localYear(now, options.timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: options.hour12 ?? localHour12Preference(),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const parts = formatter.formatToParts(timestamp);
  const date = `${partValue(parts, "month")} ${partValue(parts, "day")}${includeYear ? `, ${partValue(parts, "year")}` : ""}`;
  const period = partValue(parts, "dayPeriod");
  return `${date}, ${partValue(parts, "hour")}:${partValue(parts, "minute")}${period ? ` ${period}` : ""}`;
}

export function formatMessageTimestampTooltip(
  timestamp: number,
  options: Pick<MessageTimestampFormatOptions, "timeZone"> = {},
): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const parts = formatter.formatToParts(timestamp);
  const timezone = partValue(parts, "timeZoneName") || formatter.resolvedOptions().timeZone;
  return `${partValue(parts, "year")}-${partValue(parts, "month")}-${partValue(parts, "day")} ${partValue(parts, "hour")}:${partValue(parts, "minute")} ${timezone}`;
}
