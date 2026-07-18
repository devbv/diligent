// @summary Tests thinking-effort behavior independently of the current model catalog

import { describe, expect, it } from "bun:test";
import {
  getThinkingEffortOptions,
  normalizeThinkingEffort,
  supportsThinkingEffort,
} from "../../src/llm/thinking-effort";
import type { ProviderName, ThinkingEffort } from "../../src/llm/types";

function thinkingModel(supportedEfforts?: ThinkingEffort[], provider: ProviderName = "anthropic") {
  return { provider, supportsThinking: true, supportedEfforts };
}

describe("thinking effort capabilities", () => {
  it("uses the model's explicit effort set", () => {
    expect(getThinkingEffortOptions(thinkingModel(["low", "xhigh"])).map((option) => option.value)).toEqual([
      "low",
      "xhigh",
    ]);
  });

  it("includes xhigh by default without explicit model capabilities", () => {
    expect(getThinkingEffortOptions(undefined).map((option) => option.value)).toContain("xhigh");
    expect(getThinkingEffortOptions(thinkingModel()).map((option) => option.value)).toContain("xhigh");
    expect(supportsThinkingEffort(thinkingModel(), "xhigh")).toBe(true);
  });

  it("checks explicit model metadata for effort support", () => {
    const model = thinkingModel(["medium", "xhigh"]);
    expect(supportsThinkingEffort(model, "xhigh")).toBe(true);
    expect(supportsThinkingEffort(model, "max")).toBe(false);
  });

  it("preserves supported effort and normalizes unsupported xhigh to medium", () => {
    expect(normalizeThinkingEffort(thinkingModel(["medium", "xhigh"]), "xhigh")).toBe("xhigh");
    expect(normalizeThinkingEffort(thinkingModel(["medium", "max"], "openai"), "xhigh")).toBe("medium");
  });

  it("preserves effort state for non-thinking models", () => {
    const model = { provider: "vertex" as const, supportsThinking: false };

    expect(normalizeThinkingEffort(model, "high")).toBe("high");
    expect(normalizeThinkingEffort(model, "max")).toBe("max");
    expect(normalizeThinkingEffort(model, "xhigh")).toBe("xhigh");
  });
});
