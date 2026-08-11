// @summary Unit tests for compact transcript duration formatting

import { expect, test } from "bun:test";
import {
  formatDurationLabel,
  formatMessageTimestamp,
  formatMessageTimestampTooltip,
} from "../../../../src/web/client/lib/time-format";

test("formatDurationLabel hides sub-second durations", () => {
  expect(formatDurationLabel()).toBeNull();
  expect(formatDurationLabel(-1)).toBeNull();
  expect(formatDurationLabel(0)).toBeNull();
  expect(formatDurationLabel(999)).toBeNull();
});

test("formatDurationLabel rounds meaningful durations to seconds and minutes", () => {
  expect(formatDurationLabel(1_000)).toBe("1s");
  expect(formatDurationLabel(1_350)).toBe("1s");
  expect(formatDurationLabel(1_600)).toBe("2s");
  expect(formatDurationLabel(59_900)).toBe("1m");
  expect(formatDurationLabel(72_100)).toBe("1m 12s");
  expect(formatDurationLabel(300_058)).toBe("5m");
});

test("formatMessageTimestamp uses relative labels for the first 24 hours without going negative", () => {
  const now = Date.parse("2026-07-27T15:12:00.000Z");

  expect(formatMessageTimestamp(now + 60_000, { now, timeZone: "UTC" })).toBe("just now");
  expect(formatMessageTimestamp(now - 30_000, { now, timeZone: "UTC" })).toBe("just now");
  expect(formatMessageTimestamp(now - 60_000, { now, timeZone: "UTC" })).toBe("1m ago");
  expect(formatMessageTimestamp(now - 27 * 60_000, { now, timeZone: "UTC" })).toBe("27m ago");
  expect(formatMessageTimestamp(now - 60 * 60_000, { now, timeZone: "UTC" })).toBe("1h ago");
  expect(formatMessageTimestamp(now - 23 * 60 * 60_000, { now, timeZone: "UTC" })).toBe("23h ago");
});

test("formatMessageTimestamp switches to a local absolute label after 24 hours", () => {
  const now = Date.parse("2026-07-28T16:12:00.000Z");

  expect(
    formatMessageTimestamp(Date.parse("2026-07-27T15:12:00.000Z"), {
      now,
      timeZone: "UTC",
      hour12: true,
    }),
  ).toBe("Jul 27, 3:12 PM");
  expect(
    formatMessageTimestamp(Date.parse("2025-07-27T15:12:00.000Z"), {
      now,
      timeZone: "UTC",
      hour12: true,
    }),
  ).toBe("Jul 27, 2025, 3:12 PM");
});

test("formatMessageTimestampTooltip includes the full local time and timezone", () => {
  expect(
    formatMessageTimestampTooltip(Date.parse("2026-07-27T15:12:00.000Z"), {
      timeZone: "UTC",
    }),
  ).toBe("2026-07-27 15:12 UTC");
});
