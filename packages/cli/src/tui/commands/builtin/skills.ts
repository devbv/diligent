import type { SkillMetadata } from "@diligent/core";
import { extractBody } from "@diligent/core";
import { ListPicker, type ListPickerItem } from "../../components/list-picker";
import type { Command } from "../types";

/**
 * /skill:name — Invoke a skill by name.
 */
export function createSkillInvokeCommand(skillName: string, skill: SkillMetadata): Command {
  return {
    name: `skill:${skillName}`,
    description: skill.description,
    hidden: true,
    handler: async (args, ctx) => {
      // Read SKILL.md body from disk
      const content = await Bun.file(skill.path).text();
      const body = extractBody(content);

      ctx.displayLines([`  \x1b[2mSkill loaded: ${skill.name}\x1b[0m`]);

      // Inject as user message with skill prefix and run agent
      const message = `[Using skill: ${skill.name}]\n\n${body}`;
      if (args) {
        await ctx.runAgent(`${message}\n\n${args}`);
      } else {
        await ctx.runAgent(message);
      }
    },
  };
}

/**
 * /skills — Show skills picker overlay.
 */
export const skillsPickerCommand: Command = {
  name: "skills",
  description: "Browse and invoke skills",
  handler: async (_args, ctx) => {
    if (ctx.skills.length === 0) {
      ctx.displayLines([
        "  \x1b[2mNo skills found.\x1b[0m",
        "  Add skills to .diligent/skills/ or ~/.config/diligent/skills/",
      ]);
      return;
    }

    const items: ListPickerItem[] = ctx.skills.map(s => ({
      label: s.name,
      description: s.description,
      value: s.name,
    }));

    return new Promise<void>(resolve => {
      const picker = new ListPicker({ title: "Skills", items }, async (value) => {
        handle.hide();
        ctx.requestRender();
        if (value) {
          const skill = ctx.skills.find(s => s.name === value);
          if (skill) {
            const cmd = createSkillInvokeCommand(skill.name, skill);
            await cmd.handler(undefined, ctx);
          }
        }
        resolve();
      });
      const handle = ctx.showOverlay(picker, { anchor: "center" });
      ctx.requestRender();
    });
  },
};
