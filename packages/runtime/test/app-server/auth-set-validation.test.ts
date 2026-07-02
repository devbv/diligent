// @summary handleAuthSet must verify the key before persisting it
import { describe, expect, it, mock } from "bun:test";
import type { ProviderManager } from "@diligent/core/llm/provider-manager";
import { handleAuthSet } from "../../src/app-server/config-handlers";

describe("handleAuthSet key validation", () => {
  it("does not persist or emit when the key fails validation", async () => {
    const setApiKey = mock(() => {});
    const emit = mock(async () => {});
    const fakeManager = {
      validateApiKey: async () => {
        throw new Error("Invalid API key for Anthropic. Please check the key and try again.");
      },
      setApiKey,
    } as unknown as ProviderManager;

    await expect(handleAuthSet(fakeManager, { provider: "anthropic", apiKey: "bad-key" }, emit)).rejects.toThrow(
      "Invalid API key for Anthropic",
    );

    expect(setApiKey).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
