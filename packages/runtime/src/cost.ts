// @summary Runtime-only usage cost helper for UI and historical session totals

import type { Usage } from "@diligent/core/message-contract";
import type { Model } from "@diligent/core/provider-contract";

export function calculateUsageCost(model: Model, usage: Usage): number {
  const inputCost = (usage.inputTokens / 1_000_000) * (model.inputCostPer1M ?? 0);
  const outputCost = (usage.outputTokens / 1_000_000) * (model.outputCostPer1M ?? 0);
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * (model.cacheReadCostPer1M ?? 0);
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * (model.cacheWriteCostPer1M ?? 0);
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
