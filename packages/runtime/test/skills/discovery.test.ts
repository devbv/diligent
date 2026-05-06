// @summary Tests for skill discovery and filesystem scanning
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../src/skills/discovery";

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "diligent-skills-test-"));
  return tmpDir;
}

afterEach(async () => {
  delete process.env.DILIGENT_STORAGE_NAMESPACE;
  if (tmpDir) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

function makeSkillMd(name: string, description: string, extra?: string): string {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (extra) lines.push(extra);
  lines.push("---", "", "# Instructions", "Do the thing.");
  return lines.join("\n");
}

describe("discoverSkills", () => {
  it("discovers skill from .diligent/skills/my-skill/SKILL.md", async () => {
    const root = await createTmpDir();
    const skillDir = join(root, ".diligent", "skills", "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), makeSkillMd("my-skill", "A test skill"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].description).toBe("A test skill");
    expect(result.skills[0].source).toBe("project");
    expect(result.skills[0].path).toBe(join(skillDir, "SKILL.md"));
    expect(result.skills[0].disableModelInvocation).toBe(false);
  });

  it("discovers flat skill from .diligent/skills/my-skill.md", async () => {
    const root = await createTmpDir();
    const skillsDir = join(root, ".diligent", "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "my-skill.md"), makeSkillMd("my-skill", "A flat skill"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].description).toBe("A flat skill");
    expect(result.skills[0].source).toBe("project");
  });

  it("prefers the YAML skill name even when the folder name differs", async () => {
    const root = await createTmpDir();
    const skillDir = join(root, ".diligent", "skills", "folder-name-does-not-match");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), makeSkillMd("yaml-skill-name", "Uses frontmatter name"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("yaml-skill-name");
    expect(result.skills[0].path).toBe(join(skillDir, "SKILL.md"));
  });

  it("prefers the YAML skill name even for flat markdown files", async () => {
    const root = await createTmpDir();
    const skillsDir = join(root, ".diligent", "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      join(skillsDir, "filename-does-not-match.md"),
      makeSkillMd("yaml-flat-name", "Uses frontmatter name"),
    );

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("yaml-flat-name");
  });

  it("skips hidden directories", async () => {
    const root = await createTmpDir();
    const hiddenDir = join(root, ".diligent", "skills", ".hidden-skill");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(join(hiddenDir, "SKILL.md"), makeSkillMd("hidden-skill", "Should be skipped"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.skills).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips node_modules", async () => {
    const root = await createTmpDir();
    const nmDir = join(root, ".diligent", "skills", "node_modules");
    await mkdir(nmDir, { recursive: true });
    await writeFile(join(nmDir, "SKILL.md"), makeSkillMd("node-modules", "Should be skipped"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.skills).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("first-loaded wins for name collisions (dedup)", async () => {
    const root = await createTmpDir();

    // Project skill (loaded first)
    const projectDir = join(root, ".diligent", "skills", "my-skill");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "SKILL.md"), makeSkillMd("my-skill", "Project version"));

    // Global skill (loaded second, same name)
    const globalDir = join(root, "global-config", "skills", "my-skill");
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "SKILL.md"), makeSkillMd("my-skill", "Global version"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "global-config") });

    // Only one skill loaded — the project one
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].description).toBe("Project version");
    expect(result.skills[0].source).toBe("project");

    // Dedup produces a warning error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("already loaded");
  });

  it("handles missing directories gracefully (no errors)", async () => {
    const root = await createTmpDir();
    // Don't create any skill directories

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.skills).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("reports invalid frontmatter as errors but continues scanning", async () => {
    const root = await createTmpDir();
    const skillsDir = join(root, ".diligent", "skills");

    // Invalid skill (no frontmatter)
    const badDir = join(skillsDir, "bad-skill");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "SKILL.md"), "No frontmatter here");

    // Valid skill
    const goodDir = join(skillsDir, "good-skill");
    await mkdir(goodDir, { recursive: true });
    await writeFile(join(goodDir, "SKILL.md"), makeSkillMd("good-skill", "A good skill"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "no-global") });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("good-skill");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("missing frontmatter");
  });

  it("scans multiple discovery roots in order", async () => {
    const root = await createTmpDir();

    // Project skill
    const projectDir = join(root, ".diligent", "skills", "project-skill");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "SKILL.md"), makeSkillMd("project-skill", "From project"));

    // Global skill
    const globalDir = join(root, "global-config");
    const globalSkillDir = join(globalDir, "skills", "global-skill");
    await mkdir(globalSkillDir, { recursive: true });
    await writeFile(join(globalSkillDir, "SKILL.md"), makeSkillMd("global-skill", "From global"));

    // Config path skill
    const configPathDir = join(root, "extra-skills");
    const configSkillDir = join(configPathDir, "config-skill");
    await mkdir(configSkillDir, { recursive: true });
    await writeFile(join(configSkillDir, "SKILL.md"), makeSkillMd("config-skill", "From config path"));

    const result = await discoverSkills({
      cwd: root,
      globalConfigDir: globalDir,
      additionalPaths: [configPathDir],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(3);

    const names = result.skills.map((s) => s.name);
    expect(names).toContain("project-skill");
    expect(names).toContain("global-skill");
    expect(names).toContain("config-skill");

    // Verify sources
    const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));
    expect(byName["project-skill"].source).toBe("project");
    expect(byName["global-skill"].source).toBe("global");
    expect(byName["config-skill"].source).toBe("config");
  });

  it("uses the selected storage namespace for project and global roots", async () => {
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    const root = await createTmpDir();
    const skillDir = join(root, ".overdare", "skills", "my-skill");
    const globalDir = join(root, "global-config", ".overdare", "skills", "global-skill");
    await mkdir(skillDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), makeSkillMd("my-skill", "Project branded"));
    await writeFile(join(globalDir, "SKILL.md"), makeSkillMd("global-skill", "Global branded"));

    const result = await discoverSkills({ cwd: root, globalConfigDir: join(root, "global-config", ".overdare") });
    expect(result.skills.map((skill) => skill.name)).toEqual(["my-skill", "global-skill"]);
  });
});
