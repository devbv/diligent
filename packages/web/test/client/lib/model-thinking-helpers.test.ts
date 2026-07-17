// @summary Tests for browser model-specific thinking effort options and normalization

import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "@diligent/protocol";
import {
  getThinkingEffortOptions,
  normalizeThinkingEffort,
  supportsThinkingEffort,
} from "../../../src/client/lib/model-thinking-helpers";

function model(id: string, supportedEfforts: ModelInfo["supportedEfforts"], provider = "openai"): ModelInfo {
  return {
    id,
    provider,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts,
  };
}

describe("model thinking helpers", () => {
  const gpt56 = model("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]);
  const gpt55 = model("gpt-5.5", ["low", "medium", "high", "xhigh"]);

  it("renders xhigh only when the model advertises it", () => {
    expect(getThinkingEffortOptions(gpt56).map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingEffortOptions(gpt55).map((option) => option.value)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("validates and normalizes model-specific effort values", () => {
    expect(supportsThinkingEffort(gpt56, "xhigh")).toBe(true);
    expect(supportsThinkingEffort(gpt55, "xhigh")).toBe(true);
    expect(supportsThinkingEffort(gpt55, "max")).toBe(false);
    expect(normalizeThinkingEffort(gpt55, "xhigh")).toBe("xhigh");
    expect(normalizeThinkingEffort(gpt55, "max")).toBe("medium");
  });

  it("preserves legacy state for non-thinking models except xhigh", () => {
    const nonThinking: ModelInfo = {
      ...model("vertex-gemma-4-26b-it", undefined),
      provider: "vertex",
      supportsThinking: false,
    };

    expect(normalizeThinkingEffort(nonThinking, "high")).toBe("high");
    expect(normalizeThinkingEffort(nonThinking, "xhigh")).toBe("medium");
  });
});
