// @summary Verifies OVERDARE bootstrap config defaults and essential cross-tool prompt policy.

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
  test("keeps cross-tool play-test policy without duplicating individual tool definitions", async () => {
    const prompt = await readFile(join(import.meta.dir, "../../bootstrap/system-prompt.txt"), "utf-8");

    expect(prompt).toContain("spatial directions and locations in the user's current viewport");
    expect(prompt).toContain("drive it yourself with the play-test input tools");
    expect(prompt).toContain("Ask the user to play-test by hand only when");
    expect(prompt).not.toContain("<play-test-input>");
    expect(prompt).not.toContain("`studiorpc_game_pie_status` ");
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
