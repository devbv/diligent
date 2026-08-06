// @summary 12px context-usage pie with a hover tooltip that replaces the composer's inline token counter

import { type RefObject, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { usageTooltipClasses } from "./ui-styles";

const GAUGE_TRACK_COLOR = "#565F69";
const GAUGE_FILL_COLOR = "#40BF80";
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

/** Pie-style fill matching the design's quarter-masked progress token. */
export function UsageGauge({ ratio, className }: { ratio: number; className?: string }) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  return (
    <span
      data-icon="usage-gauge"
      data-usage-percent={Math.round(pct)}
      aria-hidden="true"
      className={cn("block h-3 w-3 shrink-0 rounded-full", className)}
      style={{
        background: `conic-gradient(${GAUGE_FILL_COLOR} 0 ${pct}%, ${GAUGE_TRACK_COLOR} ${pct}% 100%)`,
      }}
    />
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
