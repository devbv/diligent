// @summary Tests runtime-owned provider authentication presentation state

import { describe, expect, it } from "bun:test";
import { ProviderManager } from "@diligent/core/provider-contract";
import { ProviderAuthPresenter } from "../../src/auth/provider-auth-presenter";

describe("ProviderAuthPresenter", () => {
  it("masks API keys outside core", () => {
    const providerManager = new ProviderManager({});
    const presenter = new ProviderAuthPresenter(providerManager);
    providerManager.setApiKey("openai", "sk-openai-secret");

    expect(presenter.getStatus("openai")).toEqual({
      configured: true,
      maskedKey: "sk-open...",
      oauthConnected: undefined,
    });
  });

  it("uses registered external-auth presentation only while auth is configured", () => {
    let configured = true;
    const providerManager = new ProviderManager({});
    const presenter = new ProviderAuthPresenter(providerManager);
    providerManager.setExternalAuth("chatgpt", {
      isConfigured: () => configured,
      getStream: () => {
        throw new Error("unused");
      },
    });
    presenter.setExternalAuth("chatgpt", { maskedKey: "ChatGPT OAuth", oauth: true });

    expect(presenter.getStatus("chatgpt")).toEqual({
      configured: true,
      maskedKey: "ChatGPT OAuth",
      oauthConnected: true,
    });

    configured = false;
    expect(presenter.getStatus("chatgpt")).toEqual({
      configured: false,
      maskedKey: undefined,
      oauthConnected: false,
    });
  });
});
