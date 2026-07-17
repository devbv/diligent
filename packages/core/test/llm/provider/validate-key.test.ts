// @summary z.ai key validation hits the chat endpoint and returns structured provider failures
import { afterEach, describe, expect, it } from "bun:test";
import { validateProviderApiKey } from "../../../src/llm/provider/validate-key";
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateProviderApiKey — z.ai", () => {
  it("classifies a 401 without adding user-facing provider copy", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

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

  it("resolves when the chat endpoint returns ok", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    await expect(validateProviderApiKey("zai-coding-plan", "good-key")).resolves.toBeUndefined();
  });
});
