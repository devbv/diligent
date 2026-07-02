// @summary Unit tests for compact transcript duration formatting

import { expect, test } from "bun:test";
import { formatDurationLabel } from "../../../src/client/lib/time-format";

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
