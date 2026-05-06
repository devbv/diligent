// @summary Parses and validates SKILL.md frontmatter metadata
import { extractFrontmatterBody, parseYamlFrontmatter } from "../util/yaml-frontmatter";
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
  const result = parseYamlFrontmatter(content, filePath);
  if ("error" in result) return result;

  const { parsed, body } = result;

  if (!parsed.name) {
    return { error: `${filePath}: frontmatter missing required field: name` };
  }
  if (!parsed.description) {
    return { error: `${filePath}: frontmatter missing required field: description` };
  }

  if (parsed.name.length > MAX_NAME_LENGTH) {
    return { error: `${filePath}: skill name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  if (!NAME_PATTERN.test(parsed.name)) {
    return {
      error: `${filePath}: skill name must be kebab-case (lowercase alphanumeric with hyphens): "${parsed.name}"`,
    };
  }

  if (parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `${filePath}: skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  const disableModelInvocation = parsed["disable-model-invocation"] === "true";

  const frontmatter: SkillFrontmatter = {
    name: parsed.name,
    description: parsed.description,
  };
  if (disableModelInvocation) {
    frontmatter["disable-model-invocation"] = true;
  }

  return { frontmatter, body };
}

/**
 * Validate that skill name matches its parent directory name.
 */
export function validateSkillName(name: string, dirName: string): string | null {
  if (name !== dirName) {
    return `Skill name "${name}" must match directory name "${dirName}"`;
  }
  return null;
}

/**
 * Extract body from SKILL.md content (strip frontmatter).
 */
export function extractBody(content: string): string {
  return extractFrontmatterBody(content);
}
