// @summary Shared YAML frontmatter parsing helpers for markdown-based runtime metadata files
import { parse as parseYaml } from "yaml";

export interface ParsedYamlFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseYamlFrontmatter(content: string, filePath: string): ParsedYamlFrontmatter | { error: string } {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { error: `${filePath}: missing frontmatter (no opening ---)` };
  }

  let closingIdx = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === "---") {
      closingIdx = index;
      break;
    }
  }

  if (closingIdx === -1) {
    return { error: `${filePath}: missing frontmatter (no closing ---)` };
  }

  const rawFrontmatter = lines.slice(1, closingIdx).join("\n");

  let parsed: unknown;
  try {
    parsed = parseYaml(rawFrontmatter);
  } catch (error) {
    return {
      error: `${filePath}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed == null) {
    parsed = {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${filePath}: frontmatter must be a YAML mapping` };
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body: lines.slice(closingIdx + 1).join("\n"),
  };
}

export function extractMarkdownBody(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;

  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === "---") {
      return lines.slice(index + 1).join("\n");
    }
  }

  return content;
}
