// @summary Tests default profile selection and early credential validation

import { describe, expect, test } from "bun:test";
import { getDefaultModelRef } from "@diligent/core/model-registry";
import type { EvalCliOptions } from "../src/cli-options";
import { DEFAULT_PROFILES, isEvalProvider, resolveSelectedProfiles, validateCredentials } from "../src/profiles";

const BASE_OPTIONS: EvalCliOptions = { suite: "core", help: false };

describe("eval profiles", () => {
  test("default mode returns both profiles", () => {
    expect(resolveSelectedProfiles(BASE_OPTIONS)).toEqual([...DEFAULT_PROFILES]);
    expect(DEFAULT_PROFILES.map((profile) => profile.provider)).toEqual(["openai", "anthropic"]);
  });

  test("a provider filter selects one default provider profile", () => {
    expect(resolveSelectedProfiles({ ...BASE_OPTIONS, provider: "anthropic" })).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
    ]);
  });

  test("a model override still uses medium effort", () => {
    expect(resolveSelectedProfiles({ ...BASE_OPTIONS, model: "claude-sonnet-5" })).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
    ]);
  });

  test("an explicit Gemini filter selects the centrally configured Gemini default", () => {
    const defaultModel = getDefaultModelRef("gemini").modelId;
    expect(resolveSelectedProfiles({ ...BASE_OPTIONS, provider: "gemini" })).toEqual([
      { provider: "gemini", model: defaultModel, effort: "medium" },
    ]);
  });

  test("an explicit Gemini model override is supported", () => {
    expect(resolveSelectedProfiles({ ...BASE_OPTIONS, model: "gemini-3.5-flash-lite" })).toEqual([
      { provider: "gemini", model: "gemini-3.5-flash-lite", effort: "medium" },
    ]);
    expect(isEvalProvider("gemini")).toBe(true);
  });

  test("fails before execution when a selected credential is missing", () => {
    expect(() => validateCredentials(DEFAULT_PROFILES, { ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "" })).toThrow(
      "OPENAI_API_KEY is required",
    );
  });

  test("a filtered profile requires only its own credential", () => {
    expect(() =>
      validateCredentials([{ provider: "anthropic", model: "claude-sonnet-5", effort: "medium" }], {
        ANTHROPIC_API_KEY: "anthropic",
      }),
    ).not.toThrow();
  });

  test("a Gemini profile requires only GEMINI_API_KEY", () => {
    const profiles = resolveSelectedProfiles({ ...BASE_OPTIONS, provider: "gemini" });
    expect(() => validateCredentials(profiles, { GEMINI_API_KEY: "gemini" })).not.toThrow();
    expect(() => validateCredentials(profiles, { GEMINI_API_KEY: " " })).toThrow("GEMINI_API_KEY is required");
  });
});
