// @summary Shared helpers for chat scroll state calculations

export const CHAT_NEAR_BOTTOM_THRESHOLD_PX = 120;

interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearBottom(metrics: ScrollMetrics, thresholdPx: number = CHAT_NEAR_BOTTOM_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}
