// @summary Tests atomic product experiment persistence and response refresh.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExperimentsList, handleExperimentsSet } from "../../src/app-server/experiment-handlers";
import { resolveExperimentStates } from "../../src/experiments";

const definitions = [
  {
    id: "procedural",
    title: "Procedural generation",
    description: "Procedural preview.",
    defaultEnabled: false,
    toolNames: ["procedural_tool"],
    skillNames: ["procedural-skill"],
  },
];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("experiment handlers", () => {
  it("persists one override, reloads once, and returns the refreshed coupled state", async () => {
    const home = await mkdtemp(join(tmpdir(), "diligent-experiments-"));
    tempDirs.push(home);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    let states = resolveExperimentStates(definitions, undefined);
    let reloads = 0;
    const manager = { getDefinitions: () => definitions, getExperiments: () => states };

    try {
      expect(handleExperimentsList(manager).experiments[0]?.enabled).toBe(false);
      const result = await handleExperimentsSet(
        manager,
        async () => {
          reloads += 1;
          states = resolveExperimentStates(definitions, { procedural: true });
          return { skills: [] };
        },
        new Map(),
        { overrides: { procedural: true } },
      );
      expect(reloads).toBe(1);
      expect(result.experiments[0]?.enabled).toBe(true);
      expect(await Bun.file(join(home, ".diligent", "config.jsonc")).json()).toMatchObject({
        experiments: { overrides: { procedural: true } },
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("rejects experiment ids not advertised by the product", async () => {
    const manager = {
      getDefinitions: () => definitions,
      getExperiments: () => resolveExperimentStates(definitions, undefined),
    };
    await expect(
      handleExperimentsSet(manager, async () => ({ skills: [] }), new Map(), { overrides: { unknown: true } }),
    ).rejects.toThrow("Unknown experiment");
  });
});
