// @summary Verifies how the Studio API version is resolved from env var and config file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOverdareConfig, resolveApiVersion } from "../../../src/tools/studiorpc/config";

const createdDirs: string[] = [];
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousVersion: string | undefined;

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "studio-api-version-"));
  createdDirs.push(home);
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  return home;
}

function writeConfig(home: string, config: unknown): void {
  const dir = join(home, ".overdare");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "overdare.jsonc"), typeof config === "string" ? config : JSON.stringify(config));
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousVersion = process.env.STUDIO_API_VERSION;
  delete process.env.STUDIO_API_VERSION;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousVersion === undefined) delete process.env.STUDIO_API_VERSION;
  else process.env.STUDIO_API_VERSION = previousVersion;
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveApiVersion", () => {
  test("falls back to v1 when nothing is configured", () => {
    makeHome();
    expect(resolveApiVersion()).toBe("v1");
  });

  test("selects v2 only for the exact string v2", () => {
    makeHome();
    const rejected = ["v1", "V2", "v2 ", " v2", "2", "true", "V1", "latest", ""];

    process.env.STUDIO_API_VERSION = "v2";
    expect(resolveApiVersion()).toBe("v2");

    for (const value of rejected) {
      process.env.STUDIO_API_VERSION = value;
      expect(resolveApiVersion()).toBe("v1");
    }
  });

  test("reads apiVersion from the config file", () => {
    const home = makeHome();
    writeConfig(home, { host: "1.2.3.4", apiVersion: "v2" });
    expect(resolveApiVersion()).toBe("v2");

    writeConfig(home, { apiVersion: "v1" });
    expect(resolveApiVersion()).toBe("v1");
  });

  test("treats a non-string apiVersion as v1", () => {
    const home = makeHome();
    writeConfig(home, { apiVersion: { instance: "v2", script: "v1" } });
    expect(resolveApiVersion()).toBe("v1");
  });

  test("treats an unparseable config file as v1", () => {
    const home = makeHome();
    writeConfig(home, "{ not json");
    expect(resolveApiVersion()).toBe("v1");
  });

  test("lets the environment variable win over the config file", () => {
    const home = makeHome();
    writeConfig(home, { apiVersion: "v2" });
    process.env.STUDIO_API_VERSION = "v1";
    expect(resolveApiVersion()).toBe("v1");

    writeConfig(home, { apiVersion: "v1" });
    process.env.STUDIO_API_VERSION = "v2";
    expect(resolveApiVersion()).toBe("v2");
  });

  test("bypasses the loadOverdareConfig cache so the file can change mid-process", () => {
    const home = makeHome();
    writeConfig(home, { apiVersion: "v1" });
    // Populate the module-level cache before the version is flipped on disk.
    loadOverdareConfig();
    expect(resolveApiVersion()).toBe("v1");

    writeConfig(home, { apiVersion: "v2" });
    expect(resolveApiVersion()).toBe("v2");
  });
});
