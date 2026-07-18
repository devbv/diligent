// @summary Tests for .diligent directory initialization and structure
import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STORAGE_NAMESPACE,
  ensureDiligentDir,
  resolvePaths,
  resolveProjectDirName,
  resolveStorageNamespace,
} from "@diligent/runtime/infrastructure";

const TEST_ROOT = join(tmpdir(), `diligent-test-${Date.now()}`);

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("resolvePaths", () => {
  it("returns correct subdirectory paths", () => {
    const base = join("/project", ".diligent");
    const paths = resolvePaths("/project");
    expect(paths.root).toBe(base);
    expect(paths.sessions).toBe(join(base, "sessions"));
    expect(paths.knowledge).toBe(join(base, "knowledge"));
    expect(paths.skills).toBe(join(base, "skills"));
    expect(paths.images).toBe(join(base, "images"));
  });

  it("supports a branded namespace from env", () => {
    const env = { DILIGENT_STORAGE_NAMESPACE: "overdare" } as NodeJS.ProcessEnv;
    const base = join("/project", ".overdare");
    const paths = resolvePaths("/project", env);
    expect(resolveStorageNamespace(env)).toBe("overdare");
    expect(resolveProjectDirName(env)).toBe(".overdare");
    expect(paths.root).toBe(base);
  });

  it("preserves the generic runtime namespace compatibility contract without env", () => {
    expect(resolveStorageNamespace({} as NodeJS.ProcessEnv)).toBe(DEFAULT_STORAGE_NAMESPACE);
    expect(resolveProjectDirName({} as NodeJS.ProcessEnv)).toBe(".diligent");
  });
});

describe("ensureDiligentDir", () => {
  it("creates all subdirectories", async () => {
    const paths = await ensureDiligentDir(TEST_ROOT);

    expect(await Bun.file(join(paths.sessions, ".")).exists()).toBe(false); // dir exists check
    const sessionsGlob = new Bun.Glob("*");
    // Verify dirs exist by checking we can scan them
    const sessionEntries = [];
    for await (const f of sessionsGlob.scan(paths.sessions)) sessionEntries.push(f);
    expect(sessionEntries).toEqual([]); // empty dir, but scannable

    const knowledgeEntries = [];
    for await (const f of sessionsGlob.scan(paths.knowledge)) knowledgeEntries.push(f);
    expect(knowledgeEntries).toEqual([]);

    const imageEntries = [];
    for await (const f of sessionsGlob.scan(paths.images)) imageEntries.push(f);
    expect(imageEntries).toEqual([]);
  });

  it("creates .gitignore with correct content", async () => {
    const paths = await ensureDiligentDir(TEST_ROOT);

    const gitignorePath = join(paths.root, ".gitignore");
    const content = await Bun.file(gitignorePath).text();
    expect(content).toContain("sessions/");
    expect(content).toContain("knowledge/");
    expect(content).toContain("images/");
    expect(content).not.toContain("skills/");
  });

  it("creates branded namespace directories when env is set", async () => {
    const env = { DILIGENT_STORAGE_NAMESPACE: "overdare" } as NodeJS.ProcessEnv;
    const paths = await ensureDiligentDir(TEST_ROOT, env);
    expect(paths.root).toBe(join(TEST_ROOT, ".overdare"));
    expect(await Bun.file(join(paths.root, ".gitignore")).exists()).toBe(true);
  });

  it("is idempotent — second call does not overwrite .gitignore", async () => {
    await ensureDiligentDir(TEST_ROOT);

    // Modify .gitignore
    const paths = resolvePaths(TEST_ROOT);
    const gitignorePath = join(paths.root, ".gitignore");
    await Bun.write(gitignorePath, "custom content\n");

    await ensureDiligentDir(TEST_ROOT);

    const content = await Bun.file(gitignorePath).text();
    expect(content).toBe("custom content\n");
  });
});
