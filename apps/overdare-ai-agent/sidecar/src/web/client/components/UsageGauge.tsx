// @summary 12px context-usage ring with a hover tooltip that replaces the composer's inline token counter

import { type RefObject, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { usageTooltipClasses } from "./ui-styles";

const GAUGE_TRACK_COLOR = "#565F69";
const GAUGE_FILL_COLOR = "#40BF80";
/**
 * Design `progressbar`: a 12px ring whose outer edge is r6 and inner edge r4.2, so the stroke is
 * 1.8px wide centred on r5.1. The fill sweeps clockwise from 12 o'clock.
 */
const GAUGE_RADIUS = 5.1;
const GAUGE_STROKE = 1.8;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
/** Gap between the anchor and the tooltip, per the design's 4px offset. */
const TOOLTIP_OFFSET = 4;
/** Below-placement is preferred; flip above when the viewport cannot fit the 32px tooltip. */
const TOOLTIP_HEIGHT = 32;

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

interface TooltipPosition {
  left: number;
  top: number;
}

function useTooltipPosition(anchorRef: RefObject<HTMLElement | null>, open: boolean): TooltipPosition | null {
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fitsBelow = window.innerHeight - rect.bottom >= TOOLTIP_HEIGHT + TOOLTIP_OFFSET;
      setPosition({
        left: rect.left,
        top: fitsBelow ? rect.bottom + TOOLTIP_OFFSET : rect.top - TOOLTIP_HEIGHT - TOOLTIP_OFFSET,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, open]);

  return position;
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
 * Callers own the hover state because the gauge sits inside the model trigger button.
 */
export function UsageTooltip({
  anchorRef,
  open,
  label,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  label: string | null;
}) {
  const position = useTooltipPosition(anchorRef, open);
  if (!open || !label || !position || typeof document === "undefined") return null;

  return createPortal(
    <div role="tooltip" className={usageTooltipClasses} style={{ left: position.left, top: position.top }}>
      {label}
    </div>,
    document.body,
  );
}
