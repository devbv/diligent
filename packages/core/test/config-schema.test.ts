import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, type DiligentConfig, DiligentConfigSchema } from "../src/config/schema";

describe("DiligentConfigSchema", () => {
  it("accepts a valid minimal config", () => {
    const result = DiligentConfigSchema.safeParse({ model: "claude-sonnet-4-20250514" });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object", () => {
    const result = DiligentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full config with all fields", () => {
    const full: DiligentConfig = {
      $schema: "https://example.com/schema.json",
      model: "claude-sonnet-4-20250514",
      provider: {
        anthropic: { apiKey: "sk-test", baseUrl: "https://api.anthropic.com" },
        openai: { apiKey: "sk-oai", baseUrl: "https://api.openai.com" },
      },
      maxTurns: 50,
      maxRetries: 3,
      systemPrompt: "You are helpful.",
      instructions: ["Use TypeScript", "Run tests"],
      session: { autoResume: true },
      knowledge: { enabled: true, nudgeInterval: 5, injectionBudget: 4096 },
      compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 2048 },
    };
    const result = DiligentConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys (strict mode)", () => {
    const result = DiligentConfigSchema.safeParse({ model: "test", unknownKey: true });
    expect(result.success).toBe(false);
  });

  it("rejects invalid model type", () => {
    const result = DiligentConfigSchema.safeParse({ model: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid maxTurns (negative)", () => {
    const result = DiligentConfigSchema.safeParse({ maxTurns: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid baseUrl", () => {
    const result = DiligentConfigSchema.safeParse({ provider: { anthropic: { baseUrl: "not-a-url" } } });
    expect(result.success).toBe(false);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has a model set", () => {
    expect(DEFAULT_CONFIG.model).toBe("claude-sonnet-4-20250514");
  });

  it("validates against schema", () => {
    const result = DiligentConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });
});
