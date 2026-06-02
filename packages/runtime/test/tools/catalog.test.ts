// @summary Tests for buildToolCatalog — builtin toggles, immutable enforcement, state metadata
import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool/types";
import { z } from "zod";
import type { BundledToolProvider } from "../../src/tools/bundled-provider";
import { buildToolCatalog } from "../../src/tools/catalog";
import { getGlobalPluginPath, getGlobalPluginRoot } from "../../src/tools/plugin-loader";

const TEST_HOME = join(tmpdir(), `diligent-catalog-home-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

function mockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: z.object({}),
    execute: async () => ({ output: "ok" }),
  };
}

function standardBuiltins(): Tool[] {
  return [
    mockTool("plan"),
    mockTool("request_user_input"),
    mockTool("skill"),
    mockTool("bash"),
    mockTool("read"),
    mockTool("web_action"),
    mockTool("write"),
  ];
}

function toolNames(tools: Tool[]): string[] {
  return tools.map((t) => t.name);
}

mock.module("@test/catalog-plugin", () => ({
  manifest: { name: "@test/catalog-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "plugin_tool",
      description: "Plugin tool",
      parameters: z.object({}),
      execute: async () => ({ output: "ok" }),
    },
  ],
}));

mock.module("@test/plugin-conflict-plan", () => ({
  manifest: { name: "@test/plugin-conflict-plan", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "plan",
      description: "Attempt override immutable tool",
      parameters: z.object({}),
      execute: async () => ({ output: "nope" }),
    },
  ],
}));

mock.module("@test/plugin-conflict-bash", () => ({
  manifest: { name: "@test/plugin-conflict-bash", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "bash",
      description: "Attempt override builtin tool",
      parameters: z.object({}),
      execute: async () => ({ output: "plugin bash" }),
    },
  ],
}));

mock.module("@test/plugin-conflict-bundled", () => ({
  manifest: { name: "@test/plugin-conflict-bundled", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "bundled_tool",
      description: "Plugin tool that conflicts with bundled tool",
      parameters: z.object({}),
      execute: async () => ({ output: "plugin bundled" }),
    },
  ],
}));

mock.module("@test/invalid-tool-plugin", () => ({
  manifest: { name: "@test/invalid-tool-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "good_plugin_tool",
      description: "valid",
      parameters: z.object({}),
      execute: async () => ({ output: "ok" }),
    },
    {
      name: "bad_plugin_tool",
      parameters: z.object({}),
    },
  ],
}));

describe("buildToolCatalog", () => {
  afterAll(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
    if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
    else delete process.env.HOME;
  });

  it("returns all builtins when config is undefined", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, undefined, "/tmp");

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
    ]);
    expect(result.state).toHaveLength(7);
    expect(result.plugins).toEqual([]);
    for (const entry of result.state) {
      expect(entry.enabled).toBe(true);
      expect(entry.source).toBe("builtin");
      expect(entry.available).toBe(true);
      expect(entry.configurable).toBe(!entry.immutable);
      expect(entry.reason).toBe("enabled");
    }
    expect(result.pluginErrors).toEqual([]);
  });

  it("returns all builtins when config is empty object", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, {}, "/tmp");

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
    ]);
    expect(result.state).toHaveLength(7);
    expect(result.plugins).toEqual([]);
    expect(result.pluginErrors).toEqual([]);
  });

  it("does not treat tools.web_action as a catalog toggle by itself", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, { web_action: false }, "/tmp");

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
    ]);
  });

  it("excludes a disabled non-immutable builtin", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, { builtin: { bash: false } }, "/tmp");

    expect(toolNames(result.tools)).toEqual(["plan", "request_user_input", "skill", "read", "web_action", "write"]);
    const bashState = result.state.find((s) => s.name === "bash");
    expect(bashState).toBeDefined();
    expect(bashState!.enabled).toBe(false);
    expect(bashState!.reason).toBe("disabled_by_user");
    expect(bashState!.configurable).toBe(true);
  });

  it("keeps 'plan' enabled even when config disables it", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, { builtin: { plan: false } }, "/tmp");

    const planState = result.state.find((s) => s.name === "plan" && s.source === "builtin");
    expect(planState).toBeDefined();
    expect(planState!.enabled).toBe(true);
    expect(planState!.immutable).toBe(true);
    expect(planState!.configurable).toBe(false);
    expect(planState!.reason).toBe("immutable_forced_on");
  });

  it("keeps 'request_user_input' enabled even when config disables it", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, { builtin: { request_user_input: false } }, "/tmp");

    const ruiState = result.state.find((s) => s.name === "request_user_input" && s.source === "builtin");
    expect(ruiState).toBeDefined();
    expect(ruiState!.enabled).toBe(true);
    expect(ruiState!.immutable).toBe(true);
    expect(ruiState!.reason).toBe("immutable_forced_on");
  });

  it("keeps 'skill' enabled even when config disables it", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, { builtin: { skill: false } }, "/tmp");

    const skillState = result.state.find((s) => s.name === "skill" && s.source === "builtin");
    expect(skillState).toBeDefined();
    expect(skillState!.enabled).toBe(true);
    expect(skillState!.immutable).toBe(true);
    expect(skillState!.reason).toBe("immutable_forced_on");
  });

  it("disables multiple non-immutable builtins at once", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, { builtin: { bash: false, write: false } }, "/tmp");

    expect(toolNames(result.tools)).toEqual(["plan", "request_user_input", "skill", "read", "web_action"]);
    const bashState = result.state.find((s) => s.name === "bash");
    const writeState = result.state.find((s) => s.name === "write");
    expect(bashState!.enabled).toBe(false);
    expect(writeState!.enabled).toBe(false);
  });

  it("populates state with correct source and immutable flags", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(builtins, undefined, "/tmp");

    const stateByName = new Map(result.state.map((s) => [s.name, s]));

    for (const name of ["plan", "request_user_input", "skill"]) {
      const entry = stateByName.get(name);
      expect(entry).toBeDefined();
      expect(entry!.source).toBe("builtin");
      expect(entry!.immutable).toBe(true);
      expect(entry!.enabled).toBe(true);
      expect(entry!.pluginPackage).toBeUndefined();
    }

    for (const name of ["bash", "read", "web_action", "write"]) {
      const entry = stateByName.get(name);
      expect(entry).toBeDefined();
      expect(entry!.source).toBe("builtin");
      expect(entry!.immutable).toBe(false);
      expect(entry!.enabled).toBe(true);
      expect(entry!.pluginPackage).toBeUndefined();
    }
  });

  it("accepts conflictPolicy without errors when no plugins are loaded", async () => {
    const builtins = standardBuiltins();

    for (const policy of ["error", "builtin_wins", "plugin_wins"] as const) {
      const result = await buildToolCatalog(builtins, { conflictPolicy: policy }, "/tmp");
      expect(result.tools).toHaveLength(7);
      expect(result.pluginErrors).toEqual([]);
    }
  });

  it("keeps only immutable tools when all non-immutable builtins are disabled", async () => {
    const builtins = standardBuiltins();
    const result = await buildToolCatalog(
      builtins,
      { builtin: { bash: false, read: false, web_action: false, write: false } },
      "/tmp",
    );

    expect(toolNames(result.tools)).toEqual(["plan", "request_user_input", "skill"]);
    expect(result.state.filter((s) => s.enabled)).toHaveLength(3);
    expect(result.state.filter((s) => !s.enabled)).toHaveLength(4);
  });

  it("handles empty builtins array gracefully", async () => {
    const result = await buildToolCatalog([], undefined, "/tmp");

    expect(result.tools).toEqual([]);
    expect(result.state).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.pluginErrors).toEqual([]);
  });

  it("loads plugin tools and exposes separate plugin state metadata", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        plugins: [{ package: "@test/catalog-plugin", enabled: true }],
      },
      "/tmp",
    );

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
      "plugin_tool",
    ]);
    expect(result.plugins).toEqual([
      {
        package: "@test/catalog-plugin",
        configured: true,
        enabled: true,
        loaded: true,
        toolCount: 1,
        warnings: [],
      },
    ]);
    const pluginToolState = result.state.find((s) => s.name === "plugin_tool");
    expect(pluginToolState).toMatchObject({
      source: "plugin",
      pluginPackage: "@test/catalog-plugin",
      enabled: true,
      available: true,
      reason: "enabled",
    });
  });

  it("merges bundled provider tools between builtins and external plugins", async () => {
    const provider: BundledToolProvider = {
      id: "@product/bundled-tools",
      createTools: () => [mockTool("bundled_tool")],
    };

    const result = await buildToolCatalog(
      standardBuiltins(),
      { plugins: [{ package: "@test/catalog-plugin", enabled: true }] },
      "/tmp",
      undefined,
      { bundledProviders: [provider] },
    );

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
      "bundled_tool",
      "plugin_tool",
    ]);
    expect(result.state.find((s) => s.name === "bundled_tool")).toMatchObject({
      source: "plugin",
      pluginPackage: "@product/bundled-tools",
      enabled: true,
      available: true,
      reason: "enabled",
    });
  });

  it("keeps bundled provider tools ahead of conflicting external plugin tools", async () => {
    const provider: BundledToolProvider = {
      id: "@product/bundled-tools",
      createTools: () => [mockTool("bundled_tool")],
    };

    const result = await buildToolCatalog(
      standardBuiltins(),
      { conflictPolicy: "plugin_wins", plugins: [{ package: "@test/plugin-conflict-bundled", enabled: true }] },
      "/tmp",
      undefined,
      { bundledProviders: [provider] },
    );

    expect(toolNames(result.tools).filter((name) => name === "bundled_tool")).toHaveLength(1);
    expect(
      result.state.find((s) => s.name === "bundled_tool" && s.pluginPackage === "@product/bundled-tools"),
    ).toMatchObject({
      enabled: true,
      reason: "enabled",
    });
    expect(
      result.state.find((s) => s.name === "bundled_tool" && s.pluginPackage === "@test/plugin-conflict-bundled"),
    ).toMatchObject({
      enabled: false,
      available: false,
      reason: "conflict_dropped",
    });
  });

  it("suppresses explicit legacy plugins superseded by bundled providers", async () => {
    const provider: BundledToolProvider = {
      id: "@product/bundled-tools",
      supersedesPluginPackages: ["@test/catalog-plugin"],
      createTools: () => [mockTool("bundled_tool")],
    };

    const result = await buildToolCatalog(
      standardBuiltins(),
      { plugins: [{ package: "@test/catalog-plugin", enabled: true, tools: { plugin_tool: true } }] },
      "/tmp",
      undefined,
      { bundledProviders: [provider] },
    );

    expect(toolNames(result.tools)).toContain("bundled_tool");
    expect(toolNames(result.tools)).not.toContain("plugin_tool");
    expect(result.plugins.find((p) => p.package === "@test/catalog-plugin")).toMatchObject({
      enabled: true,
      loaded: false,
      loadError: "Plugin '@test/catalog-plugin' is superseded by a bundled tool provider.",
    });
    expect(
      result.state.find((s) => s.name === "plugin_tool" && s.pluginPackage === "@test/catalog-plugin"),
    ).toMatchObject({
      enabled: false,
      available: false,
      reason: "superseded_by_bundled",
    });
  });

  it("supports plugin-level tool disable state", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        plugins: [{ package: "@test/catalog-plugin", enabled: true, tools: { plugin_tool: false } }],
      },
      "/tmp",
    );

    expect(toolNames(result.tools)).not.toContain("plugin_tool");
    const pluginToolState = result.state.find((s) => s.name === "plugin_tool" && s.source === "plugin");
    expect(pluginToolState).toMatchObject({
      enabled: false,
      available: true,
      reason: "disabled_by_user",
    });
  });

  it("records disabled plugin packages separately from tool-level state", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        plugins: [{ package: "@test/catalog-plugin", enabled: false, tools: { plugin_tool: false } }],
      },
      "/tmp",
    );

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
    ]);
    expect(result.plugins).toEqual([
      {
        package: "@test/catalog-plugin",
        configured: true,
        enabled: false,
        loaded: false,
        toolCount: 0,
        warnings: [],
      },
    ]);
    const pluginToolState = result.state.find(
      (s) => s.name === "plugin_tool" && s.pluginPackage === "@test/catalog-plugin",
    );
    expect(pluginToolState).toMatchObject({
      enabled: false,
      available: false,
      reason: "plugin_disabled",
    });
  });

  it("rejects overriding immutable built-ins even under plugin_wins", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        conflictPolicy: "plugin_wins",
        plugins: [{ package: "@test/plugin-conflict-plan", enabled: true }],
      },
      "/tmp",
    );

    const enabledNames = toolNames(result.tools);
    expect(enabledNames.filter((name) => name === "plan")).toHaveLength(1);
    const builtinPlan = result.state.find((s) => s.name === "plan" && s.source === "builtin");
    const droppedPluginPlan = result.state.find((s) => s.name === "plan" && s.source === "plugin");
    expect(builtinPlan).toMatchObject({ enabled: true, immutable: true, reason: "enabled" });
    expect(droppedPluginPlan).toMatchObject({
      enabled: false,
      available: false,
      reason: "conflict_dropped",
    });
    expect(droppedPluginPlan!.error).toContain("cannot override immutable built-in");
  });

  it("drops conflicting plugin tools under conflictPolicy error", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        conflictPolicy: "error",
        plugins: [{ package: "@test/plugin-conflict-bash", enabled: true }],
      },
      "/tmp",
    );

    const builtinBash = result.state.find((s) => s.name === "bash" && s.source === "builtin");
    const droppedPluginBash = result.state.find((s) => s.name === "bash" && s.source === "plugin");
    expect(builtinBash).toMatchObject({ enabled: true, source: "builtin" });
    expect(droppedPluginBash).toMatchObject({
      enabled: false,
      available: false,
      reason: "conflict_dropped",
    });
    expect(result.pluginErrors.some((error) => error.error.includes("conflicts with built-in tool"))).toBe(true);
  });

  it("allows plugins to override non-immutable built-ins under plugin_wins", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        conflictPolicy: "plugin_wins",
        plugins: [{ package: "@test/plugin-conflict-bash", enabled: true }],
      },
      "/tmp",
    );

    const bashEntries = result.state.filter((s) => s.name === "bash");
    expect(bashEntries).toHaveLength(1);
    expect(bashEntries[0]).toMatchObject({
      source: "plugin",
      pluginPackage: "@test/plugin-conflict-bash",
      enabled: true,
      available: true,
    });
    expect(toolNames(result.tools)).toContain("bash");
  });

  it("surfaces invalid plugin tools without failing the whole package", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        plugins: [{ package: "@test/invalid-tool-plugin", enabled: true }],
      },
      "/tmp",
    );

    expect(toolNames(result.tools)).toContain("good_plugin_tool");
    expect(toolNames(result.tools)).not.toContain("bad_plugin_tool");
    expect(result.plugins).toEqual([
      {
        package: "@test/invalid-tool-plugin",
        configured: true,
        enabled: true,
        loaded: true,
        toolCount: 1,
        warnings: ["Tool 'bad_plugin_tool' from '@test/invalid-tool-plugin' has invalid shape."],
      },
    ]);
    const invalidState = result.state.find((s) => s.name === "bad_plugin_tool" && s.source === "plugin");
    expect(invalidState).toMatchObject({
      enabled: false,
      available: false,
      reason: "invalid_plugin_tool",
    });
  });

  it("keeps state ordering deterministic: builtins first, then plugins in config order", async () => {
    const result = await buildToolCatalog(
      standardBuiltins(),
      {
        plugins: [
          { package: "@test/catalog-plugin", enabled: true },
          { package: "@test/invalid-tool-plugin", enabled: true },
        ],
      },
      "/tmp",
    );

    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
      "plugin_tool",
      "good_plugin_tool",
    ]);
  });

  // ── Auto-discovery tests ────────────────────────────────────────────────────

  it("auto-discovers plugins present in ~/.diligent/plugins without any config entry", async () => {
    const pluginDir = getGlobalPluginPath("auto-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "auto-plugin", version: "0.1.0", type: "module", main: "./index.js" }, null, 2),
    );
    await Bun.write(
      join(pluginDir, "index.js"),
      [
        "export const manifest = { name: 'auto-plugin', apiVersion: '1.0', version: '0.1.0' };",
        "const params = { parse(value) { return value; } };",
        "export async function createTools() {",
        "  return [{ name: 'auto_tool', description: 'auto-discovered tool', parameters: params, execute: async () => ({ output: 'ok' }) }];",
        "}",
      ].join("\n"),
    );

    // No plugins in config — should still load the auto-discovered plugin.
    const result = await buildToolCatalog(standardBuiltins(), {}, "/tmp");

    expect(toolNames(result.tools)).toContain("auto_tool");
    const pluginState = result.plugins.find((p) => p.package === "auto-plugin");
    expect(pluginState).toMatchObject({
      package: "auto-plugin",
      configured: true,
      enabled: true,
      loaded: true,
      toolCount: 1,
    });
    const toolState = result.state.find((s) => s.name === "auto_tool");
    expect(toolState).toMatchObject({
      source: "plugin",
      pluginPackage: "auto-plugin",
      enabled: true,
      available: true,
      reason: "enabled",
    });

    await rm(pluginDir, { recursive: true, force: true });
  });

  it("explicit config entry overrides auto-discovery for the same package", async () => {
    const pluginDir = getGlobalPluginPath("override-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "override-plugin", version: "0.1.0", type: "module", main: "./index.js" }, null, 2),
    );
    await Bun.write(
      join(pluginDir, "index.js"),
      [
        "export const manifest = { name: 'override-plugin', apiVersion: '1.0', version: '0.1.0' };",
        "const params = { parse(value) { return value; } };",
        "export async function createTools() {",
        "  return [{ name: 'override_tool', description: 'override tool', parameters: params, execute: async () => ({ output: 'ok' }) }];",
        "}",
      ].join("\n"),
    );

    // Explicitly disabled in config — should NOT be auto-loaded.
    const result = await buildToolCatalog(
      standardBuiltins(),
      { plugins: [{ package: "override-plugin", enabled: false }] },
      "/tmp",
    );

    expect(toolNames(result.tools)).not.toContain("override_tool");
    const pluginState = result.plugins.find((p) => p.package === "override-plugin");
    expect(pluginState).toMatchObject({
      package: "override-plugin",
      configured: true,
      enabled: false,
      loaded: false,
    });

    await rm(pluginDir, { recursive: true, force: true });
  });

  it("explicit config entry with per-tool override is respected for auto-discovered plugin", async () => {
    const pluginDir = getGlobalPluginPath("partial-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "partial-plugin", version: "0.1.0", type: "module", main: "./index.js" }, null, 2),
    );
    await Bun.write(
      join(pluginDir, "index.js"),
      [
        "export const manifest = { name: 'partial-plugin', apiVersion: '1.0', version: '0.1.0' };",
        "const params = { parse(value) { return value; } };",
        "export async function createTools() {",
        "  return [",
        "    { name: 'tool_a', description: 'tool a', parameters: params, execute: async () => ({ output: 'ok' }) },",
        "    { name: 'tool_b', description: 'tool b', parameters: params, execute: async () => ({ output: 'ok' }) },",
        "  ];",
        "}",
      ].join("\n"),
    );

    // Only disable tool_b via explicit config; tool_a should still load.
    const result = await buildToolCatalog(
      standardBuiltins(),
      { plugins: [{ package: "partial-plugin", enabled: true, tools: { tool_b: false } }] },
      "/tmp",
    );

    expect(toolNames(result.tools)).toContain("tool_a");
    expect(toolNames(result.tools)).not.toContain("tool_b");
    const pluginState = result.plugins.find((p) => p.package === "partial-plugin");
    expect(pluginState).toMatchObject({ configured: true, enabled: true });

    await rm(pluginDir, { recursive: true, force: true });
  });

  it("returns empty plugins array when ~/.diligent/plugins does not exist", async () => {
    // TEST_HOME is set but plugins subdir was never created for this test.
    await rm(getGlobalPluginRoot(), { recursive: true, force: true });

    const result = await buildToolCatalog(standardBuiltins(), {}, "/tmp");
    expect(result.plugins).toEqual([]);
    expect(toolNames(result.tools)).toEqual([
      "plan",
      "request_user_input",
      "skill",
      "bash",
      "read",
      "web_action",
      "write",
    ]);
  });

  // ── Existing global-dir test (kept for regression) ─────────────────────────

  it("loads a plugin from the global plugin directory without project installation", async () => {
    const pluginDir = getGlobalPluginPath("global-catalog-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "global-catalog-plugin", version: "0.1.0", type: "module", main: "./index.js" }, null, 2),
    );
    await Bun.write(
      join(pluginDir, "index.js"),
      [
        "export const manifest = { name: 'global-catalog-plugin', apiVersion: '1.0', version: '0.1.0' };",
        "const params = { parse(value) { return value; } };",
        "export async function createTools() {",
        "  return [{ name: 'global_catalog_tool', description: 'global catalog tool', parameters: params, execute: async () => ({ output: 'ok' }) }];",
        "}",
      ].join("\n"),
    );

    const result = await buildToolCatalog(
      standardBuiltins(),
      { plugins: [{ package: "global-catalog-plugin", enabled: true }] },
      "/tmp",
    );

    expect(toolNames(result.tools)).toContain("global_catalog_tool");
    expect(result.plugins).toEqual([
      {
        package: "global-catalog-plugin",
        configured: true,
        enabled: true,
        loaded: true,
        toolCount: 1,
        warnings: [],
      },
    ]);
    expect(
      result.state.find((entry) => entry.name === "global_catalog_tool" && entry.source === "plugin"),
    ).toMatchObject({
      pluginPackage: "global-catalog-plugin",
      enabled: true,
      available: true,
      reason: "enabled",
    });

    await rm(pluginDir, { recursive: true, force: true });
  });
});
