// @summary Tests for usage cost calculation across uncached, cache-read, and cache-write tokens

import { expect, test } from "bun:test";
import type { Model } from "@diligent/core/provider-contract";
import { calculateUsageCost } from "../src/cost";

test("prices cache writes separately from input, output, and cache reads", () => {
  const model: Model = {
    modelId: "synthetic-cost-model",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    supportsThinking: false,
    inputCostPer1M: 2,
    outputCostPer1M: 3,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 4,
  };
  const cost = calculateUsageCost(model, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });

  expect(cost).toBe(9.5);
});
