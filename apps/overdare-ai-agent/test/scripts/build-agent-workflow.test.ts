// @summary Guards release workflows that package the dedicated OVERDARE MCP router beside the Studio launcher.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");

describe("OVERDARE launcher workflow artifacts", () => {
  test.each([
    [".github/workflows/build-agent-exe.yml", `overdare-mcp-windows-x64-\${LABEL}.exe`],
    [".github/workflows/release.yml", `overdare-mcp-\${RELEASE_ENV}-\${VERSION}-windows-x64.exe`],
  ])("%s packages the dedicated router executable", (relativePath, artifactName) => {
    const workflow = readFileSync(resolve(ROOT, relativePath), "utf8");

    expect(workflow).toContain("target/release/overdare-mcp.exe");
    expect(workflow).toContain(artifactName);
  });
});
