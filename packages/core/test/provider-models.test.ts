import { describe, expect, it } from "bun:test";
import { KNOWN_MODELS, resolveModel } from "../src/provider/models";

describe("KNOWN_MODELS", () => {
  it("has Anthropic models", () => {
    const anthropic = KNOWN_MODELS.filter((m) => m.provider === "anthropic");
    expect(anthropic.length).toBeGreaterThanOrEqual(2);
  });

  it("has OpenAI models", () => {
    const openai = KNOWN_MODELS.filter((m) => m.provider === "openai");
    expect(openai.length).toBeGreaterThanOrEqual(3);
  });
});

describe("resolveModel", () => {
  it("resolves exact model ID", () => {
    const model = resolveModel("gpt-4o");
    expect(model.id).toBe("gpt-4o");
    expect(model.provider).toBe("openai");
    expect(model.contextWindow).toBe(128_000);
  });

  it("resolves alias", () => {
    const model = resolveModel("sonnet");
    expect(model.id).toBe("claude-sonnet-4-20250514");
    expect(model.provider).toBe("anthropic");
  });

  it("resolves another alias", () => {
    const model = resolveModel("4o");
    expect(model.id).toBe("gpt-4o");
    expect(model.provider).toBe("openai");
  });

  it("infers anthropic from claude- prefix", () => {
    const model = resolveModel("claude-opus-4-20250514");
    expect(model.provider).toBe("anthropic");
    expect(model.contextWindow).toBe(200_000);
  });

  it("infers openai from gpt- prefix", () => {
    const model = resolveModel("gpt-5-turbo");
    expect(model.provider).toBe("openai");
    expect(model.contextWindow).toBe(128_000);
  });

  it("infers openai from o1/o3 prefix", () => {
    expect(resolveModel("o1-preview").provider).toBe("openai");
    expect(resolveModel("o3-mini").provider).toBe("openai");
  });

  it("defaults unknown model to anthropic", () => {
    const model = resolveModel("unknown-model");
    expect(model.provider).toBe("anthropic");
  });
});
