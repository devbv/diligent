import type { SkillMetadata } from "./types";

/**
 * Render the skills section for the system prompt.
 * Only includes skills where disableModelInvocation is false.
 * Returns empty string if no skills are available.
 */
export function renderSkillsSection(skills: SkillMetadata[]): string {
  const implicitSkills = skills.filter((s) => !s.disableModelInvocation);
  if (implicitSkills.length === 0) return "";

  const lines = [
    "## Available Skills",
    "",
    "Skills are local instruction sets you can use when a task matches their description.",
    "",
    "### Skills",
    "",
  ];

  for (const skill of implicitSkills) {
    lines.push(`- **${skill.name}**: ${skill.description} (file: ${skill.path})`);
  }

  lines.push("");
  lines.push("### How to use skills");
  lines.push("");
  lines.push("1. When a user's task matches a skill description, or the user mentions a skill by name, use it.");
  lines.push("2. To use a skill, read its SKILL.md file with the read tool to get the full instructions.");
  lines.push("3. Follow the instructions in the skill file. Resolve relative paths against the skill's directory.");
  lines.push("4. Read only what you need — don't bulk-load entire directories referenced by the skill.");
  lines.push("5. If a skill's instructions conflict with the user's request, follow the user's request.");

  return lines.join("\n");
}
