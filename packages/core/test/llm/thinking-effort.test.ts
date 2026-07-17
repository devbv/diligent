// @summary Tests for model-specific thinking-effort options and compatibility normalization

import { describe, expect, it } from "bun:test";
import { listModels, resolveModel } from "../../src/llm/models";
import {
  getThinkingEffortOptions,
  normalizeThinkingEffort,
  supportsThinkingEffort,
} from "../../src/llm/thinking-effort";

describe("thinking effort capabilities", () => {
  it("exposes the full effort set for native provider models other than GPT-5.5", () => {
    for (const model of listModels().filter(
      ({ modelId, provider }) => !modelId.endsWith("5.5") && ["anthropic", "openai", "chatgpt"].includes(provider),
    )) {
      expect(getThinkingEffortOptions(model).map((option) => option.value)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  it("exposes xhigh instead of max for GPT-5.5", () => {
    for (const provider of ["openai", "chatgpt"] as const) {
      expect(
        getThinkingEffortOptions(resolveModel({ provider, modelId: "gpt-5.5" })).map((option) => option.value),
      ).toEqual(["low", "medium", "high", "xhigh"]);
    }
  });

  it("uses the generic effort set when no explicit model is selected", () => {
    expect(getThinkingEffortOptions(undefined).map((option) => option.value)).toEqual(["low", "medium", "high", "max"]);
  });

  it("checks explicit model metadata for effort support", () => {
    expect(supportsThinkingEffort(resolveModel({ provider: "openai", modelId: "gpt-5.5" }), "xhigh")).toBe(true);
    expect(supportsThinkingEffort(resolveModel({ provider: "anthropic", modelId: "claude-sonnet-4-6" }), "xhigh")).toBe(
      true,
    );
    expect(supportsThinkingEffort(resolveModel({ provider: "chatgpt", modelId: "gpt-5.5" }), "xhigh")).toBe(true);
    expect(supportsThinkingEffort(resolveModel({ provider: "openai", modelId: "gpt-5.5" }), "max")).toBe(false);
    expect(supportsThinkingEffort(resolveModel({ provider: "chatgpt", modelId: "gpt-5.5" }), "max")).toBe(false);
  });

  it("preserves xhigh for native provider models", () => {
    expect(normalizeThinkingEffort(resolveModel({ provider: "openai", modelId: "gpt-5.5" }), "xhigh")).toBe("xhigh");
    expect(
      normalizeThinkingEffort(resolveModel({ provider: "anthropic", modelId: "claude-sonnet-4-6" }), "xhigh"),
    ).toBe("xhigh");
    expect(normalizeThinkingEffort(resolveModel({ provider: "chatgpt", modelId: "gpt-5.5" }), "xhigh")).toBe("xhigh");
  });

  it("preserves legacy effort state for non-thinking models while removing xhigh", () => {
    const model = resolveModel({ provider: "vertex", modelId: "vertex-gemma-4-26b-it" });

    expect(normalizeThinkingEffort(model, "high")).toBe("high");
    expect(normalizeThinkingEffort(model, "max")).toBe("max");
    expect(normalizeThinkingEffort(model, "xhigh")).toBe("medium");
  });
});
