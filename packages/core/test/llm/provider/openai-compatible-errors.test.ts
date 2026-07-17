// @summary Tests shared HTTP error classification in OpenAI-compatible providers
import { describe, expect, test } from "bun:test";
import { classifyVertexError } from "../../../src/llm/provider/vertex";
import { classifyZaiCodingPlanError } from "../../../src/llm/provider/zai-coding-plan";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

const classifiers = [
  ["Vertex", classifyVertexError],
  ["z.ai Coding Plan", classifyZaiCodingPlanError],
] as const;

for (const [provider, classify] of classifiers) {
  describe(`${provider} error classification`, () => {
    test("uses the shared rate-limit, authentication, and server rules", () => {
      expect(classify({ status: 429, message: "slow down" })).toMatchObject({
        errorType: ProviderErrorType.RateLimit,
        isRetryable: false,
      });
      expect(classify({ status: 401, message: "bad credentials" })).toMatchObject({
        errorType: ProviderErrorType.Auth,
        reason: ProviderErrorReason.CredentialsRejected,
        isRetryable: false,
      });
      expect(classify({ status: 503, message: "unavailable" })).toMatchObject({
        errorType: ProviderErrorType.ServerError,
        isRetryable: true,
      });
    });

    test("keeps context overflow as a provider-specific rule", () => {
      expect(classify({ status: 400, message: "maximum context length exceeded" })).toMatchObject({
        message: CONTEXT_OVERFLOW_ERROR_MESSAGE,
        errorType: ProviderErrorType.ContextOverflow,
        reason: ProviderErrorReason.ContextWindowExceeded,
        isRetryable: false,
      });
    });
  });
}
