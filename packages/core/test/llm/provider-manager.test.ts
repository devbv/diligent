import { describe, expect, it } from "bun:test";
import { ProviderManager } from "../../src/llm/provider-manager";
import { type Model, ProviderError, type StreamContext, type StreamOptions } from "../../src/llm/types";

describe("ProviderManager auth errors", () => {
  it("throws an auth-typed ProviderError when no credentials are configured", () => {
    const manager = new ProviderManager({});
    const stream = manager.createProxyStream();
    const model = { provider: "anthropic" } as Model;

    // The throw happens synchronously before any stream is built, so context/options are unused.
    try {
      stream(model, {} as StreamContext, {} as StreamOptions);
      throw new Error("expected createProxyStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).errorType).toBe("auth");
      expect((err as ProviderError).reason).toBe("credentials_missing");
      expect((err as ProviderError).message).toBe("No authentication is configured for anthropic.");
      expect((err as ProviderError).message).not.toContain("/provider");
    }
  });
});
