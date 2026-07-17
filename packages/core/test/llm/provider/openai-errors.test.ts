// @summary Tests for OpenAI and ChatGPT error classification retryability
import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import type { APIError } from "openai/core/error.mjs";
import { toSerializableError } from "../../../src/agent/util/errors";
import { isNetworkError } from "../../../src/llm/errors";
import { classifyOpenAIError } from "../../../src/llm/provider/openai";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE } from "../../../src/llm/types";

function makeOpenAIAPIError(status: number, message: string, headers?: Record<string, string>): APIError {
  const sdkHeaders = new Headers(headers);
  return new OpenAI.APIError(status, { message }, message, sdkHeaders);
}

function makeOpenAIAPIErrorWithCode(status: number | undefined, code: string, message: string): APIError {
  return new OpenAI.APIError(status, { code, message }, message, new Headers());
}

function makeForeignOpenAIAPIError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    headers: new Headers(),
    error: { message },
    code: undefined,
    param: undefined,
    type: undefined,
    requestID: undefined,
  });
}

describe("classifyOpenAIError", () => {
  test("classifies 429 as non-retryable rate_limit", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(429, "Rate limit exceeded"));

    expect(result.errorType).toBe("rate_limit");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(429);
  });

  test("classifies SDK errors created by another module instance", () => {
    const result = classifyOpenAIError(makeForeignOpenAIAPIError(429, "Rate limit exceeded"));

    expect(result.errorType).toBe("rate_limit");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBe(429);
  });

  test("classifies 401 as auth", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(401, "Invalid API key"));

    expect(result.errorType).toBe("auth");
    expect(result.reason).toBe("credentials_rejected");
    expect(result.isRetryable).toBe(false);
  });

  test("classifies context overflow", () => {
    const result = classifyOpenAIError(makeOpenAIAPIError(400, "This model's maximum context length is 128000"));

    expect(result.errorType).toBe("context_overflow");
    expect(result.message).toBe(CONTEXT_OVERFLOW_ERROR_MESSAGE);
    expect(result.reason).toBe("context_window_exceeded");
    expect(result.message).not.toMatch(/menu|modal|top-left|screen|\/provider/i);
    expect(result.isRetryable).toBe(false);
  });

  test("preserves upstream code independently from the stable reason", () => {
    const result = classifyOpenAIError(makeOpenAIAPIErrorWithCode(401, "invalid_api_key", "Invalid API key"));
    const serialized = toSerializableError(result);

    expect(serialized.code).toBe("invalid_api_key");
    expect(serialized.providerErrorReason).toBe("credentials_rejected");
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

  test("classifies OpenAI retry guidance as retryable server_error", () => {
    const result = classifyOpenAIError(
      new Error("You can retry your request. Please include the request ID 95226c1b-7063-4299-9d94-8d091ed07716."),
    );

    expect(result.errorType).toBe("server_error");
    expect(result.isRetryable).toBe(true);
  });

  test("does not classify OpenAI processing errors without retry guidance as retryable", () => {
    const result = classifyOpenAIError(new Error("An error occurred while processing your request."));

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
  });

  test("classifies OpenAI SDK server_error code without status as retryable server_error", () => {
    const result = classifyOpenAIError(
      makeOpenAIAPIErrorWithCode(
        undefined,
        "server_error",
        "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4b3a6d59-2858-47a4-8ead-663f7327eaaf in your message.",
      ),
    );

    expect(result.errorType).toBe("server_error");
    expect(result.isRetryable).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  test("does not classify OpenAI SDK server_error code alone as retryable", () => {
    const result = classifyOpenAIError(
      makeOpenAIAPIErrorWithCode(undefined, "server_error", "The request could not be completed."),
    );

    expect(result.errorType).toBe("unknown");
    expect(result.isRetryable).toBe(false);
    expect(result.statusCode).toBeUndefined();
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

  test("classifies unexpected socket closures as network retryable candidates", () => {
    expect(isNetworkError(new Error("The socket connection was closed unexpectedly."))).toBe(true);
  });

  test("does not classify user aborts as network retryable candidates", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");

    expect(isNetworkError(error)).toBe(false);
  });
});
