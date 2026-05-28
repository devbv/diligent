// @summary Tests OVERDARE Studio bundled validator tool provider assembly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioBundledToolProviders } from "../../src/tools";

async function loadConfigWithFreshModule() {
  const module = await import(`../../src/tools/validator/config.ts?test=${Date.now()}-${Math.random()}`);
  return module.loadOverdareConfig() as { luauLspPath?: string; typesPath?: string };
}

describe("createValidatorToolProvider", () => {
  test("creates bundled validator tool with Zod schema and plugin supersession", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/validator-tools");

    expect(provider).toBeDefined();
    expect(provider!.supersedesPluginPackages).toContain("@overdare/plugin-validator");

    const tools = await provider!.createTools({ cwd: "/tmp/project" });
    const validateLuaTool = tools.find((candidate) => candidate.name === "validatelua");

    expect(validateLuaTool).toBeDefined();
    expect(validateLuaTool!.supportParallel).toBe(false);
    expect(() => validateLuaTool!.parameters.parse({ targetGuids: ["script-guid"] })).not.toThrow();
    expect(() => validateLuaTool!.parameters.parse({})).not.toThrow();
  });

  test("preserves approval rejection behavior without reading level files", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/validator-tools")!;
    const tools = await provider.createTools({
      cwd: "/tmp/project",
      host: {
        approve: async () => "reject",
      },
    });
    const validateLuaTool = tools.find((candidate) => candidate.name === "validatelua")!;

    const result = await validateLuaTool.execute(
      { targetGuids: ["script-guid"] },
      { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
    );

    expect(result).toEqual({ output: "[Rejected by user]", metadata: { error: true } });
  });
});

describe("validator config", () => {
  const originalEnv = { ...process.env };
  let homeDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    homeDir = join(tmpdir(), `sidecar-validator-config-${process.pid}-${Date.now()}`);
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
