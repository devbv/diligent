// @summary Tests for model-specific thinking-effort options and compatibility normalization

import { describe, expect, it } from "bun:test";
import { MODEL_CARDS, resolveModel } from "../../src/llm/models";
import {
  getThinkingEffortOptions,
  normalizeThinkingEffort,
  supportsThinkingEffort,
} from "../../src/llm/thinking-effort";

describe("thinking effort capabilities", () => {
  it("exposes one fixed effort set for every native provider model", () => {
    for (const model of MODEL_CARDS.filter(({ provider }) => ["anthropic", "openai", "chatgpt"].includes(provider))) {
      expect(getThinkingEffortOptions(model).map((option) => option.value)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  it("applies the fixed set to inferred native provider models", () => {
    for (const id of ["claude-future", "gpt-future", "o9-future", "chatgpt-future"]) {
      expect(getThinkingEffortOptions(resolveModel(id)).map((option) => option.value)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    expect(getThinkingEffortOptions(undefined).map((option) => option.value)).toEqual(["low", "medium", "high", "max"]);
  });

  it("checks explicit model metadata for effort support", () => {
    expect(supportsThinkingEffort(resolveModel("gpt-5.5"), "xhigh")).toBe(true);
    expect(supportsThinkingEffort(resolveModel("claude-sonnet-4-6"), "xhigh")).toBe(true);
    expect(supportsThinkingEffort(resolveModel("chatgpt-5.5"), "xhigh")).toBe(true);
    expect(supportsThinkingEffort(resolveModel("gpt-5.5"), "none")).toBe(false);
    expect(supportsThinkingEffort(resolveModel("claude-sonnet-4-6"), "none")).toBe(false);
    expect(supportsThinkingEffort(resolveModel("chatgpt-5.5"), "none")).toBe(false);
  });

  it("preserves xhigh and normalizes removed none effort to medium", () => {
    expect(normalizeThinkingEffort(resolveModel("gpt-5.5"), "xhigh")).toBe("xhigh");
    expect(normalizeThinkingEffort(resolveModel("claude-sonnet-4-6"), "xhigh")).toBe("xhigh");
    expect(normalizeThinkingEffort(resolveModel("chatgpt-5.5"), "xhigh")).toBe("xhigh");
    expect(normalizeThinkingEffort(resolveModel("gpt-5.5"), "none")).toBe("medium");
    expect(normalizeThinkingEffort(resolveModel("claude-sonnet-4-6"), "none")).toBe("medium");
    expect(normalizeThinkingEffort(resolveModel("chatgpt-5.5"), "none")).toBe("medium");
  });

  it("preserves legacy effort state for non-thinking models while removing restricted values", () => {
    const model = resolveModel("vertex-gemma-4-26b-it");

    expect(normalizeThinkingEffort(model, "high")).toBe("high");
    expect(normalizeThinkingEffort(model, "max")).toBe("max");
    expect(normalizeThinkingEffort(model, "none")).toBe("medium");
    expect(normalizeThinkingEffort(model, "xhigh")).toBe("medium");
  });
});
