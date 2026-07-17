// @summary Tests canonical and investigation CLI selection rules

import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "../src/cli-options";

describe("parseCliOptions", () => {
  test("accepts complete canonical mode", () => {
    expect(parseCliOptions(["core", "--canonical"])).toMatchObject({ suite: "core", canonical: true });
  });

  test("allows a reconstruction seed in canonical mode", () => {
    expect(parseCliOptions(["core", "--canonical", "--seed", "recorded-seed"])).toMatchObject({
      canonical: true,
      seed: "recorded-seed",
    });
  });

  test("rejects filters in canonical mode", () => {
    expect(() => parseCliOptions(["core", "--canonical", "--provider", "openai"])).toThrow(
      "Canonical mode does not allow provider, task, or model overrides",
    );
  });

  test("rejects effort overrides because eval effort is fixed", () => {
    expect(() => parseCliOptions(["core", "--effort", "high"])).toThrow('Unknown eval option "--effort"');
  });

  test("labels filtered execution non-canonical", () => {
    expect(parseCliOptions(["core", "--provider", "anthropic", "--task", "single-tool"])).toMatchObject({
      canonical: false,
      provider: "anthropic",
      task: "single-tool",
    });
  });
});
