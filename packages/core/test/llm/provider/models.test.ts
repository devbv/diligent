// @summary Tests for model resolution inference logic and model class system
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ANTHROPIC_MODEL_ID,
  getModelClass,
  KNOWN_MODELS,
  resolveModel,
  resolveModelForClass,
} from "../../../src/llm/models";
import type { Model } from "../../../src/llm/types";

describe("resolveModel", () => {
  it("infers anthropic from claude- prefix", () => {
    const model = resolveModel("claude-opus-4-20250514");
    expect(model.provider).toBe("anthropic");
    expect(model.contextWindow).toBe(300_000);
  });

  it("infers openai from gpt- prefix", () => {
    const model = resolveModel("gpt-5-turbo");
    expect(model.provider).toBe("openai");
    expect(model.contextWindow).toBe(128_000);
  });

  it("resolves the GPT-5.6 family alias to Sol", () => {
    expect(resolveModel("gpt-5.6").id).toBe("gpt-5.6-sol");
    expect(KNOWN_MODELS.find((model) => model.id === "gpt-5.6-sol")?.display).toBe("GPT-5.6 Sol");
    expect(KNOWN_MODELS.find((model) => model.id === "gpt-5.6-terra")?.display).toBe("GPT-5.6 Terra");
    expect(KNOWN_MODELS.find((model) => model.id === "gpt-5.6-luna")?.display).toBe("GPT-5.6 Luna");
  });

  it("infers openai from o-series prefix", () => {
    expect(resolveModel("o1-preview").provider).toBe("openai");
    expect(resolveModel("o3-mini").provider).toBe("openai");
    expect(resolveModel("o4-mini").provider).toBe("openai");
  });

  it("defaults unknown model to anthropic", () => {
    const model = resolveModel("unknown-model");
    expect(model.provider).toBe("anthropic");
    expect(model.contextWindow).toBe(300_000);
  });

  it("uses 1M context for known Sonnet and Opus models", () => {
    expect(resolveModel(DEFAULT_ANTHROPIC_MODEL_ID).contextWindow).toBe(1_000_000);
    expect(resolveModel("claude-opus-4-8").contextWindow).toBe(1_000_000);
  });

  it("keeps Sonnet 5 available as an experimental model", () => {
    const model = resolveModel("claude-sonnet-5");
    expect(model.provider).toBe("anthropic");
    expect(model.maxOutputTokens).toBe(128_000);
  });

  it("resolves claude-opus alias to the only retained Opus version", () => {
    const model = resolveModel("opus");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-opus-4-8");
  });

  it("resolves fable aliases to Claude Fable 5", () => {
    expect(resolveModel("fable").id).toBe("claude-fable-5");
    expect(resolveModel("fable-5").id).toBe("claude-fable-5");
  });

  it("infers chatgpt from chatgpt- prefix", () => {
    const model = resolveModel("chatgpt-5.5");
    expect(model.provider).toBe("chatgpt");
  });

  it("resolves chatgpt-5.5-pro alias to chatgpt-5.5", () => {
    const model = resolveModel("chatgpt-5.5-pro");
    expect(model.provider).toBe("chatgpt");
    expect(model.id).toBe("chatgpt-5.5");
  });

  it("resolves the ChatGPT GPT-5.6 family alias to Sol", () => {
    const model = resolveModel("chatgpt-5.6");
    expect(model.provider).toBe("chatgpt");
    expect(model.id).toBe("chatgpt-5.6-sol");
  });

  it("infers vertex from vertex- prefix", () => {
    const model = resolveModel("vertex-gemma-4-26b-it");
    expect(model.provider).toBe("vertex");
    expect(model.supportsThinking).toBe(false);
  });

  it("resolves GLM aliases to the current z.ai default", () => {
    expect(resolveModel("glm").id).toBe("glm-5.2");
    expect(resolveModel("glm-5").id).toBe("glm-5.2");
    expect(resolveModel("glm5.2").id).toBe("glm-5.2");
    expect(resolveModel("glm5.1").id).toBe("glm-5.1");
  });
});

