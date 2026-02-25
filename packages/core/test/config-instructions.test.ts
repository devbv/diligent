import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, discoverInstructions } from "../src/config/instructions";

const TEST_ROOT = join(tmpdir(), `diligent-instructions-test-${Date.now()}`);

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("discoverInstructions", () => {
  it("finds CLAUDE.md in cwd", async () => {
    const projectDir = join(TEST_ROOT, "project");
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, "CLAUDE.md"), "# Instructions\nUse Bun.");

    const result = await discoverInstructions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("# Instructions\nUse Bun.");
    expect(result[0].path).toBe(join(projectDir, "CLAUDE.md"));
  });

  it("returns empty when no CLAUDE.md found", async () => {
    const emptyDir = join(TEST_ROOT, "empty");
    await mkdir(emptyDir, { recursive: true });
    // Create a .git so it doesn't traverse up
    await mkdir(join(emptyDir, ".git"));

    const result = await discoverInstructions(emptyDir);
    expect(result).toEqual([]);
  });

  it("stops at .git boundary", async () => {
    // Structure: parent/CLAUDE.md, parent/.git, parent/sub/
    const parent = join(TEST_ROOT, "parent");
    const sub = join(parent, "sub");
    await mkdir(sub, { recursive: true });
    await mkdir(join(parent, ".git"));
    await Bun.write(join(parent, "CLAUDE.md"), "parent instructions");

    // Starting from sub, should find parent's CLAUDE.md,
    // then stop because parent has .git
    const result = await discoverInstructions(sub);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("parent instructions");
  });

  it("finds CLAUDE.md at cwd even if cwd has .git", async () => {
    const projectDir = join(TEST_ROOT, "git-project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, ".git"));
    await Bun.write(join(projectDir, "CLAUDE.md"), "project root instructions");

    const result = await discoverInstructions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("project root instructions");
  });

  it("truncates large files", async () => {
    const projectDir = join(TEST_ROOT, "large");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, ".git"));
    const large = "x".repeat(40_000); // > 32 KiB
    await Bun.write(join(projectDir, "CLAUDE.md"), large);

    const result = await discoverInstructions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBeLessThan(large.length);
    expect(result[0].content).toContain("...(truncated)");
  });
});

describe("buildSystemPrompt", () => {
  it("returns base prompt when no instructions", () => {
    const result = buildSystemPrompt("You are helpful.", []);
    expect(result).toBe("You are helpful.");
  });

  it("includes discovered instructions", () => {
    const result = buildSystemPrompt("Base.", [{ path: "/p/CLAUDE.md", content: "Use Bun." }]);
    expect(result).toContain("Base.");
    expect(result).toContain("Instructions from: /p/CLAUDE.md");
    expect(result).toContain("Use Bun.");
  });

  it("includes additional instructions from config", () => {
    const result = buildSystemPrompt("Base.", [], ["Always test", "Be brief"]);
    expect(result).toContain("Always test");
    expect(result).toContain("Be brief");
  });

  it("combines all sources", () => {
    const result = buildSystemPrompt("Base.", [{ path: "/p/CLAUDE.md", content: "From file." }], ["From config."]);
    expect(result).toContain("Base.");
    expect(result).toContain("From file.");
    expect(result).toContain("From config.");
  });
});
