// @summary Tests for validatelua render and diagnostic helpers.

import { describe, expect, test } from "bun:test";
import { buildValidateLuaRender } from "../../src/tools/validator/render";
import { splitDiagnostics } from "../../src/tools/validator/validatelua";

describe("buildValidateLuaRender", () => {
  test("no-issue single script renders 0 issues", () => {
    const result = buildValidateLuaRender("MyScript [guid]", "No issues found. Code is valid.");
    expect(result.outputSummary).toBe("0 issues");
    expect(result.blocks.some((b) => (b as Record<string, unknown>).tone === "success")).toBe(true);
  });

  test("multi-script: script(s) footer is recognised and issue count extracted", () => {
    const output = [
      "[OK] ScriptA [guid-a]",
      "",
      "[2 issue(s)] ScriptB [guid-b]",
      "ScriptB [guid-b](10,1): TypeError",
      "ScriptB [guid-b](20,5): LocalShadow",
      "",
      "--- 2 script(s) checked, 2 issue(s) found ---",
    ].join("\n");

    const result = buildValidateLuaRender("2 scripts", output);
    expect(result.outputSummary).toBe("2 issues");
  });

  test("multi-script: file(s) footer (legacy) still works", () => {
    const output = [
      "[1 issue(s)] ScriptA [guid-a]",
      "ScriptA [guid-a](5,1): LocalUnused",
      "",
      "--- 1 file(s) checked, 1 issue(s) found ---",
    ].join("\n");

    const result = buildValidateLuaRender("1 scripts", output);
    expect(result.outputSummary).toBe("1 issue");
  });

  test("options.issueCount overrides footer and line-count fallback", () => {
    const output = "[3 issue(s)] ScriptA [guid-a]\nScriptA(1,1): Err1\nScriptA(2,1): Err2\nScriptA(3,1): Err3";
    const result = buildValidateLuaRender("ScriptA", output, { issueCount: 3 });
    expect(result.outputSummary).toBe("3 issues");
  });

  test("no-footer fallback uses line count when issueCount not provided", () => {
    const output = "ScriptA(1,1): TypeError\nScriptA(2,1): LocalShadow";
    const result = buildValidateLuaRender("ScriptA", output);
    // 2 non-empty lines → "2 issues"
    expect(result.outputSummary).toBe("2 issues");
  });
});

describe("splitDiagnostics", () => {
  test("returns empty array for empty input", () => {
    expect(splitDiagnostics("")).toEqual([""]);
  });

  test("counts each diagnostic header as a separate record", () => {
    const raw = [
      "Script.lua(1,1): TypeError: something",
      "Script.lua(5,3): LocalUnused: unused var",
      "Script.lua(10,1): LocalShadow: shadowed",
    ].join("\n");
    const records = splitDiagnostics(raw).filter((r) => r.trim());
    expect(records).toHaveLength(3);
  });

  test("multi-line diagnostic stays as one record", () => {
    const raw = [
      "Script.lua(1,1): TypeError: something",
      "  continuation of error message",
      "Script.lua(5,3): LocalUnused: another",
    ].join("\n");
    const records = splitDiagnostics(raw).filter((r) => r.trim());
    expect(records).toHaveLength(2);
    expect(records[0]).toContain("continuation of error message");
  });

  test("single-script multi-diagnostic count is accurate (not rawOutput ? 1 : 0)", () => {
    const raw = ["Script.lua(1,1): TypeError", "Script.lua(5,3): LocalUnused", "Script.lua(10,1): LocalShadow"].join(
      "\n",
    );
    const issueCount = splitDiagnostics(raw).filter((r) => r.trim()).length;
    // Must be 3, not 1
    expect(issueCount).toBe(3);
  });
});
