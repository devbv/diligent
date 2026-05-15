// @summary Tests for config loading and file operations
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenSections } from "@diligent/runtime";
import { loadConfig } from "../src/config";

const TEST_ROOT = join(tmpdir(), `diligent-cli-config-test-${Date.now()}`);
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  process.env.HOME = TEST_ROOT;
});

afterEach(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("loadConfig", () => {
  test("loads without API key (deferred to call time)", async () => {
    const dir = join(TEST_ROOT, "no-key");
    await mkdir(dir, { recursive: true });

    const config = await loadConfig(dir);
    expect(config.providerManager.hasKeyFor("anthropic")).toBe(false);
    expect(config.apiKey).toBe("");
  });

  test("uses default model when not configured", async () => {
    const dir = join(TEST_ROOT, "defaults");
    await mkdir(dir, { recursive: true });

    const config = await loadConfig(dir);
    expect(config.model.id).toBe("gemini-3.1-pro-preview");
    expect(config.model.provider).toBe("gemini");
  });

  test("loads config from config.jsonc", async () => {
    const dir = join(TEST_ROOT, "jsonc");
    await mkdir(join(dir, ".diligent"), { recursive: true });
    await Bun.write(
      join(dir, ".diligent", "config.jsonc"),
      `{
        // Project config
        "model": "claude-haiku-3-20250307",
        "provider": { "anthropic": { "apiKey": "sk-test" } }
      }`,
    );

    const config = await loadConfig(dir);
    expect(config.model.id).toBe("claude-haiku-3-20250307");
    expect(config.sources.length).toBeGreaterThan(0);
  });

  test("injects AGENTS.md into system prompt", async () => {
    const dir = join(TEST_ROOT, "agents-md");
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, ".git")); // Stop findUp here
    await Bun.write(join(dir, "AGENTS.md"), "# Rules\nAlways use Bun.");

    const config = await loadConfig(dir);
    const flat = flattenSections(config.systemPrompt);
    expect(flat).toContain("Always use Bun.");
  });

  test("system prompt includes cwd and platform", async () => {
    const dir = join(TEST_ROOT, "sys-prompt");
    await mkdir(dir, { recursive: true });

    const config = await loadConfig(dir);
    const flat = flattenSections(config.systemPrompt);
    expect(flat).toContain(dir);
    expect(flat).toContain(process.platform);
  });

  test("config apiKey is ignored — only auth.json provides keys", async () => {
    const dir = join(TEST_ROOT, "config-ignored");
    await mkdir(dir, { recursive: true });

    // config.jsonc has apiKey but it should be ignored
    await mkdir(join(dir, ".diligent"), { recursive: true });
    await Bun.write(
      join(dir, ".diligent", "config.jsonc"),
      `{ "provider": { "anthropic": { "apiKey": "config-key" } } }`,
    );

    const config = await loadConfig(dir);
    // Config apiKey is not read — no auth.jsonc means no key
    expect(config.providerManager.hasKeyFor("anthropic")).toBe(false);
  });

  test("auth.jsonc is the sole source of API keys", async () => {
    const dir = join(TEST_ROOT, "auth-sole");
    await mkdir(dir, { recursive: true });

    // auth.jsonc provides the key
    const authDir = join(TEST_ROOT, ".diligent");
    await mkdir(authDir, { recursive: true });
    await Bun.write(join(authDir, "auth.jsonc"), JSON.stringify({ anthropic: "auth-key" }));

    const config = await loadConfig(dir);
    expect(config.providerManager.getApiKey("anthropic")).toBe("auth-key");
  });

  test("auth.jsonc adds keys not present in config", async () => {
    const dir = join(TEST_ROOT, "auth-add");
    await mkdir(dir, { recursive: true });

    // No config.jsonc — no keys in config
    const authDir = join(TEST_ROOT, ".diligent");
    await mkdir(authDir, { recursive: true });
    await Bun.write(join(authDir, "auth.jsonc"), JSON.stringify({ openai: "sk-openai-from-auth" }));

    const config = await loadConfig(dir);
    expect(config.providerManager.hasKeyFor("openai")).toBe(true);
    expect(config.providerManager.getApiKey("openai")).toBe("sk-openai-from-auth");
  });
});
