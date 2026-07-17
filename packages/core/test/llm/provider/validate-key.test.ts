// @summary API-key validation request and error-classification contracts
import { afterEach, describe, expect, it } from "bun:test";
import { validateProviderApiKey } from "../../../src/llm/provider/validate-key";
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateProviderApiKey", () => {
  it.each([
    {
      provider: "anthropic" as const,
      expectedUrl: "https://api.anthropic.com/v1/models?limit=1",
      expectedHeader: ["x-api-key", "test-key"],
    },
    {
      provider: "openai" as const,
      expectedUrl: "https://api.openai.com/v1/models",
      expectedHeader: ["Authorization", "Bearer test-key"],
    },
    {
      provider: "gemini" as const,
      expectedUrl: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      expectedHeader: ["x-goog-api-key", "test-key"],
    },
  ])("uses the cheap authenticated models request for $provider", async ({ provider, expectedUrl, expectedHeader }) => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await validateProviderApiKey(provider, "test-key");

    expect(request?.url).toBe(expectedUrl);
    expect(new Headers(request?.init?.headers).get(expectedHeader[0])).toBe(expectedHeader[1]);
    expect(request?.init?.method).toBeUndefined();
  });

  it("classifies a z.ai 401 without adding user-facing provider copy", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const error = await validateProviderApiKey("zai-coding-plan", "bad-key").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      errorType: ProviderErrorType.Auth,
      reason: ProviderErrorReason.CredentialsRejected,
      isRetryable: false,
      statusCode: 401,
    });
    expect((error as Error).message).toBe("unauthorized");
    expect((error as Error).message).not.toContain("Please check");
    expect(calledUrl).toContain("/chat/completions");
  });

  it("skips providers whose authentication is not an API key", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await validateProviderApiKey("vertex", "unused");
    await validateProviderApiKey("chatgpt", "unused");
    expect(called).toBe(false);
  });
});
