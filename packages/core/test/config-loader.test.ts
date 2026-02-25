import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiligentConfig, mergeConfig } from "../src/config/loader";
import type { DiligentConfig } from "../src/config/schema";

const TEST_ROOT = join(tmpdir(), `diligent-config-test-${Date.now()}`);

afterEach(async () => {
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
    const override: DiligentConfig = { provider: { openai: { apiKey: "new" } } };
    const result = mergeConfig(base, override);
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
    const { config, sources } = await loadDiligentConfig(TEST_ROOT, {});
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(sources).toEqual([]);
  });

  it("loads project config from diligent.jsonc", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    await Bun.write(
      join(TEST_ROOT, "diligent.jsonc"),
      `{
        // Project config with JSONC comments
        "model": "claude-opus-4-20250514",
        "maxTurns": 50
      }`,
    );

    const { config, sources } = await loadDiligentConfig(TEST_ROOT, {});
    expect(config.model).toBe("claude-opus-4-20250514");
    expect(config.maxTurns).toBe(50);
    expect(sources).toHaveLength(1);
  });

  it("env DILIGENT_MODEL overrides project config", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    await Bun.write(join(TEST_ROOT, "diligent.jsonc"), `{ "model": "from-file" }`);

    const { config } = await loadDiligentConfig(TEST_ROOT, { DILIGENT_MODEL: "from-env" });
    expect(config.model).toBe("from-env");
  });

  it("env ANTHROPIC_API_KEY sets provider.anthropic.apiKey", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    const { config } = await loadDiligentConfig(TEST_ROOT, { ANTHROPIC_API_KEY: "sk-test" });
    expect(config.provider?.anthropic?.apiKey).toBe("sk-test");
  });

  it("template substitution replaces {env:VAR}", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    await Bun.write(join(TEST_ROOT, "diligent.jsonc"), `{ "provider": { "anthropic": { "apiKey": "{env:MY_KEY}" } } }`);

    const { config } = await loadDiligentConfig(TEST_ROOT, { MY_KEY: "resolved-key" });
    expect(config.provider?.anthropic?.apiKey).toBe("resolved-key");
  });

  it("template substitution with missing env var yields empty string", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    await Bun.write(join(TEST_ROOT, "diligent.jsonc"), `{ "systemPrompt": "prefix-{env:MISSING}-suffix" }`);

    const { config } = await loadDiligentConfig(TEST_ROOT, {});
    expect(config.systemPrompt).toBe("prefix--suffix");
  });

  it("invalid config file warns and is skipped", async () => {
    await mkdir(TEST_ROOT, { recursive: true });
    await Bun.write(join(TEST_ROOT, "diligent.jsonc"), `{ "unknownKey": true }`);

    const warnSpy = [] as string[];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);
    try {
      const { config, sources } = await loadDiligentConfig(TEST_ROOT, {});
      expect(sources).toEqual([]); // file was skipped
      expect(config.model).toBe("claude-sonnet-4-20250514"); // defaults
      expect(warnSpy.length).toBeGreaterThan(0);
    } finally {
      console.warn = origWarn;
    }
  });
});
