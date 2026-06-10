// @summary Tests for createAppServerConfig factory — validates config assembly and override merging
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelInfoList } from "@diligent/core/llm/models";
import { ProviderManager } from "@diligent/core/llm/provider-manager";
import type { Model } from "@diligent/core/llm/types";
import { createAppServerConfig } from "@diligent/runtime/app-server";
import { z } from "zod";
import type { PermissionEngine } from "../../src/approval";
import type { RuntimeConfig } from "../../src/config/runtime";
import type { BundledToolProvider } from "../../src/tools/bundled-provider";

function makeRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  const providerManager = new ProviderManager({});
  const permissionEngine: PermissionEngine = {
    evaluate: () => "allow",
    remember: () => {},
  };
  const model: Model = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
  };
  return {
    model,
    mode: "default",
    effort: "medium",
    systemPrompt: [{ label: "base", content: "test" }],
    streamFunction: () => {
      throw new Error("not implemented");
    },
    diligent: {},
    sources: [],
    skills: [],
    compaction: {
      enabled: true,
      reservePercent: 16,
      keepRecentTokens: 20000,
      timeoutMs: 180000,
    },
    permissionEngine,
    providerManager,
    agents: [],
    agentDefinitions: [],
    authStore: { mode: "auto" },
    ...overrides,
  };
}

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createAppServerConfig", () => {
  it("produces a valid config from a minimal RuntimeConfig", () => {
    const runtimeConfig = makeRuntimeConfig();
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

    expect(config.cwd).toBe("/tmp/test");
    expect(config.resolvePaths).toBeTypeOf("function");
    expect(config.createAgent).toBeTypeOf("function");
    expect(config.compaction).toEqual(runtimeConfig.compaction);
    expect(config.providerManager).toBe(runtimeConfig.providerManager);
    expect(config.authStore).toEqual(runtimeConfig.authStore);
    expect(config.permissionEngine).toBe(runtimeConfig.permissionEngine);
    expect(config.modelConfig).toBeDefined();
    expect(config.modelConfig?.currentModelId).toBe("claude-sonnet-4-6");
    expect(config.defaultEffort).toBe("medium");
    expect(config.skillNames).toEqual([]);
  });

  it("uses runtimeConfig.effort as defaultEffort", () => {
    const runtimeConfig = makeRuntimeConfig({ effort: "high" });
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });
    expect(config.defaultEffort).toBe("high");
  });

  it("passes skill names for slash disambiguation", () => {
    const runtimeConfig = makeRuntimeConfig({
      skills: [
        {
          name: "tidy-plan",
          description: "desc",
          path: "/tmp/skills/tidy-plan/SKILL.md",
          baseDir: "/tmp/skills/tidy-plan",
          source: "project",
          disableModelInvocation: false,
        },
      ],
    });
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });
    expect(config.skillNames).toEqual(["tidy-plan"]);
  });

  it("merges overrides for toImageUrl and openBrowser", () => {
    const runtimeConfig = makeRuntimeConfig();
    const toImageUrl = (path: string) => `http://localhost/img/${path}`;
    const openBrowser = (url: string) => {
      void url;
    };

    const config = createAppServerConfig({
      cwd: "/tmp/test",
      runtimeConfig,
      overrides: { toImageUrl, openBrowser },
    });

    expect(config.toImageUrl).toBe(toImageUrl);
    expect(config.openBrowser).toBe(openBrowser);
  });

  it("overrides do not clobber core fields", () => {
    const runtimeConfig = makeRuntimeConfig();
    const config = createAppServerConfig({
      cwd: "/tmp/test",
      runtimeConfig,
      overrides: { serverName: "custom" },
    });

    expect(config.serverName).toBe("custom");
    expect(config.createAgent).toBeTypeOf("function");
    expect(config.compaction).toBeDefined();
  });

  it("modelConfig.onModelChange updates runtimeConfig.model", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-factory-home-"));
    tempHomes.push(fakeHome);
    process.env.HOME = fakeHome;

    try {
      const runtimeConfig = makeRuntimeConfig();
      const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

      config.modelConfig?.onModelChange("claude-haiku-4-5");
      expect(runtimeConfig.model?.id).toBe("claude-haiku-4-5-20251001");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("does not persist thread-scoped model changes to the global config", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-factory-home-"));
    tempHomes.push(fakeHome);
    process.env.HOME = fakeHome;

    try {
      const runtimeConfig = makeRuntimeConfig();
      const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

      config.modelConfig?.onModelChange("claude-haiku-4-5", "thread-child");

      expect(runtimeConfig.model?.id).toBe("claude-sonnet-4-6");
      const configPath = join(fakeHome, ".diligent", "config.jsonc");
      expect(await Bun.file(configPath).exists()).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("toolConfig.setTools updates runtimeConfig.diligent.tools", () => {
    const runtimeConfig = makeRuntimeConfig();
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

    config.toolConfig?.setTools({
      builtin: { bash: false },
      conflictPolicy: "plugin_wins",
    });
    expect(config.toolConfig?.getTools()).toEqual({
      builtin: { bash: false },
      conflictPolicy: "plugin_wins",
    });
    expect(runtimeConfig.diligent.tools).toEqual({
      builtin: { bash: false },
      conflictPolicy: "plugin_wins",
    });

    config.toolConfig?.setTools(undefined);
    expect(config.toolConfig?.getTools()).toBeUndefined();
    expect(runtimeConfig.diligent.tools).toBeUndefined();
  });

  it("passes bundled tool providers into created runtime agents", async () => {
    const runtimeConfig = makeRuntimeConfig();
    const bundledToolProviders: BundledToolProvider[] = [
      {
        id: "@product/factory-tools",
        createTools: () => [
          {
            name: "factory_bundled_tool",
            description: "Factory bundled tool",
            parameters: z.object({}),
            execute: async () => ({ output: "ok" }),
          },
        ],
      },
    ];
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig, bundledToolProviders });

    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "default",
      effort: "medium",
      modelId: "claude-sonnet-4-6",
      approve: async () => "once",
      ask: async () => null,
    });

    expect(agent.tools.map((tool) => tool.name)).toContain("factory_bundled_tool");
  });
});

describe("getModelInfoList", () => {
  it("returns an entry for each known model with required fields", () => {
    const list = getModelInfoList();
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      expect(m.id).toBeTypeOf("string");
      expect(m.provider).toBeTypeOf("string");
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});