describe("model class annotations", () => {
  it("annotates vision support for providers with image-capable model cards", () => {
    for (const model of KNOWN_MODELS) {
      if (
        model.provider === "anthropic" ||
        model.provider === "openai" ||
        model.provider === "chatgpt" ||
        model.provider === "gemini"
      ) {
        expect(model.supportsVision).toBe(true);
      } else {
        expect(model.supportsVision).not.toBe(true);
      }
    }
  });

  it("modelClass annotations are valid when present", () => {
    for (const model of KNOWN_MODELS) {
      if (model.modelClass !== undefined) {
        expect(["pro", "general", "lite"]).toContain(model.modelClass);
      }
    }
  });

  it("each non-vertex provider has at least one model per class", () => {
    for (const provider of ["anthropic", "openai", "chatgpt", "gemini"]) {
      for (const cls of ["pro", "general", "lite"] as const) {
        const match = KNOWN_MODELS.find((m) => m.provider === provider && m.modelClass === cls);
        expect(match).toBeDefined();
      }
    }
  });

  it("vertex is unified to a single general-class model", () => {
    const vertexModels = KNOWN_MODELS.filter((m) => m.provider === "vertex");
    expect(vertexModels).toHaveLength(1);
    expect(vertexModels[0]?.id).toBe("vertex-gemma-4-26b-it");
    expect(vertexModels[0]?.modelClass).toBe("general");
  });

  it("anthropic classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "claude-opus-4-8")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "claude-fable-5")?.modelClass).toBeUndefined();
    expect(KNOWN_MODELS.find((m) => m.id === "claude-sonnet-5")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === DEFAULT_ANTHROPIC_MODEL_ID)?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "claude-haiku-4-5-20251001")?.modelClass).toBe("lite");
  });

  it("openai classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.6-sol")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.6-terra")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.6-luna")?.modelClass).toBe("lite");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.5")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.4")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.4-mini")?.modelClass).toBe("lite");
  });

  it("registers official GPT-5.6 metadata and pricing", () => {
    const expected = {
      "gpt-5.6-sol": { input: 5, cached: 0.5, write: 6.25, output: 30 },
      "gpt-5.6-terra": { input: 2.5, cached: 0.25, write: 3.125, output: 15 },
      "gpt-5.6-luna": { input: 1, cached: 0.1, write: 1.25, output: 6 },
    } as const;

    for (const [id, pricing] of Object.entries(expected)) {
      const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
      expect(model).toBeDefined();
      expect(model?.contextWindow).toBe(1_050_000);
      expect(model?.maxOutputTokens).toBe(128_000);
      expect(model?.inputCostPer1M).toBe(pricing.input);
      expect(model?.cacheReadCostPer1M).toBe(pricing.cached);
      expect(model?.cacheWriteCostPer1M).toBe(pricing.write);
      expect(model?.outputCostPer1M).toBe(pricing.output);
      expect(model?.supportedEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("keeps existing OpenAI class routes ahead of the selectable GPT-5.6 family", () => {
    expect(KNOWN_MODELS.filter((model) => model.provider === "openai").map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("gemini classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "gemini-3.1-pro-preview")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "gemini-3.5-flash")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "gemini-3.1-flash-lite")?.modelClass).toBe("lite");
  });

  it("chatgpt classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.6-sol")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.6-terra")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.6-luna")?.modelClass).toBe("lite");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.5")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.4")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.4-mini")?.modelClass).toBe("lite");
  });

  it("keeps existing ChatGPT class routes ahead of the selectable GPT-5.6 family", () => {
    expect(KNOWN_MODELS.filter((m) => m.provider === "chatgpt").map((m) => m.id)).toEqual([
      "chatgpt-5.5",
      "chatgpt-5.4",
      "chatgpt-5.4-mini",
      "chatgpt-5.6-sol",
      "chatgpt-5.6-terra",
      "chatgpt-5.6-luna",
    ]);
  });

  it("registers ChatGPT GPT-5.6 capabilities without API usage pricing", () => {
    for (const id of ["chatgpt-5.6-sol", "chatgpt-5.6-terra", "chatgpt-5.6-luna"]) {
      const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
      expect(model?.contextWindow).toBe(300_000);
      expect(model?.maxOutputTokens).toBe(128_000);
      expect(model?.supportedEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
      expect(model?.inputCostPer1M).toBeUndefined();
      expect(model?.outputCostPer1M).toBeUndefined();
    }
  });

  it("vertex classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "vertex-gemma-4-26b-it")?.modelClass).toBe("general");
  });

  it("z.ai classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "glm-5.2")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "glm-5.2")?.supportsThinking).toBe(true);
    expect(KNOWN_MODELS.find((m) => m.id === "glm-5.1")?.modelClass).toBe("general");
  });
});

