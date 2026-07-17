// @summary handleAuthSet must verify the key before persisting it
import { describe, expect, it, mock } from "bun:test";
import type { ProviderManager } from "@diligent/core/provider-contract";
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "@diligent/core/provider-contract";
import { handleAuthSet } from "../../src/app-server/config-handlers";

describe("handleAuthSet key validation", () => {
  it("does not persist or emit when the key fails validation", async () => {
    const setApiKey = mock(() => {});
    const emit = mock(async () => {});
    const fakeManager = {
      validateApiKey: async () => {
        throw new ProviderError("upstream rejected credentials", {
          errorType: ProviderErrorType.Auth,
          reason: ProviderErrorReason.CredentialsRejected,
          isRetryable: false,
          statusCode: 401,
        });
      },
      setApiKey,
    } as unknown as ProviderManager;

    await expect(handleAuthSet(fakeManager, { provider: "anthropic", apiKey: "bad-key" }, emit)).rejects.toThrow(
      "Invalid API key for Anthropic",
    );

    expect(setApiKey).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("adds provider display metadata to the runtime-owned validation message", async () => {
    const fakeManager = {
      validateApiKey: async () => {
        throw new Error("connection reset");
      },
      setApiKey: () => {},
    } as unknown as ProviderManager;

    await expect(handleAuthSet(fakeManager, { provider: "gemini", apiKey: "key" }, async () => {})).rejects.toThrow(
      "Could not verify the Gemini API key: connection reset",
    );
  });
});
