// @summary Verifies OVERDARE bootstrap config defaults and play-test prompt contracts.

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiligentConfig } from "@diligent/runtime/config";
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
  test("describes working key movement and the short input/read feedback loop", async () => {
    const prompt = await readFile(join(import.meta.dir, "../../bootstrap/system-prompt.txt"), "utf-8");

    expect(prompt).toContain("W A S D do drive the built-in walk axes in this Studio build");
    expect(prompt).toContain("affected by acceleration, collisions, and camera facing");
    expect(prompt).toContain("For walls, jumps, corners");
    expect(prompt).toContain("send a short key batch");
    expect(prompt).toContain("then call `studiorpc_game_character_read`");
    expect(prompt).toContain("For a distant destination, prefer `move_to`");
    expect(prompt).not.toContain("Treat W A S D as no-ops for movement");
  });

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
});
