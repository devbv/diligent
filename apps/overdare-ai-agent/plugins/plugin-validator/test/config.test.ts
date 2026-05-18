// @summary Verifies validator plugin config loads from the Overdare storage namespace.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadConfigWithFreshModule() {
  const module = await import(`../src/config.ts?test=${Date.now()}-${Math.random()}`);
  return module.loadOverdareConfig() as { luauLspPath?: string; typesPath?: string };
}

describe("plugin-validator config", () => {
  const originalEnv = { ...process.env };
  let homeDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    homeDir = join(tmpdir(), `plugin-validator-config-${process.pid}-${Date.now()}`);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test("loads overdare.jsonc from ~/.overdare before legacy ~/.diligent", async () => {
    mkdirSync(join(homeDir, ".overdare"), { recursive: true });
    mkdirSync(join(homeDir, ".diligent"), { recursive: true });
    writeFileSync(
      join(homeDir, ".overdare", "overdare.jsonc"),
      JSON.stringify({ luauLspPath: "/overdare/luau-lsp", typesPath: "/overdare/types.d.lua" }),
    );
    writeFileSync(
      join(homeDir, ".diligent", "overdare.jsonc"),
      JSON.stringify({ luauLspPath: "/legacy/luau-lsp", typesPath: "/legacy/types.d.lua" }),
    );

    expect(await loadConfigWithFreshModule()).toEqual({
      luauLspPath: "/overdare/luau-lsp",
      typesPath: "/overdare/types.d.lua",
    });
  });

  test("falls back to legacy ~/.diligent/overdare.jsonc", async () => {
    mkdirSync(join(homeDir, ".diligent"), { recursive: true });
    writeFileSync(
      join(homeDir, ".diligent", "overdare.jsonc"),
      JSON.stringify({ luauLspPath: "/legacy/luau-lsp", typesPath: "/legacy/types.d.lua" }),
    );

    expect(await loadConfigWithFreshModule()).toEqual({
      luauLspPath: "/legacy/luau-lsp",
      typesPath: "/legacy/types.d.lua",
    });
  });
});
