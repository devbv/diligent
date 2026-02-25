import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../src/provider/anthropic";
import { ProviderError } from "../src/provider/types";

function makeAPIError(status: number, message: string, headers?: Record<string, string>): Anthropic.APIError {
  return new Anthropic.APIError(status, { message }, message, headers as any);
}

describe("classifyAnthropicError", () => {
  test("classifies 429 as rate_limit (retryable)", () => {
    const err = makeAPIError(429, "Rate limit exceeded");
    const result = classifyAnthropicError(err);

    expect(result).toBeInstanceOf(ProviderError);
    expect(result.errorType).toBe("rate_limit");
    expect(result.isRetryable).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  test("429 parses retry-after-ms header", () => {
    const err = makeAPIError(429, "Rate limit", { "retry-after-ms": "5000" });
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("rate_limit");
    expect(result.retryAfterMs).toBe(5000);
  });

  test("429 parses retry-after header (seconds)", () => {
    const err = makeAPIError(429, "Rate limit", { "retry-after": "3" });
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("rate_limit");
    expect(result.retryAfterMs).toBe(3000);
  });

  test("429 with no retry-after header returns undefined retryAfterMs", () => {
    const err = makeAPIError(429, "Rate limit");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("rate_limit");
    expect(result.retryAfterMs).toBeUndefined();
  });

  test("classifies 529 as overloaded (retryable)", () => {
    const err = makeAPIError(529, "Overloaded");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("overloaded");
    expect(result.isRetryable).toBe(true);
    expect(result.statusCode).toBe(529);
  });

  test("classifies 400 with 'context length' as context_overflow (not retryable)", () => {
    const err = makeAPIError(400, "prompt is too long: context length exceeded");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("context_overflow");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  test("classifies 400 without 'context length' as unknown", () => {
    const err = makeAPIError(400, "invalid request body");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
  });

  test("classifies 401 as auth (not retryable)", () => {
    const err = makeAPIError(401, "Invalid API key");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("auth");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  test("classifies 403 as auth (not retryable)", () => {
    const err = makeAPIError(403, "Permission denied");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("auth");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  test("classifies other API errors as unknown", () => {
    const err = makeAPIError(500, "Internal server error");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(500);
  });

  test("classifies ECONNREFUSED as network (retryable)", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("network");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies ECONNRESET as network (retryable)", () => {
    const err = new Error("socket hang up ECONNRESET");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("network");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies ETIMEDOUT as network (retryable)", () => {
    const err = new Error("connect ETIMEDOUT");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("network");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies 'fetch failed' as network (retryable)", () => {
    const err = new TypeError("fetch failed");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("network");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies 'network' error message as network (retryable)", () => {
    const err = new Error("network error occurred");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("network");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies non-Error thrown values as unknown", () => {
    const result = classifyAnthropicError("string error");

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
    expect(result.message).toBe("string error");
  });

  test("classifies generic Error as unknown (not retryable)", () => {
    const err = new Error("something unexpected");
    const result = classifyAnthropicError(err);

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
    expect(result.cause).toBe(err);
  });

  test("preserves original error as cause for APIError", () => {
    const err = makeAPIError(429, "Rate limit");
    const result = classifyAnthropicError(err);

    expect(result.cause).toBe(err);
  });
});
