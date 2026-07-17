// @summary Contract tests for the z.ai Coding Plan AI SDK adapter
import { describe, expect, it } from "bun:test";
import {
  buildZaiCodingPlanProviderOptions,
  resolveZaiCodingPlanBaseUrl,
  transformZaiCodingPlanRequest,
} from "../../../src/llm/provider/zai-coding-plan";
import type { Model } from "../../../src/llm/types";

const model: Model = {
  id: "glm-test",
  provider: "zai-coding-plan",
  contextWindow: 100_000,
  maxOutputTokens: 16_000,
  supportsThinking: true,
};

describe("z.ai Coding Plan AI SDK options", () => {
  it("preserves Diligent effort and enables z.ai thinking in the request", () => {
    expect(buildZaiCodingPlanProviderOptions(model, { effort: "max" })).toEqual({
      zaiCodingPlan: { reasoningEffort: "max" },
    });
    expect(transformZaiCodingPlanRequest({ reasoning_effort: "max", stream: true })).toEqual({
      reasoning_effort: "max",
      stream: true,
      thinking: { type: "enabled" },
    });
  });

  it("does not enable thinking when reasoning effort is absent", () => {
    expect(transformZaiCodingPlanRequest({ stream: true })).toEqual({ stream: true });
  });

  it("normalizes the compatible endpoint base URL", () => {
    expect(resolveZaiCodingPlanBaseUrl("https://example.com/v4///")).toBe("https://example.com/v4");
  });
});
