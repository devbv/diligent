// @summary Tests for createAppServerConfig factory — validates config assembly and override merging
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ANTHROPIC_MODEL_ID, getModelInfoList } from "@diligent/core/model-registry";
import type { Model } from "@diligent/core/provider-contract";
import { ProviderManager } from "@diligent/core/provider-contract";
import { createAppServerConfig } from "@diligent/runtime/app-server";
import { z } from "zod";
import { getBuiltinAgentDefinitions } from "../../src/agent/agent-types";
import type { PermissionEngine } from "../../src/approval";
import type { RuntimeConfig } from "../../src/config/runtime";
import { writeKnowledge } from "../../src/knowledge/store";
import type { BundledToolProvider } from "../../src/tools/bundled-provider";
import { makeAssistant, makeStreamFn } from "../helpers/collab";

function makeRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  const providerManager = new ProviderManager({});
  const permissionEngine: PermissionEngine = {
    evaluate: () => "allow",
    remember: () => {},
  };
  const model: Model = {
    id: DEFAULT_ANTHROPIC_MODEL_ID,
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: false,
  };
  return {
    model,
    mode: "default",
    effort: "medium",
    planReminderIntervalTurns: 0,
    systemPrompt: [{ label: "base", content: "test" }],
    streamFunction: () => {
      throw new Error("not implemented");
    },
    diligent: {},
    sources: [],
    configLayers: {},
    discoveredSkills: [],
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
    expect(config.modelConfig?.currentModelId).toBe(DEFAULT_ANTHROPIC_MODEL_ID);
    expect(config.defaultEffort).toBe("medium");
    expect(config.skillNames).toEqual([]);
  });

  it("only exposes models for connected providers", () => {
    const runtimeConfig = makeRuntimeConfig();
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

    // No providers connected → picker shows nothing.
    expect(config.modelConfig?.getAvailableModels()).toEqual([]);

    // Connect Anthropic → only Anthropic models appear, not OpenAI's.
    runtimeConfig.providerManager.setApiKey("anthropic", "sk-ant-test");
    const models = config.modelConfig?.getAvailableModels() ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "anthropic")).toBe(true);
    expect(models.some((m) => m.provider === "openai")).toBe(false);
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

      expect(runtimeConfig.model?.id).toBe(DEFAULT_ANTHROPIC_MODEL_ID);
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
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
      approve: async () => "once",
      ask: async () => null,
    });

    expect(agent.tools.map((tool) => tool.name)).toContain("factory_bundled_tool");
  });

  it("constructs built-in-first Agent-scoped loop hooks once per new Agent", async () => {
    const hookCalls: string[] = [];
    let factoryCalls = 0;
    const runtimeConfig = makeRuntimeConfig({
      planReminderIntervalTurns: 2,
      streamFunction: makeStreamFn([makeAssistant("one"), makeAssistant("two")]),
    });
    const bundledToolProviders: BundledToolProvider[] = [
      {
        id: "loop-hooks",
        createTools: () => [],
        createAgentLoopHooks: (context) => {
          factoryCalls++;
          expect(context.agentKind).toBe("main");
          return [{ id: "product-hook", onPromptStart: () => hookCalls.push("product") }];
        },
      },
    ];
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig, bundledToolProviders });
    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "default",
      effort: "medium",
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
      approve: async () => "once",
      ask: async () => null,
    });

    await agent.prompt({ role: "user", content: "first", timestamp: Date.now() });
    await agent.prompt({ role: "user", content: "second", timestamp: Date.now() });
    expect(factoryCalls).toBe(1);
    expect(hookCalls).toEqual(["product", "product"]);
  });

  it("reads the latest persisted knowledge whenever it creates an agent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "diligent-factory-knowledge-"));
    tempHomes.push(projectRoot);
    const runtimeConfig = makeRuntimeConfig({
      systemPrompt: [
        { label: "base", content: "test" },
        { label: "knowledge", content: "stale knowledge from startup" },
      ],
    });
    const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig });
    const paths = await config.resolvePaths(projectRoot);
    await writeKnowledge(paths.knowledge, [
      {
        id: "project.preference",
        timestamp: "2026-07-12T00:00:00.000Z",
        type: "preference",
        content: "Use npm for package scripts.",
        confidence: 0.8,
      },
    ]);

    const firstAgent = await config.createAgent({
      cwd: projectRoot,
      mode: "default",
      effort: "medium",
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
      approve: async () => "once",
      ask: async () => null,
    });

    await writeKnowledge(paths.knowledge, [
      {
        id: "project.preference",
        timestamp: "2026-07-12T00:01:00.000Z",
        type: "preference",
        content: "Use Bun for package scripts.",
        confidence: 0.8,
      },
    ]);
    const nextSessionAgent = await config.createAgent({
      cwd: projectRoot,
      mode: "default",
      effort: "medium",
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
      approve: async () => "once",
      ask: async () => null,
    });

    const firstKnowledge = firstAgent.systemPrompt.filter((section) => section.label === "knowledge");
    const nextKnowledge = nextSessionAgent.systemPrompt.filter((section) => section.label === "knowledge");
    expect(firstKnowledge).toHaveLength(1);
    expect(firstKnowledge[0]?.content).toContain("Use npm for package scripts.");
    expect(nextKnowledge).toHaveLength(1);
    expect(nextKnowledge[0]?.content).toContain("Use Bun for package scripts.");
    expect(nextKnowledge[0]?.content).not.toContain("stale knowledge from startup");
  });

  it("keeps collab registry parent tools aligned with execute mode filtering", async () => {
    const runtimeConfig = makeRuntimeConfig({
      agentDefinitions: getBuiltinAgentDefinitions(),
      streamFunction: makeStreamFn([makeAssistant("child done")]),
    });
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "execute",
      effort: "medium",
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
      approve: async () => "once",
      ask: async () => null,
    });

    expect(agent.tools.map((tool) => tool.name)).not.toContain("request_user_input");

    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warned.push(String(message));
    try {
      agent.registry?.spawn({ prompt: "inspect", description: "inspect", agentType: "explore" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warned.join("\n")).not.toContain("zero tools after filtering");
  });

  it("keeps nested collab tools available when explicitly enabled after mode filtering", async () => {
    const runtimeConfig = makeRuntimeConfig({
      agentDefinitions: getBuiltinAgentDefinitions(),
      streamFunction: makeStreamFn([makeAssistant("child done")]),
    });
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });
    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "execute",
      effort: "medium",
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
      approve: async () => "once",
      ask: async () => null,
    });

    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warned.push(String(message));
    try {
      agent.registry?.spawn({
        prompt: "inspect",
        description: "inspect",
        agentType: "general",
        allowNestedAgents: true,
        allowedTools: ["spawn_agent", "wait"],
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warned.join("\n")).not.toContain("zero tools after filtering");
  });
});

