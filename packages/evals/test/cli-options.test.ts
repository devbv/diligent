// @summary Tests eval suite and optional investigation filters

import { describe, expect, test } from "bun:test";
import { defaultReportPath, selectCoreTasks, selectRuntimeTasks } from "../src/cli";
import { parseCliOptions } from "../src/cli-options";
import { CORE_EVAL_TASKS } from "../src/tasks/core";
import { RUNTIME_EVAL_TASKS } from "../src/tasks/runtime";

describe("parseCliOptions", () => {
  test("selects the complete core suite by default", () => {
    expect(parseCliOptions(["core"])).toEqual({ suite: "core", help: false });
  });

  test("accepts the runtime suite selector", () => {
    expect(parseCliOptions(["runtime"])).toEqual({ suite: "runtime", help: false });
  });

  test("uses suite-specific default report paths", () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    expect(defaultReportPath("core", now)).toContain("core-2026-07-18T00-00-00.000Z.json");
    expect(defaultReportPath("runtime", now)).toContain("runtime-2026-07-18T00-00-00.000Z.json");
  });

  test("allows a reconstruction seed", () => {
    expect(parseCliOptions(["core", "--seed", "recorded-seed"])).toMatchObject({
      seed: "recorded-seed",
    });
  });

  test("rejects the removed canonical option", () => {
    expect(() => parseCliOptions(["core", "--canonical"])).toThrow('Unknown eval option "--canonical"');
  });

  test("rejects effort overrides because eval effort is fixed", () => {
    expect(() => parseCliOptions(["core", "--effort", "high"])).toThrow('Unknown eval option "--effort"');
  });

  test("accepts provider and task filters", () => {
    expect(parseCliOptions(["core", "--provider", "anthropic", "--task", "single-tool"])).toMatchObject({
      provider: "anthropic",
      task: "single-tool",
    });
  });

  test("accepts Gemini only when explicitly selected", () => {
    expect(parseCliOptions(["core", "--provider", "gemini"])).toMatchObject({
      provider: "gemini",
    });
  });
});

describe("task selection", () => {
  test("selects every task when no task filter is given", () => {
    expect(selectCoreTasks()).toHaveLength(CORE_EVAL_TASKS.length);
    expect(selectRuntimeTasks()).toHaveLength(RUNTIME_EVAL_TASKS.length);
  });

  test("selects exactly one requested task", () => {
    expect(selectCoreTasks("image-tool-result").map((task) => task.id)).toEqual(["image-tool-result"]);
    expect(selectRuntimeTasks("file-roundtrip").map((task) => task.id)).toEqual(["file-roundtrip"]);
  });
});
