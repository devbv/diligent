// @summary Tests canonical profile selection and early credential validation

import { describe, expect, test } from "bun:test";
import type { EvalCliOptions } from "../src/cli-options";
import { CANONICAL_PROFILES, resolveSelectedProfiles, validateCredentials } from "../src/profiles";

const BASE_OPTIONS: EvalCliOptions = { suite: "core", canonical: false, help: false };

describe("eval profiles", () => {
  test("canonical mode returns the exact two profiles", () => {
    expect(resolveSelectedProfiles({ ...BASE_OPTIONS, canonical: true })).toEqual([...CANONICAL_PROFILES]);
  });

  test("a provider filter selects one canonical provider profile", () => {
    expect(resolveSelectedProfiles({ ...BASE_OPTIONS, provider: "anthropic" })).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
    ]);
  });

  test("fails before execution when a selected credential is missing", () => {
    expect(() =>
      validateCredentials(CANONICAL_PROFILES, { ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "" }),
    ).toThrow("OPENAI_API_KEY is required");
  });

  test("a filtered profile requires only its own credential", () => {
    expect(() =>
      validateCredentials([{ provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" }], {
        ANTHROPIC_API_KEY: "anthropic",
      }),
    ).not.toThrow();
  });
});
