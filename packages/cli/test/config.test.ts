import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const TEST_ROOT = join(tmpdir(), `diligent-cli-config-test-${Date.now()}`);

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("loadConfig", () => {
  test("throws if no API key available", async () => {
    const dir = join(TEST_ROOT, "no-key");
    await mkdir(dir, { recursive: true });

    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(loadConfig(dir)).rejects.toThrow("ANTHROPIC_API_KEY");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  test("uses default model when not configured", async () => {
    const dir = join(TEST_ROOT, "defaults");
    await mkdir(dir, { recursive: true });

    const origKey = process.env.ANTHROPIC_API_KEY;
    const origModel = process.env.DILIGENT_MODEL;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.DILIGENT_MODEL;
    try {
      const config = await loadConfig(dir);
      expect(config.model.id).toBe("claude-sonnet-4-20250514");
      expect(config.model.provider).toBe("anthropic");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origModel) process.env.DILIGENT_MODEL = origModel;
    }
  });

  test("DILIGENT_MODEL env overrides default", async () => {
    const dir = join(TEST_ROOT, "model-env");
    await mkdir(dir, { recursive: true });

    const origKey = process.env.ANTHROPIC_API_KEY;
    const origModel = process.env.DILIGENT_MODEL;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.DILIGENT_MODEL = "claude-opus-4-20250514";
    try {
      const config = await loadConfig(dir);
      expect(config.model.id).toBe("claude-opus-4-20250514");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origModel) process.env.DILIGENT_MODEL = origModel;
      else delete process.env.DILIGENT_MODEL;
    }
  });

  test("loads config from diligent.jsonc", async () => {
    const dir = join(TEST_ROOT, "jsonc");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, "diligent.jsonc"),
      `{
        // Project config
        "model": "claude-haiku-3-20250307",
        "maxTurns": 10
      }`,
    );

    const origKey = process.env.ANTHROPIC_API_KEY;
    const origModel = process.env.DILIGENT_MODEL;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.DILIGENT_MODEL;
    try {
      const config = await loadConfig(dir);
      expect(config.model.id).toBe("claude-haiku-3-20250307");
      expect(config.diligent.maxTurns).toBe(10);
      expect(config.sources.length).toBeGreaterThan(0);
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origModel) process.env.DILIGENT_MODEL = origModel;
    }
  });

  test("injects CLAUDE.md into system prompt", async () => {
    const dir = join(TEST_ROOT, "claude-md");
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, ".git")); // Stop findUp here
    await Bun.write(join(dir, "CLAUDE.md"), "# Rules\nAlways use Bun.");

    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const config = await loadConfig(dir);
      expect(config.systemPrompt).toContain("Always use Bun.");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("system prompt includes cwd and platform", async () => {
    const dir = join(TEST_ROOT, "sys-prompt");
    await mkdir(dir, { recursive: true });

    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const config = await loadConfig(dir);
      expect(config.systemPrompt).toContain(dir);
      expect(config.systemPrompt).toContain(process.platform);
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
