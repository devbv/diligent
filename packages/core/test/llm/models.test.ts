// @summary Tests provider-scoped model catalog identity and strict resolution
import { describe, expect, it } from "bun:test";
import { getModelClass, MODEL_CLASSES } from "../../src/llm/model-class-policy";
import {
  findModel,
  getModelInfoList,
  listModels,
  MODEL_CARD_SCHEMA_VERSION,
  resolveModel,
  sameModelRef,
  UnknownModelError,
} from "../../src/llm/models";
import { getDefaultModelRef } from "../../src/llm/provider-model-policy";

describe("provider-scoped model catalog", () => {
  it("registers Claude Opus 5 without assigning it a model class", () => {
    const model = resolveModel({ provider: "anthropic", modelId: "claude-opus-5" });

    expect(model).toMatchObject({
      display: "Claude Opus 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputCostPer1M: 5,
      outputCostPer1M: 25,
      cacheReadCostPer1M: 0.5,
      cacheWriteCostPer1M: 6.25,
      supportsThinking: true,
      supportsVision: true,
      supportsAdaptiveThinking: true,
      supportsXhighEffort: true,
      aliases: ["opus-5"],
    });

    const explicitlyClassifiedModelIds = MODEL_CLASSES.flatMap(({ defaultModelIds, additionalModelIds }) => [
      ...Object.values(defaultModelIds),
      ...Object.values(additionalModelIds ?? {}).flat(),
    ]);
    expect(explicitlyClassifiedModelIds).not.toContain(model.modelId);
    expect(getModelClass(model)).toBe("general");
  });

  it("exposes only the two latest Gemini models and defaults to Gemini 3.6 Flash", () => {
    expect(listModels("gemini").map((model) => model.modelId)).toEqual(["gemini-3.6-flash", "gemini-3.5-flash-lite"]);
    expect(getDefaultModelRef("gemini")).toEqual({ provider: "gemini", modelId: "gemini-3.6-flash" });
    expect(resolveModel({ provider: "gemini", modelId: "gemini" }).modelId).toBe("gemini-3.6-flash");

    for (const removedModelId of ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite"]) {
      expect(findModel({ provider: "gemini", modelId: removedModelId })).toBeUndefined();
    }
  });

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
