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
  const lines = content.split("\n");

  // Must start with ---
  if (lines[0]?.trim() !== "---") {
    return { error: `${filePath}: missing frontmatter (no opening ---)` };
  }

  // Find closing ---
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIdx = i;
      break;
    }
  }

  if (closingIdx === -1) {
    return { error: `${filePath}: missing frontmatter (no closing ---)` };
  }

  // Parse key-value pairs
  const kvLines = lines.slice(1, closingIdx);
  const parsed: Record<string, string> = {};

  for (const line of kvLines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      return { error: `${filePath}: invalid frontmatter line: ${trimmed}` };
    }

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  // Validate required fields
  if (!parsed.name) {
    return { error: `${filePath}: frontmatter missing required field: name` };
  }
  if (!parsed.description) {
    return { error: `${filePath}: frontmatter missing required field: description` };
  }

  // Validate name format
  if (parsed.name.length > MAX_NAME_LENGTH) {
    return { error: `${filePath}: skill name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  if (!NAME_PATTERN.test(parsed.name)) {
    return {
      error: `${filePath}: skill name must be kebab-case (lowercase alphanumeric with hyphens): "${parsed.name}"`,
    };
  }

  // Validate description length
  if (parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `${filePath}: skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  // Parse boolean field
  const disableModelInvocation = parsed["disable-model-invocation"] === "true";

  const frontmatter: SkillFrontmatter = {
    name: parsed.name,
    description: parsed.description,
  };
  if (disableModelInvocation) {
    frontmatter["disable-model-invocation"] = true;
  }

  // Extract body (everything after closing ---)
  const body = lines.slice(closingIdx + 1).join("\n");

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
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }

  return content;
}
