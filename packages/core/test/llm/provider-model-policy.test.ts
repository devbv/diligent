// @summary Tests provider-level default model policy outside model cards
import { describe, expect, it } from "bun:test";
import { resolveModel } from "../../src/llm/models";
import { getDefaultModelRef, PROVIDER_MODEL_POLICIES } from "../../src/llm/provider-model-policy";
import type { ProviderName } from "../../src/llm/types";

describe("provider model policy", () => {
  it("resolves defaults that belong to the requested provider", () => {
    for (const provider of Object.keys(PROVIDER_MODEL_POLICIES) as ProviderName[]) {
      expect(resolveModel(getDefaultModelRef(provider)).provider).toBe(provider);
    }
  });
});
