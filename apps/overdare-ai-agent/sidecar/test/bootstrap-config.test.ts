// @summary Verifies OVERDARE bootstrap config enables advertised product experiments by default.

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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
