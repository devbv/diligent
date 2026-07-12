// @summary Verifies experiment state gates the effective runtime skill and tool names together.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../../src/config/runtime";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runtime experiment gating", () => {
  it("removes both managed skill and tool by default and restores both from one override", async () => {
    const home = await mkdtemp(join(tmpdir(), "diligent-experiment-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "diligent-experiment-project-"));
    tempDirs.push(home, cwd);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    const skillDir = join(cwd, ".diligent", "skills", "procedural-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: procedural-skill\ndescription: Procedural test skill\n---\nUse procedural_tool.",
    );
    const paths = {
      root: join(cwd, ".diligent"),
      sessions: join(cwd, ".diligent", "sessions"),
      knowledge: join(cwd, ".diligent", "knowledge"),
      skills: join(cwd, ".diligent", "skills"),
      images: join(cwd, ".diligent", "images"),
    };
    const experimentDefinitions = [
      {
        id: "procedural",
        title: "Procedural",
        description: "Procedural preview",
        defaultEnabled: false,
        toolNames: ["procedural_tool"],
        skillNames: ["procedural-skill"],
      },
    ];

    try {
      const disabled = await loadRuntimeConfig(cwd, paths, { experimentDefinitions });
      expect(disabled.skills.map((skill) => skill.name)).not.toContain("procedural-skill");
      expect(disabled.disabledToolNames).toEqual(new Set(["procedural_tool"]));

      await mkdir(join(home, ".diligent"), { recursive: true });
      await writeFile(
        join(home, ".diligent", "config.jsonc"),
        JSON.stringify({ experiments: { overrides: { procedural: true } } }),
      );
      const enabled = await loadRuntimeConfig(cwd, paths, { experimentDefinitions });
      expect(enabled.skills.map((skill) => skill.name)).toContain("procedural-skill");
      expect(enabled.disabledToolNames.size).toBe(0);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
