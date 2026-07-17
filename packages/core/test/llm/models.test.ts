// @summary Tests provider-scoped model catalog identity and strict resolution
import { describe, expect, it } from "bun:test";
import {
  findModel,
  getModelInfoList,
  listModels,
  MODEL_CARD_SCHEMA_VERSION,
  resolveModel,
  sameModelRef,
  UnknownModelError,
} from "../../src/llm/models";

describe("provider-scoped model catalog", () => {
  it("permits the same provider-native ID under OpenAI and ChatGPT", () => {
    const openai = resolveModel({ provider: "openai", modelId: "gpt-5.5" });
    const chatgpt = resolveModel({ provider: "chatgpt", modelId: "gpt-5.5" });
    expect(openai.modelId).toBe(chatgpt.modelId);
    expect(openai.provider).not.toBe(chatgpt.provider);
    expect(openai.contextWindow).toBe(1_000_000);
    expect(chatgpt.contextWindow).toBe(300_000);
  });

  it("resolves aliases only inside the explicit provider", () => {
    expect(resolveModel({ provider: "openai", modelId: "gpt-5.6" }).modelId).toBe("gpt-5.6-sol");
    expect(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6" }).modelId).toBe("gpt-5.6-sol");
  });

  it("rejects unknown cards without inferring capabilities", () => {
    const ref = { provider: "openai", modelId: "gpt-unknown" } as const;
    expect(findModel(ref)).toBeUndefined();
    expect(() => resolveModel(ref)).toThrow(UnknownModelError);
    try {
      resolveModel(ref);
    } catch (error) {
      expect((error as UnknownModelError).ref).toEqual(ref);
    }
  });

  it("compares both identity fields", () => {
    expect(sameModelRef({ provider: "openai", modelId: "gpt-5.5" }, { provider: "openai", modelId: "gpt-5.5" })).toBe(
      true,
    );
    expect(sameModelRef({ provider: "openai", modelId: "gpt-5.5" }, { provider: "chatgpt", modelId: "gpt-5.5" })).toBe(
      false,
    );
  });

  it("lists immutable-looking versioned cards and protocol model info", () => {
    expect(listModels("vertex")).toHaveLength(1);
    for (const card of listModels()) expect(card.schemaVersion).toBe(MODEL_CARD_SCHEMA_VERSION);
    expect(getModelInfoList().every((model) => model.modelId.length > 0 && model.provider.length > 0)).toBe(true);
  });
});
