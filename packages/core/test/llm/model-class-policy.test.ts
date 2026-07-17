// @summary Tests provider-specific pro, general, and lite model routing policy
import { describe, expect, it } from "bun:test";
import {
  getDefaultEffortForClass,
  getModelClass,
  MODEL_CLASSES,
  resolveModelForClass,
} from "../../src/llm/model-class-policy";
import { DEFAULT_ANTHROPIC_MODEL_ID, MODEL_CARDS, resolveModel } from "../../src/llm/models";
import type { Model } from "../../src/llm/types";

describe("model class policy", () => {
  it("stores model classes outside model cards", () => {
    for (const modelClass of MODEL_CLASSES) {
      for (const [provider, modelId] of Object.entries(modelClass.defaultModels)) {
        expect(MODEL_CARDS.some((card) => card.id === modelId && card.provider === provider)).toBe(true);
      }
      for (const modelId of modelClass.additionalModels ?? []) {
        expect(MODEL_CARDS.some((card) => card.id === modelId)).toBe(true);
      }
    }
  });

  it("defines exactly the pro, general, and lite classes", () => {
    expect(MODEL_CLASSES).toEqual([
      {
        id: "pro",
        defaultEffort: "high",
        defaultModels: {
          anthropic: "claude-opus-4-8",
          gemini: "gemini-3.1-pro-preview",
          "zai-coding-plan": "glm-5.2",
          openai: "gpt-5.5",
          chatgpt: "chatgpt-5.5",
        },
        additionalModels: ["gpt-5.6-sol", "chatgpt-5.6-sol"],
      },
      {
        id: "general",
        defaultEffort: "medium",
        defaultModels: {
          anthropic: DEFAULT_ANTHROPIC_MODEL_ID,
          gemini: "gemini-3.5-flash",
          vertex: "vertex-gemma-4-26b-it",
          "zai-coding-plan": "glm-5.1",
          openai: "gpt-5.4",
          chatgpt: "chatgpt-5.4",
        },
        additionalModels: ["claude-sonnet-5", "gpt-5.6-terra", "chatgpt-5.6-terra"],
      },
      {
        id: "lite",
        defaultEffort: "low",
        defaultModels: {
          anthropic: "claude-haiku-4-5-20251001",
          gemini: "gemini-3.1-flash-lite",
          openai: "gpt-5.4-mini",
          chatgpt: "chatgpt-5.4-mini",
        },
        additionalModels: ["gpt-5.6-luna", "chatgpt-5.6-luna"],
      },
    ]);
  });

  it("resolves each supported class within the current provider", () => {
    const cases = [
      ["claude-fable-5", "pro", "claude-opus-4-8"],
      [DEFAULT_ANTHROPIC_MODEL_ID, "lite", "claude-haiku-4-5-20251001"],
      ["gpt-5.3-codex", "pro", "gpt-5.5"],
      ["gpt-5.3-codex", "general", "gpt-5.4"],
      ["gpt-5.3-codex", "lite", "gpt-5.4-mini"],
      ["gemini-3.5-flash", "pro", "gemini-3.1-pro-preview"],
      ["gemini-3.5-flash", "lite", "gemini-3.1-flash-lite"],
      ["chatgpt-5.4", "pro", "chatgpt-5.5"],
      ["chatgpt-5.4", "lite", "chatgpt-5.4-mini"],
    ] as const;

    for (const [currentId, modelClass, expectedId] of cases) {
      const resolved = resolveModelForClass(resolveModel(currentId), modelClass);
      expect(resolved.id).toBe(expectedId);
      expect(resolved.provider).toBe(resolveModel(currentId).provider);
    }
  });

  it("returns the current model when the provider does not support a requested class", () => {
    const gemma = resolveModel("vertex-gemma-4-26b-it");
    expect(resolveModelForClass(gemma, "lite")).toBe(gemma);
    expect(resolveModelForClass(gemma, "pro")).toBe(gemma);

    const custom: Model = {
      id: "custom-model",
      provider: "custom",
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      supportsThinking: false,
    };
    expect(resolveModelForClass(custom, "pro")).toBe(custom);
  });

  it("derives class from defaults and additional membership without reading model cards", () => {
    expect(getModelClass(resolveModel("claude-opus-4-8"))).toBe("pro");
    expect(getModelClass(resolveModel(DEFAULT_ANTHROPIC_MODEL_ID))).toBe("general");
    expect(getModelClass(resolveModel("claude-haiku-4-5"))).toBe("lite");
    expect(getModelClass(resolveModel("gpt-5.6-sol"))).toBe("pro");
    expect(getModelClass(resolveModel("gpt-5.6-terra"))).toBe("general");
    expect(getModelClass(resolveModel("gpt-5.6-luna"))).toBe("lite");
  });

  it("maps class defaults to supported effort names", () => {
    expect(getDefaultEffortForClass("pro")).toBe("high");
    expect(getDefaultEffortForClass("general")).toBe("medium");
    expect(getDefaultEffortForClass("lite")).toBe("low");
  });
});
