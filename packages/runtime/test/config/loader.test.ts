// @summary Tests for config loading and merging behavior

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiligentConfig } from "@diligent/runtime/config";
import { loadDiligentConfig, mergeConfig } from "@diligent/runtime/config";

const TEST_ROOT = join(tmpdir(), `diligent-config-test-${Date.now()}`);
const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-5";
/** Separate HOME dir so global (~/.diligent/config.jsonc) != project (.diligent/config.jsonc) */
const TEST_HOME = join(TEST_ROOT, "home");
let origHome: string | undefined;
let origStorageNamespace: string | undefined;

/** Project config lives inside .diligent/ alongside sessions, knowledge, skills */
const projectConfigPath = (root: string, dirName = ".diligent") => join(root, dirName, "config.jsonc");

beforeEach(() => {
  origHome = process.env.HOME ?? process.env.USERPROFILE;
  origStorageNamespace = process.env.DILIGENT_STORAGE_NAMESPACE;
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  delete process.env.DILIGENT_STORAGE_NAMESPACE;
});

afterEach(async () => {
  if (origHome !== undefined) {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origHome;
  } else {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  }
  if (origStorageNamespace !== undefined) {
    process.env.DILIGENT_STORAGE_NAMESPACE = origStorageNamespace;
  } else {
    delete process.env.DILIGENT_STORAGE_NAMESPACE;
  }
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("mergeConfig", () => {
  it("override replaces scalar values", () => {
    const base: DiligentConfig = { model: "a" };
    const override: DiligentConfig = { model: "b" };
    const result = mergeConfig(base, override);
    expect(result.model).toBe("b");
  });

  it("deep merges objects", () => {
    const base: DiligentConfig = { provider: { anthropic: { apiKey: "old" } } };
    const override: DiligentConfig = {
      provider: { openai: { apiKey: "new" }, vertex: { project: "p", location: "l", endpoint: "openapi" } },
    };
    const result = mergeConfig(base, override);
    expect(result.provider?.anthropic?.apiKey).toBe("old");
    expect(result.provider?.openai?.apiKey).toBe("new");
    expect(result.provider?.vertex).toEqual({ project: "p", location: "l", endpoint: "openapi" });
  });

  it("deep merges nested provider auth settings without dropping siblings", () => {
    const base: DiligentConfig = {
      provider: {
        auth: { credentialsStore: "keyring" },
        anthropic: { apiKey: "old" },
      },
    };
    const override: DiligentConfig = {
      provider: {
        openai: { apiKey: "new" },
      },
    };

    const result = mergeConfig(base, override);

    expect(result.provider?.auth?.credentialsStore).toBe("keyring");
    expect(result.provider?.anthropic?.apiKey).toBe("old");
    expect(result.provider?.openai?.apiKey).toBe("new");
  });

  it("concatenates instructions with deduplication (D034)", () => {
    const base: DiligentConfig = { instructions: ["Use Bun", "Run tests"] };
    const override: DiligentConfig = { instructions: ["Run tests", "Use strict"] };
    const result = mergeConfig(base, override);
    expect(result.instructions).toEqual(["Use Bun", "Run tests", "Use strict"]);
  });

  it("undefined values in override are ignored", () => {
    const base: DiligentConfig = { model: "keep" };
    const override: DiligentConfig = {};
    const result = mergeConfig(base, override);
    expect(result.model).toBe("keep");
  });
});

describe("loadDiligentConfig", () => {
  it("returns default config when no files exist", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    const { config, sources } = await loadDiligentConfig(TEST_ROOT);
    expect(config.model).toBeUndefined();
    expect(config.planReminderIntervalTurns).toBe(6);
    expect(sources).toEqual([]);
  });

  it("loads project config from .diligent/config.jsonc", async () => {
    const configFile = projectConfigPath(TEST_ROOT);
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });
    await mkdir(join(TEST_HOME, ".diligent"), { recursive: true }); // ensure global dir exists but no config file
    await Bun.write(
      configFile,
      `{
        // Project config with JSONC comments
        "model": "claude-opus-4-20250514"
      }`,
    );

    const { config, sources } = await loadDiligentConfig(TEST_ROOT);
    expect(config.model).toEqual({ provider: "anthropic", modelId: "claude-opus-4-20250514" });
    expect(config.tools).toBeUndefined();
    expect(sources).toHaveLength(1);
  });

  it("loads config from the selected storage namespace", async () => {
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    const globalConfigFile = join(TEST_HOME, ".overdare", "config.jsonc");
    const projectConfigFile = projectConfigPath(TEST_ROOT, ".overdare");
    await mkdir(join(TEST_HOME, ".overdare"), { recursive: true });
    await mkdir(join(TEST_ROOT, ".overdare"), { recursive: true });
    await Bun.write(globalConfigFile, JSON.stringify({ model: TEST_ANTHROPIC_MODEL_ID }));
    await Bun.write(
      projectConfigFile,
      JSON.stringify({ model: { provider: "anthropic", modelId: "claude-opus-4-20250514" } }),
    );

    const { config, sources } = await loadDiligentConfig(TEST_ROOT);
    expect(config.model).toEqual({ provider: "anthropic", modelId: "claude-opus-4-20250514" });
    expect(sources).toContain(globalConfigFile);
    expect(sources).toContain(projectConfigFile);
  });

  it("uses tool settings from global config only", async () => {
    const globalConfigFile = join(TEST_HOME, ".diligent", "config.jsonc");
    const projectConfigFile = projectConfigPath(TEST_ROOT);
    await mkdir(join(TEST_HOME, ".diligent"), { recursive: true });
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });

    await Bun.write(
      globalConfigFile,
      JSON.stringify({
        tools: {
          web_action: false,
          builtin: { bash: false },
          plugins: [{ package: "@acme/global-tools", tools: { global_tool: false } }],
        },
      }),
    );
    await Bun.write(
      projectConfigFile,
      JSON.stringify({
        tools: {
          builtin: { read: false },
          plugins: [{ package: "@acme/project-tools", tools: { project_tool: false } }],
        },
      }),
    );

    const { config } = await loadDiligentConfig(TEST_ROOT);
    expect(config.tools).toEqual({
      web_action: false,
      builtin: { bash: false },
      plugins: [{ package: "@acme/global-tools", enabled: true, tools: { global_tool: false } }],
    });
  });

  it("deep merges skills overrides and returns validated layer snapshots", async () => {
    const globalConfigFile = join(TEST_HOME, ".diligent", "config.jsonc");
    const projectConfigFile = projectConfigPath(TEST_ROOT);
    await mkdir(join(TEST_HOME, ".diligent"), { recursive: true });
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });

    await Bun.write(
      globalConfigFile,
      JSON.stringify({
        skills: {
          enabled: false,
          paths: ["/global-skills"],
          overrides: { alpha: false, beta: false },
        },
      }),
    );
    await Bun.write(
      projectConfigFile,
      JSON.stringify({
        skills: {
          enabled: true,
          overrides: { alpha: true, gamma: false },
        },
      }),
    );

    const { config, layers } = await loadDiligentConfig(TEST_ROOT);

    expect(config.skills).toEqual({
      enabled: true,
      paths: ["/global-skills"],
      overrides: { alpha: true, beta: false, gamma: false },
    });
    expect(layers.global?.skills).toEqual({
      enabled: false,
      paths: ["/global-skills"],
      overrides: { alpha: false, beta: false },
    });
    expect(layers.project?.skills).toEqual({
      enabled: true,
      overrides: { alpha: true, gamma: false },
    });
  });

  it("deep merges agent overrides while retaining layer provenance", async () => {
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });
    await Bun.write(
      join(TEST_HOME, ".diligent", "config.jsonc"),
      JSON.stringify({
        agents: { enabled: true, paths: ["/global-agents"], overrides: { explore: false, reviewer: false } },
      }),
    );
    await Bun.write(
      projectConfigPath(TEST_ROOT),
      JSON.stringify({ agents: { overrides: { explore: true, auditor: false } } }),
    );

    const { config, layers } = await loadDiligentConfig(TEST_ROOT);

    expect(config.agents).toEqual({
      enabled: true,
      paths: ["/global-agents"],
      overrides: { explore: true, reviewer: false, auditor: false },
    });
    expect(layers.global?.agents?.overrides).toEqual({ explore: false, reviewer: false });
    expect(layers.project?.agents?.overrides).toEqual({ explore: true, auditor: false });
  });

  it("template substitution replaces {env:VAR}", async () => {
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });
    await Bun.write(projectConfigPath(TEST_ROOT), `{ "provider": { "anthropic": { "apiKey": "{env:MY_KEY}" } } }`);
    process.env.MY_KEY = "resolved-key";

    const { config } = await loadDiligentConfig(TEST_ROOT);
    expect(config.provider?.anthropic?.apiKey).toBe("resolved-key");

    delete process.env.MY_KEY;
  });

  it("template substitution with missing env var yields empty string", async () => {
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });
    await Bun.write(projectConfigPath(TEST_ROOT), `{ "systemPrompt": "prefix-{env:MISSING}-suffix" }`);

    const { config } = await loadDiligentConfig(TEST_ROOT);
    expect(config.systemPrompt).toBe("prefix--suffix");
  });

  it("invalid config file warns and is skipped", async () => {
    await mkdir(join(TEST_ROOT, ".diligent"), { recursive: true });
    await Bun.write(projectConfigPath(TEST_ROOT), `{ "unknownKey": true }`);

    const warnSpy = [] as string[];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);
    try {
      const { config, sources } = await loadDiligentConfig(TEST_ROOT);
      expect(sources).toEqual([]); // file was skipped
      expect(config.model).toBeUndefined();
      expect(warnSpy.length).toBeGreaterThan(0);
    } finally {
      console.warn = origWarn;
    }
  });
});