describe("getModelClass", () => {
  it("returns modelClass for known models", () => {
    const sonnet = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    expect(getModelClass(sonnet)).toBe("general");

    const opus = resolveModel("claude-opus-4-8");
    expect(getModelClass(opus)).toBe("pro");

    const haiku = resolveModel("claude-haiku-4-5");
    expect(getModelClass(haiku)).toBe("lite");
  });

  it("defaults to 'general' for unknown models", () => {
    const unknown: Model = {
      id: "unknown-model",
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      supportsThinking: false,
    };
    expect(getModelClass(unknown)).toBe("general");
  });
});

describe("resolveModelForClass", () => {
  it("returns same model if already matching class", () => {
    const sonnet = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    const result = resolveModelForClass(sonnet, "general");
    expect(result.id).toBe(DEFAULT_ANTHROPIC_MODEL_ID);
  });

  it("resolves anthropic pro → opus", () => {
    const sonnet = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    const pro = resolveModelForClass(sonnet, "pro");
    expect(pro.id).toBe("claude-opus-4-8");
    expect(pro.provider).toBe("anthropic");
  });

  it("routes unclassified anthropic pro-capable models to the provider pro default", () => {
    const fable = resolveModel("claude-fable-5");
    const pro = resolveModelForClass(fable, "pro");
    expect(pro.id).toBe("claude-opus-4-8");

    const sonnet = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    expect(resolveModelForClass(sonnet, "pro").id).toBe("claude-opus-4-8");
  });

  it("resolves anthropic lite → haiku", () => {
    const sonnet = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    const lite = resolveModelForClass(sonnet, "lite");
    expect(lite.id).toBe("claude-haiku-4-5-20251001");
    expect(lite.provider).toBe("anthropic");
  });

  it("keeps OpenAI class routing on the existing model family", () => {
    const codex = resolveModel("gpt-5.3-codex");
    const pro = resolveModelForClass(codex, "pro");
    const general = resolveModelForClass(codex, "general");
    const lite = resolveModelForClass(codex, "lite");
    expect(pro.id).toBe("gpt-5.5");
    expect(general.id).toBe("gpt-5.4");
    expect(lite.id).toBe("gpt-5.4-mini");
    expect(lite.provider).toBe("openai");
  });

  it("resolves gemini general → pro", () => {
    const flash = resolveModel("gemini-3.5-flash");
    const pro = resolveModelForClass(flash, "pro");
    expect(pro.id).toBe("gemini-3.1-pro-preview");
    expect(pro.provider).toBe("gemini");
  });

  it("resolves gemini general → lite", () => {
    const flash = resolveModel("gemini-3.5-flash");
    const lite = resolveModelForClass(flash, "lite");
    expect(lite.id).toBe("gemini-3.1-flash-lite");
    expect(lite.provider).toBe("gemini");
  });

  it("resolves chatgpt general → lite", () => {
    const chatgpt = resolveModel("chatgpt-5.4");
    const lite = resolveModelForClass(chatgpt, "lite");
    expect(lite.id).toBe("chatgpt-5.4-mini");
    expect(lite.provider).toBe("chatgpt");
  });

  it("resolves chatgpt general → pro", () => {
    const chatgpt = resolveModel("chatgpt-5.4");
    const pro = resolveModelForClass(chatgpt, "pro");
    expect(pro.id).toBe("chatgpt-5.5");
    expect(pro.provider).toBe("chatgpt");
  });

  it("keeps vertex on the unified model when other classes are requested", () => {
    const gemma = resolveModel("vertex-gemma-4-26b-it");
    expect(resolveModelForClass(gemma, "lite").id).toBe("vertex-gemma-4-26b-it");
    expect(resolveModelForClass(gemma, "pro").id).toBe("vertex-gemma-4-26b-it");
  });

  it("falls back to current model for unknown provider", () => {
    const custom: Model = {
      id: "custom-model",
      provider: "custom",
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      supportsThinking: false,
    };
    const result = resolveModelForClass(custom, "pro");
    expect(result.id).toBe("custom-model");
  });

  it("stays within the same provider", () => {
    const sonnet = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    const pro = resolveModelForClass(sonnet, "pro");
    expect(pro.provider).toBe("anthropic");
    // Should never cross providers
    expect(pro.provider).not.toBe("openai");
    expect(pro.provider).not.toBe("gemini");
  });
});
