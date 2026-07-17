// @summary Tests for usage cost calculation across uncached, cache-read, and cache-write tokens

import { expect, test } from "bun:test";
import { resolveModel } from "@diligent/core/model-registry";
import { calculateUsageCost } from "../src/cost";

test("prices GPT-5.6 cache writes separately from input and cache reads", () => {
  const cost = calculateUsageCost(resolveModel("gpt-5.6-sol"), {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });

  expect(cost).toBe(41.75);
});
