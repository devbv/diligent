// @summary Tests the platform assets staged into OVERDARE runtime release bundles.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageSidecarAssets, stageWebClient } from "../../../../scripts/build-overdare-runtime-bundle";

const ROOT = resolve(import.meta.dir, "../../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OVERDARE runtime bundle assets", () => {
  test("stages the built client index and nested assets at the installed dist/client path", () => {
    const clientDist = mkdtempSync(join(tmpdir(), "overdare-runtime-client-"));
    const stageDir = mkdtempSync(join(tmpdir(), "overdare-runtime-stage-"));
    temporaryDirectories.push(clientDist, stageDir);
    mkdirSync(join(clientDist, "assets"), { recursive: true });
    writeFileSync(join(clientDist, "index.html"), "<!doctype html><title>OVERDARE</title>");
    writeFileSync(join(clientDist, "assets", "app-hash.js"), "console.log('client')");

    stageWebClient(clientDist, stageDir);

    expect(readFileSync(join(stageDir, "dist", "client", "index.html"), "utf8")).toContain("OVERDARE");
    expect(existsSync(join(stageDir, "dist", "client", "assets", "app-hash.js"))).toBe(true);
  });

  test("stages the vendored Luau interpreter for Windows x64", () => {
    const stageDir = mkdtempSync(join(tmpdir(), "overdare-runtime-assets-"));
    temporaryDirectories.push(stageDir);

    stageSidecarAssets(
      {
        id: "windows-x64",
        bunTarget: "bun-windows-x64",
        ext: ".exe",
      },
      stageDir,
    );

    const stagedLuau = readFileSync(join(stageDir, "assets", "bin", "luau.exe"));
    const vendoredLuau = readFileSync(
      join(ROOT, "apps", "overdare-ai-agent", "sidecar", "vendor", "luau", "0.723", "win32", "luau.exe"),
    );
    expect(stagedLuau).toEqual(vendoredLuau);
  });
});
