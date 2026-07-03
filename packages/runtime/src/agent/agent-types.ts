// @summary Agent type definitions, builtin registry, and role-guidance formatters for spawn_agent

import { parseAgentFrontmatter } from "../agents/frontmatter";
import explorePrompt from "./default/explore.md" with { type: "text" };
import generalPrompt from "./default/general.md" with { type: "text" };
import type { ResolvedAgentDefinition } from "./resolved-agent";

/** Built-in agent type names supported by spawn_agent. */
export const BUILTIN_AGENT_TYPE_NAMES = ["general", "explore"] as const;

export type BuiltinAgentTypeName = (typeof BUILTIN_AGENT_TYPE_NAMES)[number];

export interface AgentTypeSpawnGuidance {
  summary: string;
  whenToUse: string[];
  rules: string[];
  defaultModelClass: "pro" | "general" | "lite" | "same_as_parent";
}

/** Definition of an agent type — controls system prompt, tool access, and turn limits. */
export interface AgentTypeDef {
  name: BuiltinAgentTypeName;
  description: string;
  systemPromptPrefix?: string;
  toolFilter: "all" | "readonly";
  spawnGuidance: AgentTypeSpawnGuidance;
}

function parseBuiltinAgentMarkdown(
  content: string,
  filePath: string,
): {
  description: string;
  systemPromptPrefix: string;
} {
  const result = parseAgentFrontmatter(content, filePath);
  if ("error" in result) {
    throw new Error(result.error);
  }

  return {
    description: result.frontmatter.description,
    systemPromptPrefix: `${result.body.trim()}\n`,
  };
}

const builtinGeneralMarkdown = parseBuiltinAgentMarkdown(generalPrompt, "builtin:general.md");
const builtinExploreMarkdown = parseBuiltinAgentMarkdown(explorePrompt, "builtin:explore.md");

/**
 * Built-in agent types (D063).
 * "general" — full tool access, task tool excluded to prevent infinite nesting (D064).
 * "explore" — parent-visible tools minus plan/read-only disallowed tools.
 */
export const BUILTIN_AGENT_TYPES: Record<BuiltinAgentTypeName, AgentTypeDef> = {
  general: {
    name: "general",
    description: builtinGeneralMarkdown.description,
    systemPromptPrefix: builtinGeneralMarkdown.systemPromptPrefix,
    toolFilter: "all",
    spawnGuidance: {
      summary: "Execution agent for implementation and production work",
      whenToUse: [
        "Implementing features or refactors",
        "Fixing tests, bugs, and regressions",
        "Any task that requires file edits or command execution",
      ],
      rules: [
        "Assign clear ownership (files/responsibility)",
        "Not alone in the codebase: ignore unrelated edits made by others",
      ],
      defaultModelClass: "same_as_parent",
    },
  },
  explore: {
    name: "explore",
    description: builtinExploreMarkdown.description,
    systemPromptPrefix: builtinExploreMarkdown.systemPromptPrefix,
    toolFilter: "readonly",
    spawnGuidance: {
      summary: "Fast, authoritative codebase Q&A for specific scoped questions",
      whenToUse: [
        "Answering narrowly scoped questions about existing code",
        "Researching APIs, behavior, or references without changing files",
        "Running multiple independent investigations in parallel",
      ],
      rules: [
        "Ask only specific, well-scoped questions",
        "Do not re-read/re-search areas already covered by an explorer",
        "Trust explorer results without re-verification",
      ],
      defaultModelClass: "lite",
    },
  },
};

export function getBuiltinAgentDefinitions(): ResolvedAgentDefinition[] {
  return [
    {
      name: "general",
      description: BUILTIN_AGENT_TYPES.general.description,
      source: "builtin",
      systemPromptPrefix: BUILTIN_AGENT_TYPES.general.systemPromptPrefix,
      readonly: false,
    },
    {
      name: "explore",
      description: BUILTIN_AGENT_TYPES.explore.description,
      source: "builtin",
      systemPromptPrefix: BUILTIN_AGENT_TYPES.explore.systemPromptPrefix,
      readonly: true,
      defaultModelClass: "lite",
    },
  ];
}

function modelClassLabel(value: AgentTypeSpawnGuidance["defaultModelClass"]): string {
  if (value === "same_as_parent") return "same as parent";
  return value;
}

