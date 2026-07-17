// @summary Tests for skill tool loading behavior and error handling
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ToolRegistryBuilder } from "@diligent/core/tool-contract";
import type { SkillMetadata } from "../../src/skills";
import { createSkillTool, registerSkillTool } from "../../src/tools/skill";

function makeSkill(name: string, path: string): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    path,
    baseDir: dirname(path),
    source: "project",
    disableModelInvocation: false,
  };
}

describe("createSkillTool", () => {
  const toolContext = {
    toolCallId: "tc",
    signal: new AbortController().signal,
    abort: () => {},
  };

  it("loads a known skill and returns skill_content envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-skill-tool-"));
    const filePath = join(root, "SKILL.md");
    await writeFile(filePath, "---\nname: tidy-plan\ndescription: test\n---\n\n# Tidy Plan\nDo work", "utf8");

    const tool = createSkillTool([makeSkill("tidy-plan", filePath)]);
    const result = await tool.execute({ name: "tidy-plan" }, toolContext);

    expect(result.output).toContain('<skill_content name="tidy-plan">');
    expect(result.output).toContain("# Tidy Plan");
    expect(result.output).toContain("Base directory:");

    await rm(root, { recursive: true, force: true });
  });

  it("returns error metadata when skill name is unknown", async () => {
    const tool = createSkillTool([]);
    const result = await tool.execute({ name: "missing" }, toolContext);

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain('Skill "missing" not found');
  });

  it("returns error metadata when skill content body is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-skill-tool-empty-"));
    const filePath = join(root, "SKILL.md");
    await writeFile(filePath, "---\nname: tidy-plan\ndescription: test\n---\n", "utf8");

    const tool = createSkillTool([makeSkill("tidy-plan", filePath)]);
    const result = await tool.execute({ name: "tidy-plan" }, toolContext);

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("has empty content");

    await rm(root, { recursive: true, force: true });
  });

  it("registerSkillTool adds the skill tool to a registry builder", () => {
    const builder = new ToolRegistryBuilder();
    registerSkillTool(builder, []);
    const registry = builder.build();
    expect(registry.get("skill")).toBeDefined();
  });
});
