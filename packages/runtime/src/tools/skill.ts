// @summary Skill tool that loads SKILL.md content into conversation context without exposing file-read tool calls

import type { Tool, ToolRegistryBuilder, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import { extractBody, type SkillMetadata } from "../skills";

const SkillParams = z.object({
  name: z.string().describe("Skill name from the available skills list"),
});

export function createSkillTool(skills: SkillMetadata[]): Tool<typeof SkillParams> {
  const availableSkills = skills.filter((skill) => !skill.disableModelInvocation);
  const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));

  const description =
    availableSkills.length === 0
      ? "Load a specialized skill. No skills are currently available."
      : [
          "Load a specialized skill with domain-specific instructions and workflow.",
          "Use this tool when the user request matches one of these skills:",
          ...availableSkills.map((skill) => `- ${skill.name}: ${skill.description}`),
        ].join("\n");

  return {
    name: "skill",
    description,
    parameters: SkillParams,
    supportParallel: true,
    async execute(args): Promise<ToolResult> {
      const selected = byName.get(args.name);
      if (!selected) {
        const list = availableSkills.map((skill) => skill.name).join(", ");
        return {
          output: `Skill "${args.name}" not found. Available skills: ${list || "none"}`,
          metadata: { error: true },
        };
      }

      let content: string;
      try {
        content = await Bun.file(selected.path).text();
      } catch (error) {
        return {
          output: `Failed to load skill "${selected.name}" from ${selected.path}: ${error instanceof Error ? error.message : String(error)}`,
          metadata: { error: true },
        };
      }

      const body = extractBody(content).trim();
      if (!body) {
        return {
          output: `Skill "${selected.name}" has empty content.`,
          metadata: { error: true },
        };
      }

      return {
        output: [
          `<skill_content name="${selected.name}">`,
          `# Skill: ${selected.name}`,
          "",
          body,
          "",
          `Base directory: ${selected.baseDir}`,
          "Resolve relative paths in this skill against the base directory.",
          "</skill_content>",
        ].join("\n"),
      };
    },
  };
}

export function registerSkillTool(builder: ToolRegistryBuilder, skills: SkillMetadata[]): ToolRegistryBuilder {
  return builder.register(createSkillTool(skills));
}
