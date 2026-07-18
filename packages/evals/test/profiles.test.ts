// @summary Tests default profile selection and early credential validation

import { describe, expect, test } from "bun:test";
import type { EvalCliOptions } from "../src/cli-options";
import { DEFAULT_PROFILES, resolveSelectedProfiles, validateCredentials } from "../src/profiles";

const BASE_OPTIONS: EvalCliOptions = { suite: "core", help: false };

describe("eval profiles", () => {
  test("default mode returns both profiles", () => {
    expect(resolveSelectedProfiles(BASE_OPTIONS)).toEqual([...DEFAULT_PROFILES]);
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
});
