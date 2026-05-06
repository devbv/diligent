// @summary Discovers skills from project, global, and config-specified directories
import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProjectDirName } from "../infrastructure/diligent-dir";
import { parseFrontmatter } from "./frontmatter";
import type { SkillLoadError, SkillLoadResult, SkillMetadata } from "./types";

export interface DiscoveryOptions {
  /** Project root (cwd) */
  cwd: string;
  /** Global config directory (default: ~/.diligent) */
  globalConfigDir?: string;
  /** Additional skill paths from config */
  additionalPaths?: string[];
}

/**
 * Discover skills from all configured locations.
 *
 * Discovery order (first-loaded wins for name collisions):
 * 1. Project: .diligent/skills/
 * 2. Global: ~/.diligent/skills/
 * 3. Config paths: skills.paths[] from config.jsonc
 */
export async function discoverSkills(options: DiscoveryOptions): Promise<SkillLoadResult> {
  const skills: SkillMetadata[] = [];
  const errors: SkillLoadError[] = [];
  const seen = new Map<string, string>(); // name → first path

  for (const { dir, source } of getDiscoveryRoots(options)) {
    await scanSkillDirectory(dir, source, skills, errors, seen);
  }

  return { skills, errors };
}

function resolveGlobalConfigDir(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), resolveProjectDirName());
}

function getDiscoveryRoots(options: DiscoveryOptions): Array<{ dir: string; source: SkillMetadata["source"] }> {
  const roots: Array<{ dir: string; source: SkillMetadata["source"] }> = [];

  // 1. Project local
  roots.push({ dir: join(options.cwd, resolveProjectDirName(), "skills"), source: "project" });

  // 2. Global
  const globalDir = options.globalConfigDir ?? resolveGlobalConfigDir();
  roots.push({ dir: join(globalDir, "skills"), source: "global" });

  // 3. Additional config paths
  for (const p of options.additionalPaths ?? []) {
    roots.push({ dir: p, source: "config" });
  }

  return roots;
}

async function scanSkillDirectory(
  dir: string,
  source: SkillMetadata["source"],
  skills: SkillMetadata[],
  errors: SkillLoadError[],
  seen: Map<string, string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
  } catch {
    // Directory doesn't exist — not an error
    return;
  }

  for (const entry of entries) {
    // Skip hidden directories and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      // Look for SKILL.md in subdirectory
      const skillPath = join(dir, entry.name, "SKILL.md");
      await loadSkill(skillPath, source, skills, errors, seen);
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
      // Flat skill: foo.md directly in root
      const skillPath = join(dir, entry.name);
      await loadSkill(skillPath, source, skills, errors, seen);
    }
  }
}

async function loadSkill(
  skillPath: string,
  source: SkillMetadata["source"],
  skills: SkillMetadata[],
  errors: SkillLoadError[],
  seen: Map<string, string>,
): Promise<void> {
  let content: string;
  try {
    const file = Bun.file(skillPath);
    if (!(await file.exists())) return;
    content = await file.text();
  } catch (err) {
    errors.push({
      path: skillPath,
      message: `Failed to read: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const result = parseFrontmatter(content, skillPath);
  if ("error" in result) {
    errors.push({ path: skillPath, message: result.error });
    return;
  }

  const { frontmatter } = result;

  // Dedup check
  const existing = seen.get(frontmatter.name);
  if (existing) {
    errors.push({
      path: skillPath,
      message: `Skill "${frontmatter.name}" already loaded from ${existing} (skipped)`,
    });
    return;
  }

  // Resolve the real base directory
  let baseDir: string;
  try {
    const realSkillPath = await realpath(skillPath);
    baseDir = join(realSkillPath, "..");
  } catch {
    baseDir = join(skillPath, "..");
  }

  seen.set(frontmatter.name, skillPath);
  skills.push({
    name: frontmatter.name,
    description: frontmatter.description,
    path: skillPath,
    baseDir,
    source,
    disableModelInvocation: frontmatter["disable-model-invocation"] ?? false,
  });
}
