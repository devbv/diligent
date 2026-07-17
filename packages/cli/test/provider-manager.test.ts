// @summary Tests for provider manager configuration and model handling
import { describe, expect, test } from "bun:test";
import { createChatGPTOAuthBinding, ProviderAuthPresenter } from "@diligent/runtime";
import { getDefaultModelRef, PROVIDER_MODEL_POLICIES, PROVIDER_NAMES, ProviderManager } from "../src/provider-manager";

describe("ProviderManager", () => {
  test("config does not provide API keys (auth-only)", () => {
    const pm = new ProviderManager({
      provider: { anthropic: { apiKey: "sk-ant-test" } },
    });
    // apiKey in config is ignored — keys come from auth.json via setApiKey
    expect(pm.hasKeyFor("anthropic")).toBe(false);
  });

  test("runtime presenter masks configured API keys", () => {
    const pm = new ProviderManager({});
    const presenter = new ProviderAuthPresenter(pm);
    pm.setApiKey("anthropic", "sk-ant-1234567890");
    expect(presenter.getStatus("anthropic").maskedKey).toBe("sk-ant-...");
  });

  test("ProviderManager does not expose presentation methods", () => {
    const pm = new ProviderManager({});
    expect("getMaskedKey" in pm).toBe(false);
    expect("hasOAuthFor" in pm).toBe(false);
  });

  test("PROVIDER_NAMES constant contains all providers", () => {
    expect(PROVIDER_NAMES).toEqual(["anthropic", "openai", "chatgpt", "gemini", "vertex", "zai-coding-plan"]);
  });

  test("provider model policy has entries for all providers", () => {
    for (const provider of PROVIDER_NAMES) {
      expect(PROVIDER_MODEL_POLICIES[provider]).toBeDefined();
    }
  });

  test("uses the current flagship models as provider defaults", () => {
    expect(getDefaultModelRef("anthropic").modelId).toBe("claude-opus-4-8");
    expect(getDefaultModelRef("openai").modelId).toBe("gpt-5.6-sol");
    expect(getDefaultModelRef("chatgpt")).toEqual({ provider: "chatgpt", modelId: "gpt-5.6-sol" });
  });

  test("oauth marks chatgpt as configured", () => {
    const pm = new ProviderManager({});
    const presenter = new ProviderAuthPresenter(pm);
    const binding = createChatGPTOAuthBinding({
      initialTokens: {
        access_token: "at",
        refresh_token: "rt",
        id_token: "id",
        expires_at: Number.MAX_SAFE_INTEGER,
      },
    });
    pm.setExternalAuth("chatgpt", binding.auth);
    presenter.setExternalAuth("chatgpt", binding.presentation);
    expect(pm.hasKeyFor("chatgpt")).toBe(true);
    expect(presenter.getStatus("chatgpt")).toEqual({
      configured: true,
      maskedKey: "ChatGPT OAuth",
      oauthConnected: true,
    });
  });
});
