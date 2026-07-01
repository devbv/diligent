import type { SkillMetadata } from "@diligent/runtime";
import type { CommandRegistry } from "../registry";
import { compactCommand } from "./compact";
import { effortCommand } from "./effort";
import { helpCommand } from "./help";
import { mcpCommand } from "./mcp";
import { bugCommand, clearCommand, configCommand, costCommand, exitCommand, versionCommand } from "./misc";
import { modelCommand } from "./model";
import { providerCommand } from "./provider";
import { reloadCommand } from "./reload";
import { deleteCommand, newCommand, resumeCommand, statusCommand } from "./session";
import { createSkillInvokeCommand, skillsPickerCommand } from "./skills";
import { toolsCommand } from "./tools";

export function registerBuiltinCommands(registry: CommandRegistry, skills: SkillMetadata[]): void {
  registry.register(helpCommand);
  registry.register(effortCommand);
  registry.register(modelCommand);
  registry.register(providerCommand);
  registry.register(toolsCommand);
  registry.register(mcpCommand);
  registry.register(newCommand);
  registry.register(resumeCommand);
  registry.register(deleteCommand);
  registry.register(statusCommand);
  registry.register(compactCommand);
  registry.register(clearCommand);
  registry.register(exitCommand);
  registry.register(versionCommand);
  registry.register(configCommand);
  registry.register(costCommand);
  registry.register(bugCommand);
  registry.register(reloadCommand);
  registry.register(skillsPickerCommand);

  const builtinNames = new Set(registry.list().map((command) => command.name));

  // Register dynamic skill commands (/skill-name). Builtin commands win on collision.
  for (const skill of skills) {
    if (builtinNames.has(skill.name)) {
      continue;
    }
    registry.register(createSkillInvokeCommand(skill.name, skill));
  }
}
