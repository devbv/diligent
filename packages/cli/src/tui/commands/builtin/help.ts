import { t } from "../../theme";
import type { Command } from "../types";

export const helpCommand: Command = {
  name: "help",
  description: "Show available commands",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    const commands = ctx.registry.list().filter(c => !c.hidden);
    const lines = [
      "",
      `${t.bold}  Commands:${t.reset}`,
      "",
      ...commands.map(c => {
        const name = `/${c.name}`.padEnd(18);
        return `  ${t.accent}${name}${t.reset} ${c.description}`;
      }),
      "",
    ];
    ctx.displayLines(lines);
  },
};
