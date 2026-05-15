// @summary Tests for model resolution inference logic and model class system
import { describe, expect, it } from "bun:test";
import {
  agentTypeToModelClass,
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

  it("uses 300k context for known Sonnet and Opus models", () => {
    expect(resolveModel("claude-sonnet-4-6").contextWindow).toBe(300_000);
    expect(resolveModel("claude-opus-4-6").contextWindow).toBe(300_000);
    expect(resolveModel("claude-opus-4-7").contextWindow).toBe(300_000);
  });

  it("resolves claude-opus-4-7 dated alias", () => {
    const model = resolveModel("claude-opus-4-7-20260416");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-opus-4-7");
  });

  it("infers chatgpt from chatgpt- prefix", () => {
    const model = resolveModel("chatgpt-5.3-codex");
    expect(model.provider).toBe("chatgpt");
  });

  it("resolves chatgpt-5.5-pro alias to chatgpt-5.5", () => {
    const model = resolveModel("chatgpt-5.5-pro");
    expect(model.provider).toBe("chatgpt");
    expect(model.id).toBe("chatgpt-5.5");
  });

  it("infers vertex from vertex- prefix", () => {
    const model = resolveModel("vertex-gemma-4-26b-it");
    expect(model.provider).toBe("vertex");
    expect(model.supportsThinking).toBe(false);
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

  it("every known model has a modelClass", () => {
    for (const model of KNOWN_MODELS) {
      expect(model.modelClass).toBeDefined();
      expect(["pro", "general", "lite"]).toContain(model.modelClass);
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
    expect(KNOWN_MODELS.find((m) => m.id === "claude-opus-4-6")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "claude-opus-4-7")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "claude-sonnet-4-6")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "claude-haiku-4-5")?.modelClass).toBe("lite");
  });

  it("openai classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.4")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.3-codex")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "gpt-5.4-mini")?.modelClass).toBe("lite");
  });

  it("gemini classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "gemini-3.1-pro-preview")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "gemini-3-flash-preview")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "gemini-3.1-flash-lite-preview")?.modelClass).toBe("lite");
  });

  it("chatgpt classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.4")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.5")?.modelClass).toBe("pro");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.3-codex")?.modelClass).toBe("general");
    expect(KNOWN_MODELS.find((m) => m.id === "chatgpt-5.4-mini")?.modelClass).toBe("lite");
  });

  it("vertex classes map correctly", () => {
    expect(KNOWN_MODELS.find((m) => m.id === "vertex-gemma-4-26b-it")?.modelClass).toBe("general");
  });
});

describe("getModelClass", () => {
  it("returns modelClass for known models", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    expect(getModelClass(sonnet)).toBe("general");

    const opus = resolveModel("claude-opus-4-6");
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
    };
    expect(getModelClass(unknown)).toBe("general");
  });
});

describe("resolveModelForClass", () => {
  it("returns same model if already matching class", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    const result = resolveModelForClass(sonnet, "general");
    expect(result.id).toBe("claude-sonnet-4-6");
  });

  it("resolves anthropic pro → opus", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    const pro = resolveModelForClass(sonnet, "pro");
    expect(pro.id).toBe("claude-opus-4-6");
    expect(pro.provider).toBe("anthropic");
  });

  it("keeps anthropic pro default pinned to opus 4.6", () => {
    const opus47 = resolveModel("claude-opus-4-7");
    const pro = resolveModelForClass(opus47, "pro");
    expect(pro.id).toBe("claude-opus-4-7");

    const sonnet = resolveModel("claude-sonnet-4-6");
    expect(resolveModelForClass(sonnet, "pro").id).toBe("claude-opus-4-6");
  });

  it("resolves anthropic lite → haiku", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    const lite = resolveModelForClass(sonnet, "lite");
    expect(lite.id).toBe("claude-haiku-4-5");
    expect(lite.provider).toBe("anthropic");
  });

  it("resolves openai general → lite", () => {
    const codex = resolveModel("gpt-5.3-codex");
    const lite = resolveModelForClass(codex, "lite");
    expect(lite.id).toBe("gpt-5.4-mini");
    expect(lite.provider).toBe("openai");
  });

  it("resolves gemini general → pro", () => {
    const flash = resolveModel("gemini-3-flash-preview");
    const pro = resolveModelForClass(flash, "pro");
    expect(pro.id).toBe("gemini-3.1-pro-preview");
    expect(pro.provider).toBe("gemini");
  });

  it("resolves gemini general → lite", () => {
    const flash = resolveModel("gemini-3-flash-preview");
    const lite = resolveModelForClass(flash, "lite");
    expect(lite.id).toBe("gemini-3.1-flash-lite-preview");
    expect(lite.provider).toBe("gemini");
  });

  it("resolves chatgpt general → lite", () => {
    const codex = resolveModel("chatgpt-5.3-codex");
    const lite = resolveModelForClass(codex, "lite");
    expect(lite.id).toBe("chatgpt-5.4-mini");
    expect(lite.provider).toBe("chatgpt");
  });

  it("resolves chatgpt general → pro", () => {
    const codex = resolveModel("chatgpt-5.3-codex");
    const pro = resolveModelForClass(codex, "pro");
    expect(pro.id).toBe("chatgpt-5.4");
    expect(pro.provider).toBe("chatgpt");
  });

  it("keeps vertex on the unified model when other classes are requested", () => {
    const gemma = resolveModel("vertex-gemma-4-26b-it");
    expect(resolveModelForClass(gemma, "lite").id).toBe("vertex-gemma-4-26b-it");
    expect(resolveModelForClass(gemma, "pro").id).toBe("vertex-gemma-4-26b-it");
  });

  it("falls back to current model for unknown provider", () => {
    const custom: Model = { id: "custom-model", provider: "custom", contextWindow: 100_000, maxOutputTokens: 4096 };
    const result = resolveModelForClass(custom, "pro");
    expect(result.id).toBe("custom-model");
  });

  it("stays within the same provider", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    const pro = resolveModelForClass(sonnet, "pro");
    expect(pro.provider).toBe("anthropic");
    // Should never cross providers
    expect(pro.provider).not.toBe("openai");
    expect(pro.provider).not.toBe("gemini");
  });
});

describe("agentTypeToModelClass", () => {
  it("maps explore → lite", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    expect(agentTypeToModelClass("explore", sonnet)).toBe("lite");
  });

  it("maps general → same class as parent (general)", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    expect(agentTypeToModelClass("general", sonnet)).toBe("general");
  });

  it("maps general → same class as parent (pro)", () => {
    const opus = resolveModel("claude-opus-4-6");
    expect(agentTypeToModelClass("general", opus)).toBe("pro");
  });

  it("maps general → same class as parent (lite)", () => {
    const haiku = resolveModel("claude-haiku-4-5");
    expect(agentTypeToModelClass("general", haiku)).toBe("lite");
  });

  it("maps unknown agent type → general (same as parent default)", () => {
    const sonnet = resolveModel("claude-sonnet-4-6");
    expect(agentTypeToModelClass("unknown_type", sonnet)).toBe("general");
  });
});
