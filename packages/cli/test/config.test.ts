import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("throws if ANTHROPIC_API_KEY not set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig()).toThrow("ANTHROPIC_API_KEY");
  });

  test("uses default model if DILIGENT_MODEL not set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.DILIGENT_MODEL;

    const config = loadConfig();
    expect(config.model.id).toBe("claude-sonnet-4-20250514");
    expect(config.model.provider).toBe("anthropic");
  });

  test("overrides model ID when DILIGENT_MODEL is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.DILIGENT_MODEL = "claude-opus-4-20250514";

    const config = loadConfig();
    expect(config.model.id).toBe("claude-opus-4-20250514");
    expect(config.model.provider).toBe("anthropic");
  });

  test("system prompt includes cwd and platform", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";

    const config = loadConfig();
    expect(config.systemPrompt).toContain(process.cwd());
    expect(config.systemPrompt).toContain(process.platform);
  });

  test("returns the API key from environment", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const config = loadConfig();
    expect(config.apiKey).toBe("sk-test-key");
  });
});
