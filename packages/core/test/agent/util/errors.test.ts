// @summary Tests complete serialization of provider diagnostics at the Agent event boundary

import { describe, expect, test } from "bun:test";
import { toSerializableError } from "../../../src/agent/util/errors";
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

describe("toSerializableError", () => {
  test("maps every provider diagnostic field", () => {
    const cause = Object.assign(new Error("upstream"), { code: "rate_limit_exceeded" });
    const error = new ProviderError(
      "slow down",
      ProviderErrorType.RateLimit,
      true,
      2_500,
      429,
      cause,
      ProviderErrorReason.UsageLimitReached,
    );

    expect(toSerializableError(error)).toMatchObject({
      message: "slow down",
      name: "ProviderError",
      code: "rate_limit_exceeded",
      providerErrorType: ProviderErrorType.RateLimit,
      providerErrorReason: ProviderErrorReason.UsageLimitReached,
      isRetryable: true,
      retryAfterMs: 2_500,
      statusCode: 429,
    });
  });
});
