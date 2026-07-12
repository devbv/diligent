// @summary Tests skill settings list/set handlers.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillsList, handleSkillsSet, type SkillConfigManager } from "../../src/app-server/skill-handlers";
import type { ThreadHandlersContext, ThreadRuntime } from "../../src/app-server/thread-handlers";
import type { DiligentConfig } from "../../src/config/schema";
import type { SkillMetadata } from "../../src/skills";

const tempDirs: string[] = [];

function makeSkill(name: string): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source: "project",
    disableModelInvocation: false,
  };
}

function makeCtx(cwd: string, threads = new Map<string, ThreadRuntime>()): ThreadHandlersContext {
  return {
    activeThreadId: null,
    threads,
    knownCwds: new Set([cwd]),
    getUserId: () => "test-user",
    getPluginHooks: async () => ({ onUserPromptSubmit: [], onStop: [] }),
    resolvePaths: async () => ({
      root: join(cwd, ".diligent"),
      sessions: join(cwd, ".diligent", "sessions"),
      knowledge: join(cwd, ".diligent", "knowledge"),
      skills: join(cwd, ".diligent", "skills"),
      images: join(cwd, ".diligent", "images"),
    }),
    createThreadRuntime: async () => ({}) as ThreadRuntime,
    resolveThreadRuntime: async () => ({ cwd }) as ThreadRuntime,
    getLatestEffortForCwd: async () => "medium",
    getLatestModelForCwd: async () => undefined,
    emit: async () => {},
    consumeTurn: async () => {},
    resolveToolsContext: async () => ({ cwd, tools: undefined }),
    resolveSkillSettingsCwd: async () => cwd,
    getBundledToolProviders: () => [],
    getMcpServers: () => undefined,
    getSkillNames: () => [],
    setActiveThreadId: () => {},
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skill handlers", () => {
  it("lists discovered skills with global/effective state and provenance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diligent-skill-handlers-"));
    tempDirs.push(cwd);
    const manager: SkillConfigManager = {
      resolve: async () => ({
        cwd,
        config: { overrides: { alpha: false } },
        layers: { global: { skills: { overrides: { alpha: false } } } },
        discoveredSkills: [makeSkill("alpha"), makeSkill("beta")],
      }),
    };

    const result = await handleSkillsList(makeCtx(cwd), manager, undefined);

    expect(result.appliesOnNextTurn).toBe(true);
    expect(result.skillsEnabled).toBe(true);
    expect(result.skillsEnabledControlledBy).toBe("default");
    expect(
      result.skills.map((skill) => [skill.name, skill.globalEnabled, skill.effectiveEnabled, skill.available]),
    ).toEqual([
      ["alpha", false, false, false],
      ["beta", true, true, true],
    ]);
  });

  it("persists global overrides, reloads, and clears cached agents after success", async () => {
    const home = await mkdtemp(join(tmpdir(), "diligent-skill-handler-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "diligent-skill-handler-project-"));
    tempDirs.push(home, cwd);
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    const threads = new Map<string, ThreadRuntime>([
      ["t1", { agent: { id: "agent-1" } } as unknown as ThreadRuntime],
      ["t2", { agent: { id: "agent-2" } } as unknown as ThreadRuntime],
    ]);
    let currentConfig: DiligentConfig["skills"] = { overrides: { alpha: false } };
    const manager: SkillConfigManager = {
      resolve: async () => ({
        cwd,
        config: currentConfig,
        layers: { global: currentConfig ? { skills: currentConfig } : undefined },
        discoveredSkills: [makeSkill("alpha")],
      }),
    };
    let reloaded = false;

    try {
      const result = await handleSkillsSet(
        makeCtx(cwd, threads),
        manager,
        async () => {
          reloaded = true;
          const text = await Bun.file(join(home, ".diligent", "config.jsonc")).text();
          currentConfig = JSON.parse(text).skills;
          return { skills: [{ name: "alpha", description: "alpha description" }] };
        },
        { overrides: { alpha: true } },
      );

      expect(reloaded).toBe(true);
      expect(threads.get("t1")?.agent).toBeUndefined();
      expect(threads.get("t2")?.agent).toBeUndefined();
      expect(result.skills[0]).toMatchObject({ name: "alpha", globalEnabled: true, effectiveEnabled: true });
      const text = await Bun.file(join(home, ".diligent", "config.jsonc")).text();
      expect(text).not.toContain('"alpha"');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("rejects project-controlled override keys before writing or reloading", async () => {
    const home = await mkdtemp(join(tmpdir(), "diligent-skill-handler-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "diligent-skill-handler-project-"));
    tempDirs.push(home, cwd);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    await mkdir(join(home, ".diligent"), { recursive: true });
    await writeFile(join(home, ".diligent", "config.jsonc"), `{ "model": "gpt-4o" }`);
    const manager: SkillConfigManager = {
      resolve: async () => ({
        cwd,
        config: { overrides: { alpha: false } },
        layers: { project: { skills: { overrides: { alpha: false } } } },
        discoveredSkills: [makeSkill("alpha")],
      }),
    };
    let reloadCount = 0;

    try {
      await expect(
        handleSkillsSet(
          makeCtx(cwd),
          manager,
          async () => {
            reloadCount += 1;
            return { skills: [] };
          },
          { overrides: { alpha: true } },
        ),
      ).rejects.toThrow("project-controlled");
      expect(reloadCount).toBe(0);
      expect(await Bun.file(join(home, ".diligent", "config.jsonc")).text()).toContain('"model": "gpt-4o"');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
