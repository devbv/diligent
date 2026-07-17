// @summary Tests the canonical Agent retry defaults
import { expect, test } from "bun:test";
import { DEFAULT_LLM_RETRY_CONFIG } from "../../src/agent/types";

test("defines the canonical LLM retry defaults", () => {
  expect(DEFAULT_LLM_RETRY_CONFIG).toEqual({
    maxRetries: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
  });
});
