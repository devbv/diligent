// @summary Parses and validates SKILL.md frontmatter metadata
import { extractMarkdownBody, parseYamlFrontmatter } from "../frontmatter/yaml";
import type { SkillFrontmatter } from "./types";

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Parse SKILL.md content into frontmatter + body.
 */
export function parseFrontmatter(
  content: string,
  filePath: string,
): { frontmatter: SkillFrontmatter; body: string } | { error: string } {
  const parsedResult = parseYamlFrontmatter(content, filePath);
  if ("error" in parsedResult) {
    return parsedResult;
  }

  const parsed = parsedResult.frontmatter;

  // Validate required fields
  if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
    return { error: `${filePath}: frontmatter missing required field: name` };
  }
  if (typeof parsed.description !== "string" || parsed.description.trim() === "") {
    return { error: `${filePath}: frontmatter missing required field: description` };
  }

  const name = parsed.name;
  const description = parsed.description;

  // Validate name format
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `${filePath}: skill name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      error: `${filePath}: skill name must be kebab-case (lowercase alphanumeric with hyphens): "${name}"`,
    };
  }

  // Validate description length
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `${filePath}: skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  // Parse boolean field
  if (parsed["disable-model-invocation"] !== undefined && typeof parsed["disable-model-invocation"] !== "boolean") {
    return { error: `${filePath}: disable-model-invocation must be a boolean` };
  }

  const disableModelInvocation = parsed["disable-model-invocation"] === true;

  const frontmatter: SkillFrontmatter = {
    name,
    description,
  };
  if (disableModelInvocation) {
    frontmatter["disable-model-invocation"] = true;
  }

  return { frontmatter, body: parsedResult.body };
}

/**
 * Skill names are defined by YAML frontmatter.
 * Directory or filename mismatches are allowed for compatibility.
 */
export function validateSkillName(_name: string, _dirName: string): string | null {
  return null;
}

/**
 * Extract body from SKILL.md content (strip frontmatter).
 */
export function extractBody(content: string): string {
  return extractMarkdownBody(content);
}
