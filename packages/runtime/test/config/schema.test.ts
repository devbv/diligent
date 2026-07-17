// @summary Tests for DiligentConfigSchema tools section validation
import { describe, expect, it } from "bun:test";
import { DiligentConfigSchema } from "../../src/config/schema.js";

describe("DiligentConfigSchema — tools section", () => {
  it("accepts valid effort values", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const result = DiligentConfigSchema.parse({ effort });
      expect(result.effort).toBe(effort);
    }
  });

  it("rejects invalid effort values", () => {
    expect(() => DiligentConfigSchema.parse({ effort: "none" })).toThrow();
    expect(() => DiligentConfigSchema.parse({ effort: "ultra" })).toThrow();
  });

  it("accepts terminalBell boolean", () => {
    expect(DiligentConfigSchema.parse({ terminalBell: true }).terminalBell).toBe(true);
    expect(DiligentConfigSchema.parse({ terminalBell: false }).terminalBell).toBe(false);
  });

  it("rejects non-boolean terminalBell", () => {
    expect(() => DiligentConfigSchema.parse({ terminalBell: "yes" })).toThrow();
  });

  it("accepts a valid tools section with all fields", () => {
    const result = DiligentConfigSchema.parse({
      tools: {
        builtin: { bash: true, read: false },
        plugins: [
          {
            package: "@diligent/git-tools",
            enabled: true,
            tools: { "git-diff": true, "git-log": false },
          },
        ],
        conflictPolicy: "builtin_wins",
      },
    });

    expect(result.tools).toEqual({
      builtin: { bash: true, read: false },
      plugins: [
        {
          package: "@diligent/git-tools",
          enabled: true,
          tools: { "git-diff": true, "git-log": false },
        },
      ],
      conflictPolicy: "builtin_wins",
    });
  });

  it("accepts empty tools object", () => {
    const result = DiligentConfigSchema.parse({ tools: {} });
    expect(result.tools).toEqual({});
  });

  it("accepts tools with only builtin toggles", () => {
    const result = DiligentConfigSchema.parse({
      tools: { builtin: { write: false } },
    });
    expect(result.tools!.builtin).toEqual({ write: false });
    expect(result.tools!.plugins).toBeUndefined();
    expect(result.tools!.conflictPolicy).toBeUndefined();
  });

  it("accepts tools with plugins array", () => {
    const result = DiligentConfigSchema.parse({
      tools: {
        plugins: [{ package: "my-plugin", enabled: false }],
      },
    });
    expect(result.tools!.plugins).toHaveLength(1);
    expect(result.tools!.plugins![0].package).toBe("my-plugin");
  });

  it("strips unknown keys inside tools (sub-object is not strict)", () => {
    const result = DiligentConfigSchema.parse({
      tools: { builtin: {}, unknown: "nope" },
    });
    expect(result.tools).toEqual({ builtin: {} });
    expect((result.tools as Record<string, unknown>).unknown).toBeUndefined();
  });

  it("rejects unknown keys at top level (root is strict)", () => {
    expect(() => DiligentConfigSchema.parse({ bogus: true })).toThrow();
  });

  it("defaults plugin enabled to true when omitted", () => {
    const result = DiligentConfigSchema.parse({
      tools: {
        plugins: [{ package: "some-plugin" }],
      },
    });
    expect(result.tools!.plugins![0].enabled).toBe(true);
  });

  it.each(["error", "builtin_wins", "plugin_wins"] as const)("accepts conflictPolicy '%s'", (policy) => {
    const result = DiligentConfigSchema.parse({
      tools: { conflictPolicy: policy },
    });
    expect(result.tools!.conflictPolicy).toBe(policy);
  });

  it("rejects invalid conflictPolicy value", () => {
    expect(() =>
      DiligentConfigSchema.parse({
        tools: { conflictPolicy: "last_wins" },
      }),
    ).toThrow();
  });

  it("parses config without tools section (backward compat)", () => {
    const result = DiligentConfigSchema.parse({ model: "gpt-4o" });
    expect(result.tools).toBeUndefined();
    expect(result.model).toBe("gpt-4o");
  });

  it("accepts agents config with enabled, paths, and boolean overrides", () => {
    const result = DiligentConfigSchema.parse({
      agents: { enabled: true, paths: ["/tmp/agents"], overrides: { explore: false, reviewer: true } },
    });
    expect(result.agents).toEqual({
      enabled: true,
      paths: ["/tmp/agents"],
      overrides: { explore: false, reviewer: true },
    });
    expect(() => DiligentConfigSchema.parse({ agents: { overrides: { explore: "off" } } })).toThrow();
  });

  it("accepts skills config with enabled, paths, and boolean overrides", () => {
    const result = DiligentConfigSchema.parse({
      skills: {
        enabled: true,
        paths: ["/tmp/skills"],
        overrides: { "tech-lead": false, "write-plan": true },
      },
    });

    expect(result.skills).toEqual({
      enabled: true,
      paths: ["/tmp/skills"],
      overrides: { "tech-lead": false, "write-plan": true },
    });
  });

  it("accepts skills config omission and rejects non-boolean skill overrides", () => {
    expect(DiligentConfigSchema.parse({ model: "gpt-4o" }).skills).toBeUndefined();
    expect(() => DiligentConfigSchema.parse({ skills: { overrides: { "tech-lead": "off" } } })).toThrow();
  });

  it("accepts vertex provider config", () => {
    const result = DiligentConfigSchema.parse({
      provider: {
        vertex: {
          project: "demo-project",
          location: "us-central1",
          endpoint: "openapi",
          authMode: "adc",
        },
      },
    });
    expect(result.provider?.vertex).toEqual({
      project: "demo-project",
      location: "us-central1",
      endpoint: "openapi",
      authMode: "adc",
    });
  });
});
