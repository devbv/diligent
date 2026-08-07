// @summary 12px context-usage ring with a hover tooltip that replaces the composer's inline token counter

import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { usageTooltipClasses } from "./ui-styles";

const GAUGE_TRACK_COLOR = "#565F69";
/**
 * The design export paints the progress arc by masking a white rect; the `#40BF80` in the file sits
 * on the mask's own path, which `mask-type: alpha` discards. So the swept arc is white, not green.
 */
const GAUGE_FILL_COLOR = "#FFFFFF";
/**
 * Design `progressbar`: a 12px ring whose outer edge is r6 and inner edge r4.2, so the stroke is
 * 1.8px wide centred on r5.1. The fill sweeps clockwise from 12 o'clock.
 */
const GAUGE_RADIUS = 5.1;
const GAUGE_STROKE = 1.8;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
/** The tooltip trails the cursor; below-right is preferred, flipping above when the viewport is tight. */
const TOOLTIP_CURSOR_OFFSET_X = 12;
const TOOLTIP_CURSOR_OFFSET_Y = 16;
/** Design `tooltip` height, used to decide the flip and to keep the box on screen. */
const TOOLTIP_HEIGHT = 32;
const TOOLTIP_MAX_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function getUsageGaugeRatio(currentContextTokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.min(1, Math.max(0, currentContextTokens / contextWindow));
}

export function formatUsageTooltipLabel(currentContextTokens: number, contextWindow: number): string | null {
  if (contextWindow <= 0) return null;
  const pct = Math.round(getUsageGaugeRatio(currentContextTokens, contextWindow) * 100);
  return `${formatTokenCount(currentContextTokens)} / ${formatTokenCount(contextWindow)} tokens used (${pct}% Full)`;
}

export interface TooltipPosition {
  left: number;
  top: number;
}

/**
 * Places the tooltip relative to the cursor rather than the trigger, flipping above the pointer and
 * clamping horizontally so it never leaves the viewport.
 */
export function getCursorTooltipPosition(args: {
  cursor: { x: number; y: number };
  tooltipWidth: number;
  viewportWidth: number;
  viewportHeight: number;
}): TooltipPosition {
  const fitsBelow = args.viewportHeight - args.cursor.y >= TOOLTIP_HEIGHT + TOOLTIP_CURSOR_OFFSET_Y;
  const maxLeft = Math.max(VIEWPORT_MARGIN, args.viewportWidth - args.tooltipWidth - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(args.cursor.x + TOOLTIP_CURSOR_OFFSET_X, VIEWPORT_MARGIN), maxLeft),
    top: fitsBelow ? args.cursor.y + TOOLTIP_CURSOR_OFFSET_Y : args.cursor.y - TOOLTIP_HEIGHT - TOOLTIP_CURSOR_OFFSET_Y,
  };
}

export function UsageGauge({ ratio, className }: { ratio: number; className?: string }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return (
    <svg
      viewBox="0 0 12 12"
      data-icon="usage-gauge"
      data-usage-percent={Math.round(clamped * 100)}
      aria-hidden="true"
      focusable="false"
      className={cn("block h-3 w-3 shrink-0", className)}
    >
      <circle cx="6" cy="6" r={GAUGE_RADIUS} fill="none" stroke={GAUGE_TRACK_COLOR} strokeWidth={GAUGE_STROKE} />
      {clamped > 0 ? (
        <circle
          cx="6"
          cy="6"
          r={GAUGE_RADIUS}
          fill="none"
          stroke={GAUGE_FILL_COLOR}
          strokeWidth={GAUGE_STROKE}
          strokeDasharray={`${clamped * GAUGE_CIRCUMFERENCE} ${GAUGE_CIRCUMFERENCE}`}
          transform="rotate(-90 6 6)"
        />
      ) : null}
    </svg>
  );
}

/**
 * Renders the tooltip body in a fixed portal so the composer frame cannot clip it.
 * Callers own the cursor state because the gauge sits inside the model trigger button.
 */
export function UsageTooltip({ cursor, label }: { cursor: { x: number; y: number } | null; label: string | null }) {
  if (!cursor || !label || typeof document === "undefined") return null;

  const position = getCursorTooltipPosition({
    cursor,
    tooltipWidth: TOOLTIP_MAX_WIDTH,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  return createPortal(
    <div role="tooltip" className={usageTooltipClasses} style={{ left: position.left, top: position.top }}>
      {label}
    </div>,
    document.body,
  );
}
