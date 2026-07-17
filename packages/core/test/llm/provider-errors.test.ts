// @summary Tests shared provider HTTP status predicates and baseline error classification
import { describe, expect, test } from "bun:test";
import {
  classifyProviderHttpError,
  isAuthenticationStatus,
  isRateLimitStatus,
  isServerErrorStatus,
} from "../../src/llm/provider-errors";
import { ProviderErrorReason, ProviderErrorType } from "../../src/llm/types";

describe("provider HTTP status predicates", () => {
  test("recognizes authentication statuses", () => {
    expect(isAuthenticationStatus(401)).toBe(true);
    expect(isAuthenticationStatus(403)).toBe(true);
    expect(isAuthenticationStatus(400)).toBe(false);
    expect(isAuthenticationStatus(undefined)).toBe(false);
  });

  test("recognizes rate-limit and server-error statuses", () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(503)).toBe(false);
    expect(isServerErrorStatus(500)).toBe(true);
    expect(isServerErrorStatus(599)).toBe(true);
    expect(isServerErrorStatus(499)).toBe(false);
    expect(isServerErrorStatus(undefined)).toBe(false);
  });
});

describe("classifyProviderHttpError", () => {
  test("classifies shared HTTP failures with stable provider constants", () => {
    const cause = new Error("upstream rejected credentials");
    const auth = classifyProviderHttpError({ message: cause.message, status: 401, cause });
    const rateLimit = classifyProviderHttpError({ message: "slow down", status: 429, retryAfterMs: 2_000 });
    const server = classifyProviderHttpError({ message: "unavailable", status: 503 });

    expect(auth).toMatchObject({
      errorType: ProviderErrorType.Auth,
      reason: ProviderErrorReason.CredentialsRejected,
      isRetryable: false,
      statusCode: 401,
      cause,
    });
    expect(rateLimit).toMatchObject({
      errorType: ProviderErrorType.RateLimit,
      isRetryable: false,
      retryAfterMs: 2_000,
      statusCode: 429,
    });
    expect(server).toMatchObject({
      errorType: ProviderErrorType.ServerError,
      isRetryable: true,
      statusCode: 503,
    });
  });

  test("leaves provider-specific statuses unclassified", () => {
    expect(classifyProviderHttpError({ message: "bad request", status: 400 })).toBeUndefined();
    expect(classifyProviderHttpError({ message: "no status", status: undefined })).toBeUndefined();
  });
});
