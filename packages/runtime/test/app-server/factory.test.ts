// @summary Tests for createAppServerConfig factory — validates config assembly and override merging
import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalImageLoader } from "@diligent/core/image-contract";
import type { Model } from "@diligent/core/provider-contract";
import { ProviderManager } from "@diligent/core/provider-contract";
import type { Tool, ToolOutputFileStore } from "@diligent/core/tool-contract";
import { z } from "zod";
import { getBuiltinAgentDefinitions } from "../../src/agent/agent-types";
import { createAppServerConfig, filterToolsByMode } from "../../src/app-server/factory";
import type { PermissionEngine } from "../../src/approval";
import type { RuntimeConfig } from "../../src/config/runtime";
import { toolOutputStore } from "../../src/infrastructure";

import { writeKnowledge } from "../../src/knowledge/store";
import type { BundledToolProvider } from "../../src/tools/bundled-provider";
import { makeAssistant, makeStreamFn } from "../helpers/collab";

mock.module("@test/factory-plugin", () => ({
  manifest: { name: "@test/factory-plugin", apiVersion: "1.0", version: "0.1.0" },
  createTools: () => [
    {
      name: "factory_plugin_tool",
      description: "Factory plugin tool",
      parameters: z.object({}),
      execute: async () => ({ output: "ok" }),
    },
  ],
}));

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-5";

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  const providerManager = new ProviderManager({});
  const permissionEngine: PermissionEngine = {
    evaluate: () => "allow",
    remember: () => {},
  };
  const model: Model = {
    modelId: TEST_ANTHROPIC_MODEL_ID,
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
    expect(config.pluginDiscovery).toBe("global");
    expect(config.resolvePaths).toBeTypeOf("function");
    expect(config.createAgent).toBeTypeOf("function");
    expect(config.compaction).toEqual(runtimeConfig.compaction);
    expect(config.providerManager).toBe(runtimeConfig.providerManager);
    expect(config.authStore).toEqual(runtimeConfig.authStore);
    expect(config.permissionEngine).toBe(runtimeConfig.permissionEngine);
    expect(config.modelConfig).toBeDefined();
    expect(config.modelConfig?.currentModel).toMatchObject({ provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID });
    expect(config.defaultEffort).toBe("medium");
    expect(config.skillNames).toEqual([]);
  });

  it("propagates explicit plugin discovery through config and agent assembly", async () => {
    const runtimeConfig = makeRuntimeConfig({
      diligent: { tools: { plugins: [{ package: "@test/factory-plugin", enabled: true }] } },
    });
    const config = createAppServerConfig({
      cwd: "/tmp/test",
      runtimeConfig,
      pluginDiscovery: "explicit",
    });

    expect(config.pluginDiscovery).toBe("explicit");
    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "default",
      effort: "medium",
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });
    expect(agent.tools.map((tool) => tool.name)).toContain("factory_plugin_tool");
  });

  it("injects a local image loader bound to the main agent cwd", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "diligent-main-image-loader-"));
    tempHomes.push(projectRoot);
    await writeFile(join(projectRoot, "image.png"), "main-image");
    const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig: makeRuntimeConfig() });
    const agent = await config.createAgent({
      cwd: projectRoot,
      mode: "default",
      effort: "medium",
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });
    const loader = (agent as unknown as { localImageLoader?: LocalImageLoader }).localImageLoader;

    const bytes = await loader?.load({ type: "local_image", path: "image.png", mediaType: "image/png" });

    expect(Buffer.from(bytes!).toString("utf8")).toBe("main-image");
  });

  it("injects an optional tool output store while preserving the production default", async () => {
    const injectedStore: ToolOutputFileStore = { save: async () => "/tmp/injected-output.txt" };
    const request = {
      cwd: "/tmp/test",
      mode: "default" as const,
      effort: "medium" as const,
      model: { provider: "anthropic" as const, modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once" as const,
      ask: async () => null,
    };

    const defaultAgent = await createAppServerConfig({
      cwd: "/tmp/test",
      runtimeConfig: makeRuntimeConfig(),
    }).createAgent(request);
    const injectedAgent = await createAppServerConfig({
      cwd: "/tmp/test",
      runtimeConfig: makeRuntimeConfig(),
      toolOutputStore: injectedStore,
    }).createAgent(request);

    expect((defaultAgent as unknown as { toolOutputStore?: ToolOutputFileStore }).toolOutputStore).toBe(
      toolOutputStore,
    );
    expect((injectedAgent as unknown as { toolOutputStore?: ToolOutputFileStore }).toolOutputStore).toBe(injectedStore);
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

  it("modelConfig.onModelChange updates runtimeConfig.model and persists the selection", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-factory-home-"));
    tempHomes.push(fakeHome);
    process.env.HOME = fakeHome;

    try {
      const runtimeConfig = makeRuntimeConfig();
      const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

      config.modelConfig?.onModelChange({ provider: "anthropic", modelId: "claude-haiku-4-5-20251001" });
      expect(runtimeConfig.model?.modelId).toBe("claude-haiku-4-5-20251001");

      const configPath = join(fakeHome, ".diligent", "config.jsonc");
      await waitFor(
        async () =>
          (await Bun.file(configPath).exists()) &&
          (await Bun.file(configPath).text()).includes("claude-haiku-4-5-20251001"),
      );
      expect(await Bun.file(configPath).text()).toContain('"modelId": "claude-haiku-4-5-20251001"');
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

      config.modelConfig?.onModelChange(
        { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
        "thread-child",
      );

      expect(runtimeConfig.model?.modelId).toBe(TEST_ANTHROPIC_MODEL_ID);
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
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });

    expect(agent.tools.map((tool) => tool.name)).toContain("factory_bundled_tool");
  });

  it("transforms the final mode-filtered tool list without changing the default path", async () => {
    const runtimeConfig = makeRuntimeConfig();
    const baseline = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });
    const baselineAgent = await baseline.createAgent({
      cwd: "/tmp/test",
      mode: "plan",
      effort: "medium",
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });
    let observed: { names: string[]; cwd: string; mode: string; provider: string } | undefined;
    const transformed = createAppServerConfig({
      cwd: "/tmp/test",
      runtimeConfig,
      transformTools: (tools, context) => {
        observed = { names: tools.map((tool) => tool.name), ...context };
        return tools.filter((tool) => tool.name === "read");
      },
    });
    const transformedAgent = await transformed.createAgent({
      cwd: "/tmp/test",
      mode: "plan",
      effort: "medium",
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });

    expect(observed).toEqual({
      names: baselineAgent.tools.map((tool) => tool.name),
      cwd: "/tmp/test",
      mode: "plan",
      provider: "anthropic",
    });
    expect(observed?.names).not.toContain("bash");
    expect(transformedAgent.tools.map((tool) => tool.name)).toEqual(["read"]);
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
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
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
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
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
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
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
    const observedChildToolNames: string[][] = [];
    const childStream = makeStreamFn([makeAssistant("child done")]);
    const runtimeConfig = makeRuntimeConfig({
      agentDefinitions: getBuiltinAgentDefinitions(),
      streamFunction: (model, context, options) => {
        observedChildToolNames.push(context.tools.map((tool) => tool.name));
        return childStream(model, context, options);
      },
    });
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });

    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "execute",
      effort: "medium",
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });

    expect(agent.tools.map((tool) => tool.name)).not.toContain("request_user_input");

    const registry = agent.registry!;
    const { threadId } = registry.spawn({ prompt: "inspect", description: "inspect", agentType: "explore" });
    await registry.wait([threadId], 5000);

    expect(observedChildToolNames[0]).toContain("read");
    expect(observedChildToolNames[0]).not.toContain("request_user_input");
  });

  it("keeps nested collab tools available when explicitly enabled after mode filtering", async () => {
    const observedChildToolNames: string[][] = [];
    const childStream = makeStreamFn([makeAssistant("child done")]);
    const runtimeConfig = makeRuntimeConfig({
      agentDefinitions: getBuiltinAgentDefinitions(),
      streamFunction: (model, context, options) => {
        observedChildToolNames.push(context.tools.map((tool) => tool.name));
        return childStream(model, context, options);
      },
    });
    const config = createAppServerConfig({ cwd: "/tmp/test", runtimeConfig });
    const agent = await config.createAgent({
      cwd: "/tmp/test",
      mode: "execute",
      effort: "medium",
      model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID },
      approve: async () => "once",
      ask: async () => null,
    });

    const registry = agent.registry!;
    const { threadId } = registry.spawn({
      prompt: "inspect",
      description: "inspect",
      agentType: "general",
      allowNestedAgents: true,
      allowedTools: ["spawn_agent", "wait"],
    });
    await registry.wait([threadId], 5000);

    expect(observedChildToolNames[0]).toContain("spawn_agent");
    expect(observedChildToolNames[0]).toContain("wait");
    expect(observedChildToolNames[0]).not.toContain("send_input");
    expect(observedChildToolNames[0]).not.toContain("close_agent");
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

describe("filterToolsByMode", () => {
  function tool(name: string): Tool {
    return { name, description: name, parameters: z.object({}), execute: async () => ({ output: "" }) };
  }

  it("removes mutation tools in plan mode while preserving read-like tools", () => {
    const filtered = filterToolsByMode("plan", [
      tool("read"),
      tool("web_action"),
      tool("overdaresearch"),
      tool("mcp_run_tool"),
      tool("bash"),
      tool("write"),
      tool("update_knowledge"),
    ]).map((entry) => entry.name);

    expect(filtered).toEqual(["read", "web_action", "overdaresearch", "mcp_run_tool"]);
  });

  it("removes request_user_input in execute mode", () => {
    const filtered = filterToolsByMode("execute", [
      tool("request_user_input"),
      tool("read"),
      tool("bash"),
      tool("overdaresearch"),
    ]).map((entry) => entry.name);

    expect(filtered).toEqual(["read", "bash", "overdaresearch"]);
  });

  it("keeps every tool in default mode", () => {
    const filtered = filterToolsByMode("default", [tool("request_user_input"), tool("bash")]).map(
      (entry) => entry.name,
    );
    expect(filtered).toEqual(["request_user_input", "bash"]);
  });
});