describe("reloadConfig", () => {
  const tempProjects: string[] = [];

  afterEach(async () => {
    await Promise.all(tempProjects.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("re-discovers skills from disk and refreshes discovered and active skill snapshots", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-factory-home-"));
    tempHomes.push(fakeHome);
    process.env.HOME = fakeHome;

    const projectRoot = await mkdtemp(join(tmpdir(), "diligent-factory-reload-"));
    tempProjects.push(projectRoot);

    try {
      const runtimeConfig = makeRuntimeConfig();
      const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig });
      expect(config.skillNames).toEqual([]);

      const skillDir = join(projectRoot, ".diligent", "skills", "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        ["---", "name: my-skill", "description: A reloaded skill", "---", "", "Do the thing."].join("\n"),
      );

      expect(config.reloadConfig).toBeTypeOf("function");
      const result = await config.reloadConfig?.();

      expect(result?.skills).toEqual([{ name: "my-skill", description: "A reloaded skill" }]);
      expect(runtimeConfig.discoveredSkills.map((skill) => skill.name)).toEqual(["my-skill"]);
      expect(runtimeConfig.skills.map((skill) => skill.name)).toEqual(["my-skill"]);
      expect(config.skillNames).toEqual(["my-skill"]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("reload keeps disabled discovered skills out of active skill names", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-factory-home-"));
    tempHomes.push(fakeHome);
    process.env.HOME = fakeHome;

    const projectRoot = await mkdtemp(join(tmpdir(), "diligent-factory-reload-disabled-"));
    tempProjects.push(projectRoot);

    try {
      const runtimeConfig = makeRuntimeConfig();
      const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig });
      const skillDir = join(projectRoot, ".diligent", "skills", "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        ["---", "name: my-skill", "description: A reloaded skill", "---", "", "Do the thing."].join("\n"),
      );
      await writeFile(
        join(projectRoot, ".diligent", "config.jsonc"),
        JSON.stringify({ skills: { overrides: { "my-skill": false } } }),
      );

      const result = await config.reloadConfig?.();

      expect(result?.skills).toEqual([]);
      expect(runtimeConfig.discoveredSkills.map((skill) => skill.name)).toEqual(["my-skill"]);
      expect(runtimeConfig.skills).toEqual([]);
      expect(config.skillNames).toEqual([]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
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
