// @summary Tests for model-card metadata and model resolution inference
import { describe, expect, it } from "bun:test";
import { DEFAULT_ANTHROPIC_MODEL_ID, MODEL_CARD_SCHEMA_VERSION, MODEL_CARDS, resolveModel } from "../../src/llm/models";

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
    expect(MODEL_CARDS.find((model) => model.id === "gpt-5.6-sol")?.display).toBe("GPT-5.6 Sol");
    expect(MODEL_CARDS.find((model) => model.id === "gpt-5.6-terra")?.display).toBe("GPT-5.6 Terra");
    expect(MODEL_CARDS.find((model) => model.id === "gpt-5.6-luna")?.display).toBe("GPT-5.6 Luna");
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

describe("model cards", () => {
  it("uses a versioned, extensible card schema", () => {
    for (const card of MODEL_CARDS) {
      expect(card.schemaVersion).toBe(MODEL_CARD_SCHEMA_VERSION);
      expect(card.extensions).toBeUndefined();
    }
  });

  it("does not mix model-class policy into model metadata", () => {
    for (const card of MODEL_CARDS) {
      expect("modelClass" in card).toBe(false);
    }
  });

  it("annotates vision support for providers with image-capable model cards", () => {
    for (const model of MODEL_CARDS) {
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

  it("keeps vertex as a single selectable model card", () => {
    const vertexModels = MODEL_CARDS.filter((m) => m.provider === "vertex");
    expect(vertexModels).toHaveLength(1);
    expect(vertexModels[0]?.id).toBe("vertex-gemma-4-26b-it");
  });

  it("registers official GPT-5.6 metadata and pricing", () => {
    const expected = {
      "gpt-5.6-sol": { input: 5, cached: 0.5, write: 6.25, output: 30 },
      "gpt-5.6-terra": { input: 2.5, cached: 0.25, write: 3.125, output: 15 },
      "gpt-5.6-luna": { input: 1, cached: 0.1, write: 1.25, output: 6 },
    } as const;

    for (const [id, pricing] of Object.entries(expected)) {
      const model = MODEL_CARDS.find((candidate) => candidate.id === id);
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

  it("keeps the OpenAI catalog order stable", () => {
    expect(MODEL_CARDS.filter((model) => model.provider === "openai").map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("keeps the ChatGPT catalog order stable", () => {
    expect(MODEL_CARDS.filter((m) => m.provider === "chatgpt").map((m) => m.id)).toEqual([
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
      const model = MODEL_CARDS.find((candidate) => candidate.id === id);
      expect(model?.contextWindow).toBe(300_000);
      expect(model?.maxOutputTokens).toBe(128_000);
      expect(model?.supportedEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
      expect(model?.inputCostPer1M).toBeUndefined();
      expect(model?.outputCostPer1M).toBeUndefined();
    }
  });

  it("keeps effort and thinking support as intrinsic model-card capabilities", () => {
    expect(MODEL_CARDS.find((m) => m.id === "glm-5.2")?.supportsThinking).toBe(true);
    expect(MODEL_CARDS.find((m) => m.id === "gpt-5.6-sol")?.supportedEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
