// @summary Unit tests for loadPlugin — dynamic import, manifest validation, tool shape checks
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  collectPluginHooks,
  getGlobalPluginPath,
  getGlobalPluginRoot,
  loadPlugin,
} from "../../src/tools/plugin-loader";

const CWD = "/tmp/test-cwd";
const TEST_HOME = join(tmpdir(), `diligent-plugin-loader-home-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;

process.env.HOME = TEST_HOME;

// ── Mock modules ──────────────────────────────────────────────────────────────

mock.module("@test/no-manifest", () => ({
  // exports nothing useful
  someOther: true,
}));

mock.module("@test/bad-manifest-fields", () => ({
  manifest: { name: 123, apiVersion: null, version: undefined },
}));

mock.module("@test/name-mismatch", () => ({
  manifest: { name: "@test/different-name", apiVersion: "1.0", version: "1.0.0" },
  createTools: () => [],
}));

mock.module("@test/api-v2", () => ({
  manifest: { name: "@test/api-v2", apiVersion: "2.0", version: "1.0.0" },
  createTools: () => [],
}));

mock.module("@test/api-nan", () => ({
  manifest: { name: "@test/api-nan", apiVersion: "abc.def", version: "1.0.0" },
  createTools: () => [],
}));

mock.module("@test/no-create-tools", () => ({
  manifest: { name: "@test/no-create-tools", apiVersion: "1.0", version: "1.0.0" },
  // no createTools export
}));

mock.module("@test/create-tools-throws", () => ({
  manifest: { name: "@test/create-tools-throws", apiVersion: "1.0", version: "1.0.0" },
  createTools: () => {
    throw new Error("plugin init failed");
  },
}));

mock.module("@test/create-tools-non-array", () => ({
  manifest: { name: "@test/create-tools-non-array", apiVersion: "1.0", version: "1.0.0" },
  createTools: () => ({ not: "an array" }),
}));

mock.module("@test/valid-plugin", () => ({
  manifest: { name: "@test/valid-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "my_tool",
      description: "A test tool",
      parameters: z.object({ input: z.string() }),
      execute: async () => ({ output: "ok" }),
    },
  ],
}));

mock.module("@test/async-plugin", () => ({
  manifest: { name: "@test/async-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: async () => [
    {
      name: "async_tool",
      description: "An async test tool",
      parameters: z.object({}),
      execute: async () => ({ output: "ok" }),
    },
  ],
}));

mock.module("@test/native-exposure-plugin", () => ({
  manifest: { name: "@test/native-exposure-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "plugin_web",
      description: "Must remain a local function tool",
      parameters: z.object({}),
      modelExposure: { kind: "provider_builtin", capability: "web" },
      execute: async () => ({ output: "ok" }),
    },
  ],
}));

mock.module("@test/mixed-tools", () => ({
  manifest: { name: "@test/mixed-tools", apiVersion: "1.2", version: "0.2.0" },
  createTools: () => [
    {
      name: "good_tool",
      description: "Valid tool",
      parameters: z.object({}),
      execute: async () => ({ output: "ok" }),
    },
    {
      // missing description and execute
      name: "bad_tool_1",
      parameters: z.object({}),
    },
    {
      // invalid shape
      name: "bad_tool_2",
    },
    null,
    "not-a-tool",
  ],
}));

mock.module("@test/duplicate-tool-names", () => ({
  manifest: { name: "@test/duplicate-tool-names", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "dup_tool",
      description: "first",
      parameters: z.object({}),
      execute: async () => ({ output: "first" }),
    },
    {
      name: "dup_tool",
      description: "second",
      parameters: z.object({}),
      execute: async () => ({ output: "second" }),
    },
  ],
}));

mock.module("@test/render-plugin", () => ({
  manifest: { name: "@test/render-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "render_tool",
      description: "Render-aware tool",
      parameters: z.object({}),
      execute: async () => ({
        output: "ok",
        render: {
          inputSummary: "render_tool",
          outputSummary: "Rendered",
          blocks: [{ type: "summary", text: "Plugin render", tone: "info" }],
        },
      }),
    },
  ],
}));

const explicitPromptHook = async () => ({ continue: true });
const explicitStopHook = async () => ({ continue: true });

mock.module("@test/explicit-hook-plugin", () => ({
  onUserPromptSubmit: explicitPromptHook,
  onStop: explicitStopHook,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadPlugin", () => {
  const originalWarn = console.warn;

  afterAll(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
    if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
    else delete process.env.HOME;
    console.warn = originalWarn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it("resolves helper paths under the home plugin directory", () => {
    expect(getGlobalPluginRoot()).toBe(join(TEST_HOME, ".diligent", "plugins"));
    expect(getGlobalPluginPath("example-tool-plugin")).toBe(
      join(TEST_HOME, ".diligent", "plugins", "example-tool-plugin"),
    );
  });

  it("returns error when package import fails", async () => {
    const result = await loadPlugin("@nonexistent/package-xyz-999", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("Could not load plugin package");
    expect(result.error).toContain("@nonexistent/package-xyz-999");
    expect(result.error).toContain(getGlobalPluginRoot());
    expect(result.package).toBe("@nonexistent/package-xyz-999");
  });

  it("falls back to the global plugin directory when package import fails", async () => {
    const pluginDir = getGlobalPluginPath("global-only-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "global-only-plugin", version: "0.1.0", type: "module", main: "./index.js" }, null, 2),
    );
    await Bun.write(
      join(pluginDir, "index.js"),
      [
        "export const manifest = { name: 'global-only-plugin', apiVersion: '1.0', version: '0.1.0' };",
        "const params = { parse(value) { return value; } };",
        "export async function createTools() {",
        "  return [{ name: 'global_tool', description: 'global', parameters: params, execute: async () => ({ output: 'ok' }) }];",
        "}",
      ].join("\n"),
    );

    const result = await loadPlugin("global-only-plugin", CWD);
    expect(result.error).toBeUndefined();
    expect(result.manifest).toEqual({ name: "global-only-plugin", apiVersion: "1.0", version: "0.1.0" });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("global_tool");

    await rm(pluginDir, { recursive: true, force: true });
  });

  it("returns error when manifest is missing", async () => {
    const result = await loadPlugin("@test/no-manifest", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("does not export a 'manifest' object");
  });

  it("returns error when manifest has wrong fields", async () => {
    const result = await loadPlugin("@test/bad-manifest-fields", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("missing required fields");
    expect(result.error).toContain("name, apiVersion, version");
  });

  it("returns error when manifest.name does not match configured package", async () => {
    const result = await loadPlugin("@test/name-mismatch", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("does not match the configured package name");
    expect(result.error).toContain("@test/different-name");
  });

  it("returns error when apiVersion is not 1.x", async () => {
    const result = await loadPlugin("@test/api-v2", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("API version '2.0'");
    expect(result.error).toContain("only version 1.x is supported");
  });

  it("returns error when apiVersion is not a number", async () => {
    const result = await loadPlugin("@test/api-nan", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("API version 'abc.def'");
    expect(result.error).toContain("only version 1.x is supported");
  });

  it("returns error when createTools is not a function", async () => {
    const result = await loadPlugin("@test/no-create-tools", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("does not export a 'createTools' function");
  });

  it("returns error when createTools throws", async () => {
    const result = await loadPlugin("@test/create-tools-throws", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("createTools() threw");
    expect(result.error).toContain("plugin init failed");
  });

  it("returns error when createTools does not return an array", async () => {
    const result = await loadPlugin("@test/create-tools-non-array", CWD);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("must return an array of tools");
  });

  it("returns valid tools from well-formed plugin", async () => {
    const result = await loadPlugin("@test/valid-plugin", CWD);
    expect(result.error).toBeUndefined();
    expect(result.manifest).toEqual({
      name: "@test/valid-plugin",
      apiVersion: "1.0",
      version: "0.1.0",
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("my_tool");
    expect(result.tools[0].description).toBe("A test tool");
    expect(typeof result.tools[0].execute).toBe("function");
    expect(result.warnings).toEqual([]);
    expect(result.invalidTools).toEqual([]);
  });

  it("does not promote provider-native exposure from plugin SDK v1 tools", async () => {
    const result = await loadPlugin("@test/native-exposure-plugin", CWD);

    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).not.toHaveProperty("modelExposure");
  });

  it("supports async createTools", async () => {
    const result = await loadPlugin("@test/async-plugin", CWD);
    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("async_tool");
  });

  it("preserves valid plugin render payloads through the host wrapper", async () => {
    const result = await loadPlugin("@test/render-plugin", CWD);
    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);

    const execution = await result.tools[0].execute(
      {},
      {
        toolCallId: "call-1",
        signal: new AbortController().signal,
        abort: () => {},
      },
    );

    expect(execution.render).toEqual({
      inputSummary: "render_tool",
      outputSummary: "Rendered",
      blocks: [{ type: "summary", text: "Plugin render", tone: "info" }],
    });
  });

  it("drops plugin render payloads that still do not match the protocol after normalization", async () => {
    const warnMock = mock(() => {});
    console.warn = warnMock;

    mock.module("@test/invalid-render-plugin", () => ({
      manifest: { name: "@test/invalid-render-plugin", apiVersion: "1.0", version: "0.1.0" },
      createTools: () => [
        {
          name: "invalid_render_tool",
          description: "Invalid render tool",
          parameters: z.object({}),
          execute: async () => ({
            output: "ok",
            render: {
              inputSummary: "invalid_render_tool",
              blocks: [{ type: "not-a-real-block" }],
            },
          }),
        },
      ],
    }));

    const result = await loadPlugin("@test/invalid-render-plugin", CWD);
    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);

    const execution = await result.tools[0].execute(
      {},
      {
        toolCallId: "call-3",
        signal: new AbortController().signal,
        abort: () => {},
      },
    );

    expect(execution.render).toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0]?.[0] ?? "")).toContain("package=@test/invalid-render-plugin");
    expect(String(warnMock.mock.calls[0]?.[0] ?? "")).toContain("tool=invalid_render_tool");
    expect(String(warnMock.mock.calls[0]?.[0] ?? "")).toContain("Invalid discriminator value");
  });

  it("filters out tools with invalid shape and returns warnings", async () => {
    const result = await loadPlugin("@test/mixed-tools", CWD);
    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("good_tool");
    expect(result.manifest).toEqual({
      name: "@test/mixed-tools",
      apiVersion: "1.2",
      version: "0.2.0",
    });
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.join(" ")).toContain("bad_tool_1");
    expect(result.warnings!.join(" ")).toContain("bad_tool_2");
    expect(result.warnings!.join(" ")).toContain("invalid shape");
    expect(result.invalidTools).toHaveLength(4);
  });

  it("rejects duplicate tool names inside one plugin package", async () => {
    const result = await loadPlugin("@test/duplicate-tool-names", CWD);
    expect(result.error).toBeUndefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("dup_tool");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.join(" ")).toContain("duplicate tool name 'dup_tool'");
    expect(result.invalidTools).toEqual([
      {
        name: "dup_tool",
        error:
          "Plugin '@test/duplicate-tool-names' exports duplicate tool name 'dup_tool'. Later duplicates are ignored.",
      },
    ]);
  });
});

describe("collectPluginHooks", () => {
  it("loads only explicitly configured hooks in explicit discovery mode", async () => {
    const pluginDir = getGlobalPluginPath("explicit-mode-global-hooks");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "explicit-mode-global-hooks", version: "0.1.0", type: "module", main: "./index.js" }),
    );
    await Bun.write(
      join(pluginDir, "index.js"),
      [
        "export async function onUserPromptSubmit() { return { continue: true }; }",
        "export async function onStop() { return { continue: true }; }",
      ].join("\n"),
    );

    const globalHooks = await collectPluginHooks(
      { plugins: [{ package: "@test/explicit-hook-plugin", enabled: true }] },
      CWD,
    );
    expect(globalHooks.onUserPromptSubmit).toHaveLength(2);
    expect(globalHooks.onStop).toHaveLength(2);

    const hooks = await collectPluginHooks(
      { plugins: [{ package: "@test/explicit-hook-plugin", enabled: true }] },
      CWD,
      { pluginDiscovery: "explicit" },
    );

    expect(hooks.onUserPromptSubmit).toEqual([explicitPromptHook]);
    expect(hooks.onStop).toEqual([explicitStopHook]);

    await rm(pluginDir, { recursive: true, force: true });
  });
});
