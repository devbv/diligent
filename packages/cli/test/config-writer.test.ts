// @summary Tests for config file writing and API key management

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveApiKey } from "../src/config-writer";

const TEST_ROOT = join(tmpdir(), `diligent-config-writer-test-${Date.now()}`);
const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("saveApiKey", () => {
  test("creates file when it does not exist", async () => {
    const configPath = join(TEST_ROOT, "new-dir", "config.jsonc");

    await saveApiKey("anthropic", "sk-ant-test-key", configPath);

    const content = await Bun.file(configPath).text();
    expect(content).toContain("sk-ant-test-key");
    expect(content).toContain("anthropic");
  });

  test("updates existing file", async () => {
    const dir = join(TEST_ROOT, "existing");
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "config.jsonc");

    // Write initial content with a comment
    await Bun.write(
      configPath,
      `{
	// My config
	"model": "${TEST_ANTHROPIC_MODEL_ID}"
}`,
    );

    await saveApiKey("openai", "sk-openai-key", configPath);

    const content = await Bun.file(configPath).text();
    expect(content).toContain("sk-openai-key");
    expect(content).toContain("openai");
    // Original content preserved
    expect(content).toContain(TEST_ANTHROPIC_MODEL_ID);
    expect(content).toContain("My config");
  });

  test("saves anthropic key under correct path", async () => {
    const dir = join(TEST_ROOT, "anthropic");
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "config.jsonc");

    await saveApiKey("anthropic", "sk-ant-12345", configPath);

    const content = await Bun.file(configPath).text();
    // Should have provider.anthropic.apiKey structure
    expect(content).toContain('"provider"');
    expect(content).toContain('"anthropic"');
    expect(content).toContain('"apiKey"');
    expect(content).toContain("sk-ant-12345");
  });

  test("saves openai key under correct path", async () => {
    const dir = join(TEST_ROOT, "openai");
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "config.jsonc");

    await saveApiKey("openai", "sk-openai-67890", configPath);

    const content = await Bun.file(configPath).text();
    expect(content).toContain('"provider"');
    expect(content).toContain('"openai"');
    expect(content).toContain("sk-openai-67890");
  });

  test("can save keys for both providers", async () => {
    const dir = join(TEST_ROOT, "both");
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "config.jsonc");

    await saveApiKey("anthropic", "sk-ant-aaa", configPath);
    await saveApiKey("openai", "sk-openai-bbb", configPath);

    const content = await Bun.file(configPath).text();
    expect(content).toContain("sk-ant-aaa");
    expect(content).toContain("sk-openai-bbb");
  });
});
