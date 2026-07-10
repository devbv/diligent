// @summary Tests for model-specific thinking-effort options and compatibility normalization

import { describe, expect, it } from "bun:test";
import { resolveModel } from "../../src/llm/models";
import {
  getThinkingEffortOptions,
  normalizeThinkingEffort,
  supportsThinkingEffort,
} from "../../src/llm/thinking-effort";

describe("thinking effort capabilities", () => {
  it("exposes xhigh and max separately for every GPT-5.6 family member", () => {
    for (const id of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "chatgpt-5.6-sol",
      "chatgpt-5.6-terra",
      "chatgpt-5.6-luna",
    ]) {
      const values = getThinkingEffortOptions(resolveModel(id)).map((option) => option.value);
      expect(values).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("does not expose xhigh for GPT-5.5, Claude, or unknown models", () => {
    expect(getThinkingEffortOptions(resolveModel("gpt-5.5")).map((option) => option.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getThinkingEffortOptions(resolveModel("claude-sonnet-4-6")).map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getThinkingEffortOptions(undefined).map((option) => option.value)).toEqual(["low", "medium", "high", "max"]);
  });

  it("checks explicit model metadata for effort support", () => {
    expect(supportsThinkingEffort(resolveModel("gpt-5.6-sol"), "xhigh")).toBe(true);
    expect(supportsThinkingEffort(resolveModel("gpt-5.5"), "xhigh")).toBe(false);
    expect(supportsThinkingEffort(resolveModel("claude-sonnet-4-6"), "none")).toBe(false);
  });

  it("normalizes GPT-5.6 xhigh to the legacy OpenAI max compatibility value", () => {
    expect(normalizeThinkingEffort(resolveModel("gpt-5.5"), "xhigh")).toBe("max");
    expect(normalizeThinkingEffort(resolveModel("chatgpt-5.5"), "xhigh")).toBe("max");
  });

  it("falls back to medium when another provider does not support the selected effort", () => {
    expect(normalizeThinkingEffort(resolveModel("claude-sonnet-4-6"), "xhigh")).toBe("medium");
    expect(normalizeThinkingEffort(resolveModel("claude-sonnet-4-6"), "none")).toBe("medium");
  });

  it("preserves legacy effort state for non-thinking models while removing restricted values", () => {
    const model = resolveModel("vertex-gemma-4-26b-it");

    expect(normalizeThinkingEffort(model, "high")).toBe("high");
    expect(normalizeThinkingEffort(model, "max")).toBe("max");
    expect(normalizeThinkingEffort(model, "none")).toBe("medium");
    expect(normalizeThinkingEffort(model, "xhigh")).toBe("medium");
  });
});