function formatGuidanceLine(type: AgentTypeDef): string {
  const whenToUse = type.spawnGuidance.whenToUse.join("; ");
  const rules = type.spawnGuidance.rules.join("; ");
  return (
    `'${type.name}': ${type.spawnGuidance.summary}. ` +
    `Use when: ${whenToUse}. ` +
    `Rules: ${rules}. ` +
    `Default model class: ${modelClassLabel(type.spawnGuidance.defaultModelClass)}.`
  );
}

function formatCustomAgentLine(agent: ResolvedAgentDefinition): string {
  const toolSummary = agent.allowedTools?.length ? agent.allowedTools.join(", ") : "inherit parent-visible tools";
  const modelSummary = agent.defaultModelClass ? ` Default model class: ${agent.defaultModelClass}.` : "";
  return `'${agent.name}': ${agent.description}. Default tools: ${toolSummary}.${modelSummary}`;
}

/** Human-readable role guidance string for spawn_agent's top-level tool description. */
export function formatSpawnAgentToolDescription(
  agentDefinitions: ResolvedAgentDefinition[] = getBuiltinAgentDefinitions(),
): string {
  const builtinLines = BUILTIN_AGENT_TYPE_NAMES.map(
    (name) => `- ${formatGuidanceLine(BUILTIN_AGENT_TYPES[name])}`,
  ).join("\n");
  const customLines = agentDefinitions
    .filter((agent) => agent.source === "user")
    .map((agent) => `- ${formatCustomAgentLine(agent)}`)
    .join("\n");
  const customSection = customLines ? `\nCustom roles:\n${customLines}` : "";
  return (
    "Spawn a sub-agent and return immediately with thread_id and nickname. Use 'wait' to collect results. " +
    "If sub-agents are still running, wait for them before yielding unless the user is asking an explicit question that should be answered first. " +
    "Nested subagents are disabled by default; child agents do not receive collab tools unless you explicitly opt in.\n" +
    "Role selection guide:\n" +
    builtinLines +
    customSection +
    "\n\nDelegation rules:\n" +
    "- Once you delegate work, act as the coordinator: monitor, synthesize, and decide the next step instead of doing the same work in parallel.\n" +
    "- Split work into distinct scopes so child agents do not overlap each other or you.\n" +
    "- Do not duplicate child work. If a child is researching a subsystem or directory, do not search the same area yourself unless you are intentionally taking ownership back. If a child owns a scoped implementation area, do not edit the same area in parallel.\n" +
    "- Do not ask a child agent to spawn or coordinate additional sub-agents unless nested delegation was explicitly enabled for that spawn.\n" +
    "\nPrompt contract:\n" +
    "- Write the prompt as a worker brief, not a slogan. Include the objective, relevant context, what you already learned, the exact scope, and the expected deliverable.\n" +
    "- Do not delegate understanding itself. Figure out the problem enough that you can name the exact question, files, subsystem, or task slice the child owns.\n" +
    "- State boundaries explicitly: what the child should cover, what it should ignore, and any other agent or parent-owned work it must avoid.\n" +
    "- If you need a specific shape back, ask for it directly in the prompt.\n" +
    "- Terse, vague prompts produce shallow results.\n" +
    "\nResult contract:\n" +
    "- Ask for a concise final report rather than a replay of every step when that is all you need.\n" +
    "- If useful, request a simple structure such as result, key files, and risks.\n" +
    "- When results come back, synthesize them for the user instead of pasting raw child output verbatim."
  );
}

/** Human-readable role guidance string for spawn_agent.agent_type schema description. */
export function formatAgentTypeParameterDescription(
  agentDefinitions: ResolvedAgentDefinition[] = getBuiltinAgentDefinitions(),
): string {
  const builtinLines = BUILTIN_AGENT_TYPE_NAMES.map(
    (name) => `- ${formatGuidanceLine(BUILTIN_AGENT_TYPES[name])}`,
  ).join("\n");
  const customLines = agentDefinitions
    .filter((agent) => agent.source === "user")
    .map((agent) => `- ${formatCustomAgentLine(agent)}`)
    .join("\n");
  return customLines
    ? `Agent type to run. Available built-in and custom roles:\n${builtinLines}\n${customLines}`
    : `Agent type to run. Available built-in roles:\n${builtinLines}`;
}
