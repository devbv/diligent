import type { SkillMetadata } from "@diligent/core";
import type { CommandRegistry } from "../registry";
import { compactCommand } from "./compact";
import { helpCommand } from "./help";
import { bugCommand, clearCommand, configCommand, costCommand, exitCommand, versionCommand } from "./misc";
import { modelCommand } from "./model";
import { reloadCommand } from "./reload";
import { newCommand, resumeCommand, statusCommand } from "./session";
import { createSkillInvokeCommand, skillsPickerCommand } from "./skills";

export function registerBuiltinCommands(
  registry: CommandRegistry,
  skills: SkillMetadata[],
): void {
  registry.register(helpCommand);
  registry.register(modelCommand);
  registry.register(newCommand);
  registry.register(resumeCommand);
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

  // Register dynamic skill commands
  for (const skill of skills) {
    registry.register(createSkillInvokeCommand(skill.name, skill));
  }
}
