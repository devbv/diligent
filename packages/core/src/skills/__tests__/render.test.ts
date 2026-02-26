import { describe, expect, it } from "bun:test";
import { renderSkillsSection } from "../render";
import type { SkillMetadata } from "../types";

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "test-skill",
    description: "A test skill",
    path: "/project/.diligent/skills/test-skill/SKILL.md",
    baseDir: "/project/.diligent/skills/test-skill",
    source: "project",
    disableModelInvocation: false,
    ...overrides,
  };
}

describe("renderSkillsSection", () => {
  it("returns empty string for empty skills list", () => {
    expect(renderSkillsSection([])).toBe("");
  });

  it("filters out skills with disableModelInvocation=true", () => {
    const skills = [
      makeSkill({ name: "visible", disableModelInvocation: false }),
      makeSkill({ name: "hidden", disableModelInvocation: true }),
    ];
    const result = renderSkillsSection(skills);
    expect(result).toContain("visible");
    expect(result).not.toContain("hidden");
  });

  it("renders single skill with name, description, and path", () => {
    const skills = [
      makeSkill({
        name: "my-skill",
        description: "Does something useful",
        path: "/project/.diligent/skills/my-skill/SKILL.md",
      }),
    ];
    const result = renderSkillsSection(skills);
    expect(result).toContain("**my-skill**");
    expect(result).toContain("Does something useful");
    expect(result).toContain("/project/.diligent/skills/my-skill/SKILL.md");
  });

  it("renders multiple skills", () => {
    const skills = [
      makeSkill({ name: "skill-a", description: "First skill" }),
      makeSkill({ name: "skill-b", description: "Second skill" }),
      makeSkill({ name: "skill-c", description: "Third skill" }),
    ];
    const result = renderSkillsSection(skills);
    expect(result).toContain("**skill-a**");
    expect(result).toContain("**skill-b**");
    expect(result).toContain("**skill-c**");
    expect(result).toContain("First skill");
    expect(result).toContain("Second skill");
    expect(result).toContain("Third skill");
  });

  it("returns empty string when all skills have disableModelInvocation=true", () => {
    const skills = [
      makeSkill({ name: "a", disableModelInvocation: true }),
      makeSkill({ name: "b", disableModelInvocation: true }),
    ];
    expect(renderSkillsSection(skills)).toBe("");
  });

  it("includes 'Available Skills' header", () => {
    const skills = [makeSkill()];
    const result = renderSkillsSection(skills);
    expect(result).toContain("## Available Skills");
  });

  it("includes 'How to use skills' section", () => {
    const skills = [makeSkill()];
    const result = renderSkillsSection(skills);
    expect(result).toContain("### How to use skills");
    expect(result).toContain("read its SKILL.md file");
    expect(result).toContain("Resolve relative paths against the skill's directory");
  });
});
