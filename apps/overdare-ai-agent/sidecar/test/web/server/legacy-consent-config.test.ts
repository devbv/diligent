// @summary Tests best-effort removal of obsolete consent config before strict runtime loading

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyConsentConfig } from "../../../src/web/server/legacy-consent-config";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "diligent-web-consent-"));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("migrateLegacyConsentConfig", () => {
  test("removes consent from global and project JSONC while preserving comments and unrelated keys", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const cwd = join(root, "project");
    const globalPath = join(home, ".overdare-dev", "config.jsonc");
    const projectPath = join(cwd, ".overdare-dev", "config.jsonc");
    await mkdir(join(home, ".overdare-dev"), { recursive: true });
    await mkdir(join(cwd, ".overdare-dev"), { recursive: true });
    const source = `{
  // keep this comment
  "model": { "provider": "openai", "modelId": "test" },
  "consent": { "serviceImprovement": true }
}\n`;
    await writeFile(globalPath, source);
    await writeFile(projectPath, source.replace("true", "false"));

    await migrateLegacyConsentConfig(cwd, { DILIGENT_STORAGE_NAMESPACE: "overdare-dev" }, home);

    for (const path of [globalPath, projectPath]) {
      const migrated = await readFile(path, "utf8");
      expect(migrated).toContain("// keep this comment");
      expect(migrated).toContain('"model"');
      expect(migrated).not.toContain('"consent"');
    }
  });

  test("does nothing for missing files or files without consent", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const cwd = join(root, "project");
    const projectDir = join(cwd, ".overdare");
    const projectPath = join(projectDir, "config.jsonc");
    await mkdir(projectDir, { recursive: true });
    const source = '{\n  // untouched\n  "effort": "high"\n}\n';
    await writeFile(projectPath, source);

    await expect(
      migrateLegacyConsentConfig(cwd, { DILIGENT_STORAGE_NAMESPACE: "overdare" }, home),
    ).resolves.toBeUndefined();
    expect(await readFile(projectPath, "utf8")).toBe(source);
  });
});
