// @summary Verifies Studio RPC plugin config loads from the Overdare storage namespace.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadConfigWithFreshModule() {
  const module = await import(`../src/config.ts?test=${Date.now()}-${Math.random()}`);
  return module.loadOverdareConfig() as { host?: string; port?: number };
}

describe("plugin-studiorpc config", () => {
  const originalEnv = { ...process.env };
  let homeDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    homeDir = join(tmpdir(), `plugin-studiorpc-config-${process.pid}-${Date.now()}`);
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
    writeFileSync(join(homeDir, ".overdare", "overdare.jsonc"), JSON.stringify({ host: "overdare-host", port: 1001 }));
    writeFileSync(join(homeDir, ".diligent", "overdare.jsonc"), JSON.stringify({ host: "legacy-host", port: 2002 }));

    expect(await loadConfigWithFreshModule()).toEqual({ host: "overdare-host", port: 1001 });
  });

  test("falls back to legacy ~/.diligent/overdare.jsonc", async () => {
    mkdirSync(join(homeDir, ".diligent"), { recursive: true });
    writeFileSync(join(homeDir, ".diligent", "overdare.jsonc"), JSON.stringify({ host: "legacy-host", port: 2002 }));

    expect(await loadConfigWithFreshModule()).toEqual({ host: "legacy-host", port: 2002 });
  });
});
