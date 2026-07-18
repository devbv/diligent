// @summary Tests cross-platform path handling for Windows paths on any host
import { describe, expect, it } from "bun:test";
import { dirnameCrossPlatform, relativeCrossPlatform, resolveCrossPlatformPath } from "../../src/util/path";

const WIN_CWD_BACKSLASH = "C:\\Users\\alice\\git\\diligent";
const WIN_CWD_FORWARD = "C:/Users/alice/git/diligent";

describe("cross-platform path utilities", () => {
  it("resolves relative paths against Windows cwd using win32 semantics", () => {
    expect(resolveCrossPlatformPath(WIN_CWD_BACKSLASH, "packages\\runtime\\src")).toBe(
      "C:\\Users\\alice\\git\\diligent\\packages\\runtime\\src",
    );
  });

  it("resolves relative paths against extended-length Windows cwd", () => {
    expect(resolveCrossPlatformPath("\\\\?\\C:\\Users\\alice\\git\\diligent", "packages/runtime/src")).toBe(
      "C:\\Users\\alice\\git\\diligent\\packages\\runtime\\src",
    );
  });

  it("computes dirname for Windows paths on non-Windows hosts", () => {
    expect(dirnameCrossPlatform("C:/Users/alice/git/diligent/packages/runtime/src/index.ts")).toBe(
      "C:\\Users\\alice\\git\\diligent\\packages\\runtime\\src",
    );
  });

  it("computes relative paths for Windows paths on non-Windows hosts", () => {
    expect(relativeCrossPlatform(WIN_CWD_FORWARD, "C:/Users/alice/git/diligent/packages/runtime/src")).toBe(
      "packages\\runtime\\src",
    );
  });
});
