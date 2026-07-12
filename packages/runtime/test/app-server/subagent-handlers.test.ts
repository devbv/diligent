// @summary Tests subagent settings list/set handlers.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinAgentDefinitions } from "../../src/agent/agent-types";
import type { ResolvedAgentDefinition } from "../../src/agent/resolved-agent";
import {
  buildSubagentCatalog,
  handleSubagentsList,
  handleSubagentsSet,
  type SubagentConfigManager,
} from "../../src/app-server/subagent-handlers";
import type { ThreadHandlersContext, ThreadRuntime } from "../../src/app-server/thread-handlers";

const tempDirs: string[] = [];

function makeCtx(cwd: string, threads = new Map<string, ThreadRuntime>()): ThreadHandlersContext {
  return {
    activeThreadId: null,
    threads,
    knownCwds: new Set([cwd]),
    getUserId: () => "test-user",
    getPluginHooks: async () => ({ onUserPromptSubmit: [], onStop: [] }),
    resolvePaths: async () => ({ root: cwd, sessions: cwd, knowledge: cwd, skills: cwd, images: cwd }),
    createThreadRuntime: async () => ({}) as ThreadRuntime,
    resolveThreadRuntime: async () => ({ cwd }) as ThreadRuntime,
    getLatestEffortForCwd: async () => "medium",
    getLatestModelForCwd: async () => undefined,
    emit: async () => {},
    consumeTurn: async () => {},
    resolveToolsContext: async () => ({ cwd, tools: undefined }),
    resolveSkillSettingsCwd: async () => cwd,
    resolveSubagentSettingsCwd: async () => cwd,
    getBundledToolProviders: () => [],
    getMcpServers: () => undefined,
    getSkillNames: () => [],
    setActiveThreadId: () => {},
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("subagent handlers", () => {
  it("hides experiment-managed agents and rejects direct settings overrides", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diligent-subagent-experiment-"));
    tempDirs.push(cwd);
    const procedural: ResolvedAgentDefinition = {
      name: "procedural-builder",
      description: "Procedural builder",
      source: "user",
    };
    const manager: SubagentConfigManager = {
      resolve: async () => ({
        cwd,
        config: undefined,
        layers: {},
        catalog: buildSubagentCatalog(getBuiltinAgentDefinitions(), [{ definition: procedural, source: "global" }]),
        experimentManagedAgentNames: new Set(["procedural-builder"]),
      }),
    };

    const listed = await handleSubagentsList(makeCtx(cwd), manager, undefined);
    expect(listed.subagents.map((agent) => agent.name)).not.toContain("procedural-builder");
    await expect(
      handleSubagentsSet(makeCtx(cwd), manager, async () => ({ skills: [] }), {
        overrides: { "procedural-builder": true },
      }),
    ).rejects.toThrow("experiment-managed");
  });

  it("lists required and optional built-ins", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diligent-subagent-handler-"));
    tempDirs.push(cwd);
    const manager: SubagentConfigManager = {
      resolve: async () => ({
        cwd,
        config: undefined,
        layers: {},
        catalog: buildSubagentCatalog(getBuiltinAgentDefinitions(), []),
      }),
    };
    const result = await handleSubagentsList(makeCtx(cwd), manager, undefined);
    expect(result.subagents.map((agent) => [agent.name, agent.required, agent.available])).toEqual([
      ["general", true, true],
      ["explore", false, true],
    ]);
  });

  it("rejects required and project-controlled updates before reloading", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diligent-subagent-handler-"));
    tempDirs.push(cwd);
    const manager: SubagentConfigManager = {
      resolve: async () => ({
        cwd,
        config: { overrides: { explore: false } },
        layers: { project: { agents: { overrides: { explore: false } } } },
        catalog: buildSubagentCatalog(getBuiltinAgentDefinitions(), []),
      }),
    };
    let reloads = 0;
    await expect(
      handleSubagentsSet(makeCtx(cwd), manager, async () => ({ skills: [] }), { overrides: { general: false } }),
    ).rejects.toThrow("required subagent");
    await expect(
      handleSubagentsSet(
        makeCtx(cwd),
        manager,
        async () => {
          reloads += 1;
          return { skills: [] };
        },
        { overrides: { explore: true } },
      ),
    ).rejects.toThrow("project-controlled");
    expect(reloads).toBe(0);
  });

  it("persists optional updates, reloads, and clears cached agents", async () => {
    const home = await mkdtemp(join(tmpdir(), "diligent-subagent-handler-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "diligent-subagent-handler-project-"));
    tempDirs.push(home, cwd);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    await mkdir(join(home, ".diligent"), { recursive: true });
    await Bun.write(
      join(home, ".diligent", "config.jsonc"),
      JSON.stringify({ agents: { overrides: { explore: false } } }),
    );
    let config = { overrides: { explore: false } };
    const manager: SubagentConfigManager = {
      resolve: async () => ({
        cwd,
        config,
        layers: { global: { agents: config } },
        catalog: buildSubagentCatalog(getBuiltinAgentDefinitions(), []),
      }),
    };
    const threads = new Map<string, ThreadRuntime>([["t1", { agent: { id: "agent-1" } } as unknown as ThreadRuntime]]);
    try {
      const result = await handleSubagentsSet(
        makeCtx(cwd, threads),
        manager,
        async () => {
          config = (
            JSON.parse(await Bun.file(join(home, ".diligent", "config.jsonc")).text()) as { agents: typeof config }
          ).agents;
          return { skills: [] };
        },
        { overrides: { explore: true } },
      );
      expect(threads.get("t1")?.agent).toBeUndefined();
      expect(result.subagents.find((agent) => agent.name === "explore")).toMatchObject({
        globalEnabled: true,
        available: true,
      });
      expect(await Bun.file(join(home, ".diligent", "config.jsonc")).text()).not.toContain('"explore"');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
