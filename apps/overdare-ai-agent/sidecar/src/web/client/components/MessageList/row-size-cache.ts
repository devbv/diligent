// @summary Measured row size cache for stabilizing Virtuoso height estimates

import { ROW_SIZE_CACHE_LIMIT } from "./constants";
import type { VirtualMessageRow } from "./types";

const measuredRowSizes = new Map<string, number>();

export function getRowSizeCacheKey(transcriptKey: string, row: VirtualMessageRow): string {
  return `${transcriptKey}:${row.key}:${row.estimatedSize}`;
}

export function getMeasuredRowSize(cacheKey: string): number | undefined {
  return measuredRowSizes.get(cacheKey);
}

export function rememberMeasuredRowSize(cacheKey: string, size: number): void {
  if (!Number.isFinite(size) || size <= 0) return;
  measuredRowSizes.delete(cacheKey);
  measuredRowSizes.set(cacheKey, size);
  if (measuredRowSizes.size <= ROW_SIZE_CACHE_LIMIT) return;

  const oldestKey = measuredRowSizes.keys().next().value;
  if (oldestKey !== undefined) {
    measuredRowSizes.delete(oldestKey);
  }
}
