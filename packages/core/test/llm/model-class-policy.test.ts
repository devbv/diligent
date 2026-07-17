// @summary Tests provider-scoped pro, general, and lite model routing policy
import { describe, expect, it } from "bun:test";
import {
  getDefaultEffortForClass,
  getModelClass,
  MODEL_CLASSES,
  resolveModelForClass,
} from "../../src/llm/model-class-policy";
import { findModel, resolveModel } from "../../src/llm/models";

describe("model class policy", () => {
  it("references existing cards with provider-scoped membership", () => {
    for (const modelClass of MODEL_CLASSES) {
      for (const [provider, modelId] of Object.entries(modelClass.defaultModelIds)) {
        expect(findModel({ provider: provider as never, modelId: modelId! })).toBeDefined();
      }
      for (const [provider, modelIds] of Object.entries(modelClass.additionalModelIds ?? {})) {
        for (const modelId of modelIds ?? []) expect(findModel({ provider: provider as never, modelId })).toBeDefined();
      }
    }
  });

  it("routes independently inside OpenAI and ChatGPT despite shared IDs", () => {
    for (const provider of ["openai", "chatgpt"] as const) {
      const current = resolveModel({ provider, modelId: "gpt-5.6-terra" });
      expect(resolveModelForClass(current, "pro")).toMatchObject({ provider, modelId: "gpt-5.5" });
      expect(resolveModelForClass(current, "lite")).toMatchObject({ provider, modelId: "gpt-5.6-luna" });
    }
  });

  it("uses full references for membership", () => {
    expect(getModelClass(resolveModel({ provider: "openai", modelId: "gpt-5.6-sol" }))).toBe("pro");
    expect(getModelClass(resolveModel({ provider: "chatgpt", modelId: "gpt-5.6-terra" }))).toBe("general");
  });

  it("keeps class effort defaults", () => {
    expect(getDefaultEffortForClass("pro")).toBe("high");
    expect(getDefaultEffortForClass("general")).toBe("medium");
    expect(getDefaultEffortForClass("lite")).toBe("low");
  });
});
