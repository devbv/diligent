// @summary Parses and validates AGENT.md frontmatter metadata
import type { ModelClass } from "@diligent/core/llm/models";
import { TOOL_CAPABILITIES } from "../tools/tool-metadata";
import { parseYamlFrontmatter } from "../util/yaml-frontmatter";
import type { AgentFrontmatter } from "./types";

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MODEL_CLASSES = new Set<ModelClass>(["pro", "general", "lite"]);

function parseToolList(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeToolNames(
  tools: string[],
  filePath: string,
  knownToolNames?: ReadonlySet<string>,
): { tools: string[] } | { error: string } {
  const normalized = new Set<string>();
  const knownNames = knownToolNames ?? new Set(Object.keys(TOOL_CAPABILITIES));
  for (const tool of tools) {
    if (!knownNames.has(tool)) {
      console.warn(`${filePath}: unknown tool in frontmatter: ${tool}`);
    }
    normalized.add(tool);
  }
  return { tools: [...normalized] };
}

export function parseAgentFrontmatter(
  content: string,
  filePath: string,
  options?: { knownToolNames?: Iterable<string> },
): { frontmatter: AgentFrontmatter; body: string } | { error: string } {
  const knownToolNames = options?.knownToolNames ? new Set(options.knownToolNames) : undefined;

  const result = parseYamlFrontmatter(content, filePath);
  if ("error" in result) return result;

  const { parsed, body: rawBody } = result;

  if (!parsed.name) {
    return { error: `${filePath}: frontmatter missing required field: name` };
  }
  if (!parsed.description) {
    return { error: `${filePath}: frontmatter missing required field: description` };
  }
  if (parsed.name.length > MAX_NAME_LENGTH) {
    return { error: `${filePath}: agent name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  if (!NAME_PATTERN.test(parsed.name)) {
    return {
      error: `${filePath}: agent name must be kebab-case (lowercase alphanumeric with hyphens): "${parsed.name}"`,
    };
  }
  if (parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `${filePath}: agent description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  let tools: string[] | undefined;
  if (parsed.tools) {
    const toolResult = normalizeToolNames(parseToolList(parsed.tools), filePath, knownToolNames);
    if ("error" in toolResult) {
      return toolResult;
    }
    tools = toolResult.tools;
  }

  let modelClass: ModelClass | undefined;
  if (parsed.model_class) {
    if (!MODEL_CLASSES.has(parsed.model_class as ModelClass)) {
      return { error: `${filePath}: invalid model_class: ${parsed.model_class}` };
    }
    modelClass = parsed.model_class as ModelClass;
  }

  const body = rawBody.trim();
  if (!body) {
    return { error: `${filePath}: AGENT.md body must not be empty` };
  }

  return {
    frontmatter: {
      name: parsed.name,
      description: parsed.description,
      ...(tools ? { tools } : {}),
      ...(modelClass ? { model_class: modelClass } : {}),
    },
    body,
  };
}

export function validateAgentName(name: string, dirName: string): string | null {
  if (name !== dirName) {
    return `Agent name "${name}" must match directory name "${dirName}"`;
  }
  return null;
}
