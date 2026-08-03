// @summary Verifies OVERDARE bootstrap config and bundled skill contracts.

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiligentConfig } from "@diligent/runtime/config";
import { discoverSkills } from "@diligent/runtime/skills";
import { OVERDARE_EXPERIMENTS } from "../src/experiments";

const originalHome = process.env.HOME;
const originalStorageNamespace = process.env.DILIGENT_STORAGE_NAMESPACE;
let testRoot: string | undefined;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStorageNamespace === undefined) delete process.env.DILIGENT_STORAGE_NAMESPACE;
  else process.env.DILIGENT_STORAGE_NAMESPACE = originalStorageNamespace;
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

describe("OVERDARE bootstrap config", () => {
  test("enables the procedural experiment by default", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "overdare-bootstrap-config-"));
    const globalConfigDir = join(testRoot, ".overdare");
    await mkdir(globalConfigDir, { recursive: true });
    await cp(join(import.meta.dir, "../../bootstrap/config.jsonc"), join(globalConfigDir, "config.jsonc"));
    process.env.HOME = testRoot;
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";

    const { config } = await loadDiligentConfig(testRoot);

    expect(OVERDARE_EXPERIMENTS.some((experiment) => experiment.id === "procedural")).toBe(true);
    expect(config.experiments?.overrides?.procedural).toBe(true);
  });

  test("ships the build-and-playtest loop as an on-demand skill", async () => {
    const skillsDir = join(import.meta.dir, "../../bootstrap/skills");
    const skill = await readFile(join(skillsDir, "build-playtest-loop/SKILL.md"), "utf-8");
    const prompt = await readFile(join(import.meta.dir, "../../bootstrap/system-prompt.txt"), "utf-8");
    const discovery = await discoverSkills({
      cwd: import.meta.dir,
      globalConfigDir: join(import.meta.dir, "__no_global__"),
      additionalPaths: [skillsDir],
    });

    expect(skill).toContain("name: build-playtest-loop");
    expect(skill).toContain("Do not design the game around one hard-coded W/Space sequence.");
    expect(skill).toContain("Call `studio_playtest_goal` exactly once");
    expect(skill).toContain("Call `studio_playtest_scripted` exactly once");
    expect(skill).toContain('checkpoint("TOKEN")');
    expect(skill).toContain("does not prove real player input");
    expect(skill).toContain("awaitSpawnedCharacter");
    expect(skill).toContain("awaitPlayableCharacter");
    expect(skill).toContain("moveCharacterTo");
    expect(skill).toContain("Never accept `MoveToFinished` alone as proof");
    expect(skill).toContain("SpawnLocation");
    expect(skill).toContain("**Game failure:** `GOAL_NOT_OBSERVED`");
    expect(discovery.errors.filter((error) => error.path.includes("build-playtest-loop"))).toEqual([]);
    expect(discovery.skills.find((entry) => entry.name === "build-playtest-loop")).toMatchObject({
      source: "config",
      disableModelInvocation: false,
    });
    expect(prompt).not.toContain("<playtest-tools>");
  });
});
