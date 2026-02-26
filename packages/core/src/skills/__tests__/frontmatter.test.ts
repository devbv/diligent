import { describe, expect, it } from "bun:test";
import { extractBody, parseFrontmatter, validateSkillName } from "../frontmatter";

describe("parseFrontmatter", () => {
  it("parses valid frontmatter with all fields", () => {
    const content = [
      "---",
      "name: my-skill",
      "description: A useful skill",
      "disable-model-invocation: true",
      "---",
      "# Body content",
      "Some instructions here.",
    ].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A useful skill");
    expect(result.frontmatter["disable-model-invocation"]).toBe(true);
    expect(result.body).toBe("# Body content\nSome instructions here.");
  });

  it("returns error when name is missing", () => {
    const content = ["---", "description: A useful skill", "---", "body"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("missing required field: name");
  });

  it("returns error when description is missing", () => {
    const content = ["---", "name: my-skill", "---", "body"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("missing required field: description");
  });

  it("returns error for invalid name format (uppercase)", () => {
    const content = ["---", "name: MySkill", "description: A skill", "---", "body"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("kebab-case");
    expect(result.error).toContain("MySkill");
  });

  it("returns error when name is too long", () => {
    const longName = "a".repeat(65);
    const content = ["---", `name: ${longName}`, "description: A skill", "---", "body"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("exceeds 64 characters");
  });

  it("returns error when description is too long", () => {
    const longDesc = "a".repeat(1025);
    const content = ["---", "name: my-skill", `description: ${longDesc}`, "---", "body"].join(
      "\n",
    );

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("exceeds 1024 characters");
  });

  it("returns error when no opening --- is present", () => {
    const content = ["name: my-skill", "description: A skill", "---", "body"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("no opening ---");
  });

  it("returns error when no closing --- is present", () => {
    const content = ["---", "name: my-skill", "description: A skill", "body text"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("no closing ---");
  });

  it("parses quoted values correctly (double quotes)", () => {
    const content = [
      "---",
      'name: "my-skill"',
      'description: "A useful skill with: colons"',
      "---",
      "body",
    ].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A useful skill with: colons");
  });

  it("parses quoted values correctly (single quotes)", () => {
    const content = [
      "---",
      "name: 'my-skill'",
      "description: 'A useful skill'",
      "---",
      "body",
    ].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A useful skill");
  });

  it("parses disable-model-invocation: true as boolean", () => {
    const content = [
      "---",
      "name: my-skill",
      "description: A skill",
      "disable-model-invocation: true",
      "---",
      "body",
    ].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter["disable-model-invocation"]).toBe(true);
  });

  it("defaults disable-model-invocation to false (field absent)", () => {
    const content = ["---", "name: my-skill", "description: A skill", "---", "body"].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter["disable-model-invocation"]).toBeUndefined();
  });

  it("skips comment lines in frontmatter", () => {
    const content = [
      "---",
      "# This is a comment",
      "name: my-skill",
      "# Another comment",
      "description: A skill",
      "---",
      "body",
    ].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A skill");
  });

  it("skips empty lines in frontmatter", () => {
    const content = [
      "---",
      "",
      "name: my-skill",
      "",
      "description: A skill",
      "",
      "---",
      "body",
    ].join("\n");

    const result = parseFrontmatter(content, "/test/SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A skill");
  });
});

describe("validateSkillName", () => {
  it("returns null for matching names", () => {
    expect(validateSkillName("my-skill", "my-skill")).toBeNull();
  });

  it("returns error string for mismatched names", () => {
    const result = validateSkillName("my-skill", "other-dir");
    expect(result).not.toBeNull();
    expect(result).toContain("my-skill");
    expect(result).toContain("other-dir");
  });
});

describe("extractBody", () => {
  it("extracts body after frontmatter", () => {
    const content = ["---", "name: my-skill", "description: A skill", "---", "# Body", "Text."].join(
      "\n",
    );

    const body = extractBody(content);
    expect(body).toBe("# Body\nText.");
  });

  it("returns full content if no frontmatter", () => {
    const content = "# Just a markdown file\nWith some text.";
    const body = extractBody(content);
    expect(body).toBe(content);
  });
});
