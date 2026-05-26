// @summary Tests for OpenAI and ChatGPT error classification retryability
import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { isNetworkError } from "../../../src/llm/errors";
import { classifyOpenAIError } from "../../../src/llm/provider/openai";

function makeOpenAIAPIError(status: number, message: string, headers?: Record<string, string>): OpenAI.APIError {
  const sdkHeaders = new Headers(headers);
  return new OpenAI.APIError(status, { message }, message, sdkHeaders);
}

describe("classifyOpenAIError", () => {
  test("classifies 429 as non-retryable rate_limit", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(429, "Rate limit exceeded"));

    expect(result.errorType).toBe("rate_limit");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(429);
  });

  test("classifies 401 as auth", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(401, "Invalid API key"));

    expect(result.errorType).toBe("auth");
    expect(result.isRetryable).toBe(false);
  });

  test("classifies context overflow", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(400, "This model's maximum context length is 128000"));

    expect(result.errorType).toBe("context_overflow");
    expect(result.isRetryable).toBe(false);
  });

  test("classifies network errors", () => {
    const result = classifyOpenAIError(new Error("fetch failed: ECONNREFUSED"));

    expect(result.errorType).toBe("network");
    expect(result.isRetryable).toBe(true);
  });

  test("parses retry-after header on 429", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(429, "Rate limit exceeded", { "retry-after": "3" }));

    expect(result.retryAfterMs).toBe(3000);
  });

  test("classifies overloaded text as retryable server_error", () => {
    const result = classifyOpenAIError(new Error("ChatGPT is temporarily overloaded. Please try again."));

    expect(result.errorType).toBe("server_error");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies transient OpenAI processing errors as retryable server_error", () => {
    const result = classifyOpenAIError(
      new Error(
        "An error occurred while processing your request. You can retry your request. Please include the request ID 95226c1b-7063-4299-9d94-8d091ed07716.",
      ),
    );

    expect(result.errorType).toBe("server_error");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies 500 as retryable server_error", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(500, "Internal server error"));

    expect(result.errorType).toBe("server_error");
    expect(result.isRetryable).toBe(true);
  });

  test("classifies unknown errors", () => {
    const result = classifyOpenAIError(new Error("Something unexpected"));

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
  });
});

describe("isNetworkError", () => {
  test("classifies timed out errors as network retryable candidates", () => {
    expect(isNetworkError(new Error("The operation timed out."))).toBe(true);
  });

  test("does not classify user aborts as network retryable candidates", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");

    expect(isNetworkError(error)).toBe(false);
  });
});
