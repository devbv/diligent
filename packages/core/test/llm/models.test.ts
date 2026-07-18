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
  it("resolves aliases only inside the explicit provider", () => {
    const model = listModels().find((candidate) => candidate.aliases && candidate.aliases.length > 0);
    expect(model).toBeDefined();
    if (!model) throw new Error("Expected at least one aliased model card");
    const alias = model.aliases?.[0];
    expect(alias).toBeDefined();
    if (!alias) throw new Error("Expected the selected model card to have an alias");
    expect(resolveModel({ provider: model.provider, modelId: alias })).toBe(model);
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
    expect(
      sameModelRef({ provider: "openai", modelId: "shared-model" }, { provider: "openai", modelId: "shared-model" }),
    ).toBe(true);
    expect(
      sameModelRef({ provider: "openai", modelId: "shared-model" }, { provider: "chatgpt", modelId: "shared-model" }),
    ).toBe(false);
  });

  it("maps catalog cards to protocol model info", () => {
    for (const card of listModels()) expect(card.schemaVersion).toBe(MODEL_CARD_SCHEMA_VERSION);
    expect(getModelInfoList().every((model) => model.modelId.length > 0 && model.provider.length > 0)).toBe(true);
  });
});
