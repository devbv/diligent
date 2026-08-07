// @summary Pins the composer menu/tooltip math against the Figma spec (28px header, 8px inset, 24px rows, 2px submenu gap)

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getEffortMenuHeight,
  getEffortMenuPosition,
  getModelsMenuHeight,
} from "../../../../src/web/client/components/ModelEffortSelect";
import {
  formatUsageTooltipLabel,
  getCursorTooltipPosition,
  getUsageGaugeRatio,
  UsageGauge,
} from "../../../../src/web/client/components/UsageGauge";

test("menu heights match the design panels", () => {
  // Hairline 2 + header 28 + eight rows 200 + rule 1 + Effort row 32.
  expect(getModelsMenuHeight(8)).toBe(263);
  // Effort panel carries no header of its own: 180x130 for five rows.
  expect(getEffortMenuHeight(5)).toBe(130);
});

test("effort submenu sits 2px right of the models panel and bottom-aligns with it", () => {
  // Design: both panels end on the same baseline, so the submenu is placed from the panel's bottom.
  expect(
    getEffortMenuPosition({ panelRect: { bottom: 565, right: 896 }, submenuHeight: 130, viewportHeight: 900 }),
  ).toEqual({ left: 898, top: 435 });

  // A panel bottomed past the viewport pulls the submenu up rather than letting it overflow.
  expect(
    getEffortMenuPosition({ panelRect: { bottom: 890, right: 400 }, submenuHeight: 130, viewportHeight: 768 }),
  ).toEqual({ left: 402, top: 630 });

  // A submenu taller than the viewport clamps to the top margin instead of going negative.
  expect(
    getEffortMenuPosition({ panelRect: { bottom: 400, right: 100 }, submenuHeight: 900, viewportHeight: 768 }),
  ).toEqual({ left: 102, top: 8 });
});

test("usage gauge is a 1.8px ring, not a filled pie", () => {
  // Figma `progressbar`: outer edge r6, inner edge r4.2 — so stroke 1.8 centred on r5.1, in a 12px box.
  const html = renderToStaticMarkup(UsageGauge({ ratio: 0.25 }));
  expect(html).toContain('viewBox="0 0 12 12"');
  expect(html).toContain('r="5.1"');
  expect(html).toContain('stroke-width="1.8"');
  expect(html).toContain('fill="none"');
  expect(html).toContain('stroke="#565F69"');
  // The export masks a white rect for the swept arc — the file's #40BF80 lives on the discarded mask path.
  expect(html).toContain('stroke="#FFFFFF"');
  expect(html).not.toContain("#40BF80");
  // Sweeps clockwise from 12 o'clock.
  expect(html).toContain('transform="rotate(-90 6 6)"');
  expect(html).not.toContain("conic-gradient");

  const circumference = 2 * Math.PI * 5.1;
  expect(html).toContain(`stroke-dasharray="${0.25 * circumference} ${circumference}"`);

  // An unused context window draws the track only.
  const empty = renderToStaticMarkup(UsageGauge({ ratio: 0 }));
  expect(empty).not.toContain("#FFFFFF");
  expect(empty).toContain('data-usage-percent="0"');
});

test("usage tooltip trails the cursor and stays inside the viewport", () => {
  const viewport = { viewportWidth: 1200, viewportHeight: 800, tooltipWidth: 320 };

  // Room below: 12px right / 16px down from the pointer.
  expect(getCursorTooltipPosition({ cursor: { x: 400, y: 300 }, ...viewport })).toEqual({ left: 412, top: 316 });

  // No room below: flip above the pointer.
  expect(getCursorTooltipPosition({ cursor: { x: 400, y: 790 }, ...viewport })).toEqual({ left: 412, top: 742 });

  // Near the right edge: clamp so the 320px box stays on screen.
  expect(getCursorTooltipPosition({ cursor: { x: 1180, y: 300 }, ...viewport })).toEqual({ left: 872, top: 316 });
});

test("usage ratio clamps and the tooltip reads as designed", () => {
  expect(getUsageGaugeRatio(0, 0)).toBe(0);
  expect(getUsageGaugeRatio(500, 1000)).toBe(0.5);
  expect(getUsageGaugeRatio(2000, 1000)).toBe(1);

  expect(formatUsageTooltipLabel(667_900, 1_000_000)).toBe("667.9K / 1.0M tokens used (67% Full)");
  expect(formatUsageTooltipLabel(940, 200_000)).toBe("940 / 200.0K tokens used (0% Full)");
  expect(formatUsageTooltipLabel(1000, 0)).toBeNull();
});
