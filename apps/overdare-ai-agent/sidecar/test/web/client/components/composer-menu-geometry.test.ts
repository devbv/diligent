// @summary Pins the composer menu/tooltip math against the Figma spec (28px header, 8px inset, 24px rows, 2px submenu gap)

import { expect, test } from "bun:test";
import { getComposerMenuHeight, getSubmenuPosition } from "../../../../src/web/client/components/ModelEffortSelect";
import { formatUsageTooltipLabel, getUsageGaugeRatio } from "../../../../src/web/client/components/UsageGauge";

test("menu height matches the design panels", () => {
  // Models: 200x228 with 8 rows. Effort: 180x156 with 5 rows.
  expect(getComposerMenuHeight(8)).toBe(228);
  expect(getComposerMenuHeight(5)).toBe(156);
});

test("effort submenu sits 2px right of the models panel and stays inside the viewport", () => {
  expect(getSubmenuPosition({ panelRect: { top: 288, right: 896 }, submenuHeight: 156, viewportHeight: 768 })).toEqual({
    left: 898,
    top: 288,
  });

  // A panel anchored near the bottom pulls the submenu up rather than letting it overflow.
  expect(getSubmenuPosition({ panelRect: { top: 700, right: 400 }, submenuHeight: 156, viewportHeight: 768 })).toEqual({
    left: 402,
    top: 604,
  });

  // A submenu taller than the viewport clamps to the top margin instead of going negative.
  expect(getSubmenuPosition({ panelRect: { top: 40, right: 100 }, submenuHeight: 900, viewportHeight: 768 })).toEqual({
    left: 102,
    top: 8,
  });
});

test("usage ratio clamps and the tooltip reads as designed", () => {
  expect(getUsageGaugeRatio(0, 0)).toBe(0);
  expect(getUsageGaugeRatio(500, 1000)).toBe(0.5);
  expect(getUsageGaugeRatio(2000, 1000)).toBe(1);

  expect(formatUsageTooltipLabel(667_900, 1_000_000)).toBe("667.9K / 1.0M tokens used (67% Full)");
  expect(formatUsageTooltipLabel(940, 200_000)).toBe("940 / 200.0K tokens used (0% Full)");
  expect(formatUsageTooltipLabel(1000, 0)).toBeNull();
});
