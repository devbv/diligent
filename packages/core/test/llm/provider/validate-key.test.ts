// @summary z.ai key validation hits the chat endpoint and maps auth failures to a friendly error
import { afterEach, describe, expect, it } from "bun:test";
import { validateProviderApiKey } from "../../../src/llm/provider/validate-key";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateProviderApiKey — z.ai", () => {
  it("throws 'Invalid API key' on a 401 from the chat endpoint", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    await expect(validateProviderApiKey("zai-coding-plan", "bad-key")).rejects.toThrow("Invalid API key for z.ai");
    expect(calledUrl).toContain("/chat/completions");
  });

  it("resolves when the chat endpoint returns ok", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    await expect(validateProviderApiKey("zai-coding-plan", "good-key")).resolves.toBeUndefined();
  });
});
