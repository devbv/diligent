// @summary Tests for DiligentConfig schema validation
import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, type DiligentConfig, DiligentConfigSchema } from "@diligent/runtime/config";

describe("DiligentConfigSchema", () => {
  it("accepts a valid minimal config", () => {
    const result = DiligentConfigSchema.safeParse({
      model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object", () => {
    const result = DiligentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full config with all fields", () => {
    const full: DiligentConfig = {
      $schema: "https://example.com/schema.json",
      model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      provider: {
        anthropic: { apiKey: "sk-test", baseUrl: "https://api.anthropic.com" },
        openai: { apiKey: "sk-oai", baseUrl: "https://api.openai.com" },
      },
      maxRetries: 3,
      systemPrompt: "You are helpful.",
      instructions: ["Use TypeScript", "Run tests"],
      session: { autoResume: true },
      knowledge: { enabled: true, nudgeInterval: 5, injectionBudget: 4096, maxItems: 50 },
      compaction: { enabled: true, reservePercent: 20, keepRecentTokens: 2048, timeoutMs: 180000 },
    };
    const result = DiligentConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys (strict mode)", () => {
    const result = DiligentConfigSchema.safeParse({
      model: { provider: "anthropic", modelId: "test" },
      unknownKey: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid model type", () => {
    const result = DiligentConfigSchema.safeParse({ model: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid baseUrl", () => {
    const result = DiligentConfigSchema.safeParse({ provider: { anthropic: { baseUrl: "not-a-url" } } });
    expect(result.success).toBe(false);
  });

  it("accepts valid mode values", () => {
    for (const mode of ["default", "plan", "execute"]) {
      const result = DiligentConfigSchema.safeParse({ mode });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid mode value", () => {
    const result = DiligentConfigSchema.safeParse({ mode: "invalid" });
    expect(result.success).toBe(false);
  });

  it("mode is optional", () => {
    const result = DiligentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBeUndefined();
    }
  });
});

describe("DEFAULT_CONFIG", () => {
  it("validates against schema", () => {
    const result = DiligentConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it("accepts sync and async hook command modes", () => {
    const result = DiligentConfigSchema.safeParse({
      hooks: {
        UserPromptSubmit: [{ type: "command", command: "echo start", mode: "sync" }],
        Stop: [{ type: "command", command: "echo stop", mode: "async" }],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid hook command modes", () => {
    const result = DiligentConfigSchema.safeParse({
      hooks: {
        UserPromptSubmit: [{ type: "command", command: "echo start", mode: "background" }],
      },
    });

    expect(result.success).toBe(false);
  });
});
