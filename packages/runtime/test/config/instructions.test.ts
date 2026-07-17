// @summary Tests for instruction discovery and system prompt building
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenSections } from "@diligent/core/prompt-contract";
import { buildSystemPrompt, discoverInstructions } from "@diligent/runtime/config";

const TEST_ROOT = join(tmpdir(), `diligent-instructions-test-${Date.now()}`);

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("discoverInstructions", () => {
  it("finds AGENTS.md in cwd", async () => {
    const projectDir = join(TEST_ROOT, "project");
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, "AGENTS.md"), "# Instructions\nUse Bun.");

    const result = await discoverInstructions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("# Instructions\nUse Bun.");
    expect(result[0].path).toBe(join(projectDir, "AGENTS.md"));
  });

  it("returns empty when no AGENTS.md is found", async () => {
    const emptyDir = join(TEST_ROOT, "empty");
    await mkdir(emptyDir, { recursive: true });
    // Create a .git so it doesn't traverse up
    await mkdir(join(emptyDir, ".git"));

    const result = await discoverInstructions(emptyDir);
    expect(result).toEqual([]);
  });

  it("stops at .git boundary", async () => {
    // Structure: parent/AGENTS.md, parent/.git, parent/sub/
    const parent = join(TEST_ROOT, "parent");
    const sub = join(parent, "sub");
    await mkdir(sub, { recursive: true });
    await mkdir(join(parent, ".git"));
    await Bun.write(join(parent, "AGENTS.md"), "parent instructions");

    // Starting from sub, should find parent's AGENTS.md,
    // then stop because parent has .git
    const result = await discoverInstructions(sub);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("parent instructions");
  });

  it("finds AGENTS.md at cwd even if cwd has .git", async () => {
    const projectDir = join(TEST_ROOT, "git-project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, ".git"));
    await Bun.write(join(projectDir, "AGENTS.md"), "project root instructions");

    const result = await discoverInstructions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("project root instructions");
  });

  it("truncates large files", async () => {
    const projectDir = join(TEST_ROOT, "large");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, ".git"));
    const large = "x".repeat(40_000); // > 32 KiB
    await Bun.write(join(projectDir, "AGENTS.md"), large);

    const result = await discoverInstructions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBeLessThan(large.length);
    expect(result[0].content).toContain("...(truncated)");
  });
});

describe("buildSystemPrompt", () => {
  it("returns base section when no instructions", () => {
    const result = buildSystemPrompt("You are helpful.", []);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("base");
    expect(result[0].content).toBe("You are helpful.");
  });

  it("includes discovered instructions as tagged sections", () => {
    const result = buildSystemPrompt("Base.", [{ path: "/p/AGENTS.md", content: "Use Bun." }]);
    expect(result[0].content).toBe("Base.");
    const instrSection = result.find((s) => s.tag === "user_instructions");
    expect(instrSection).toBeDefined();
    expect(instrSection!.tagAttributes?.path).toBe("/p/AGENTS.md");
    expect(instrSection!.content).toBe("Use Bun.");
    expect(instrSection!.cacheControl).toBe("ephemeral");
    // flattenSections produces XML-wrapped output
    const flat = flattenSections(result);
    expect(flat).toContain('<user_instructions path="/p/AGENTS.md">');
    expect(flat).toContain("</user_instructions>");
  });

  it("includes additional instructions from config", () => {
    const result = buildSystemPrompt("Base.", [], ["Always test", "Be brief"]);
    const flat = flattenSections(result);
    expect(flat).toContain("Always test");
    expect(flat).toContain("Be brief");
  });

  it("combines all sources", () => {
    const result = buildSystemPrompt("Base.", [{ path: "/p/AGENTS.md", content: "From file." }], ["From config."]);
    const flat = flattenSections(result);
    expect(flat).toContain("Base.");
    expect(flat).toContain("From file.");
    expect(flat).toContain("From config.");
  });
});
