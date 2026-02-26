import type { Command } from "../types";

export const helpCommand: Command = {
  name: "help",
  description: "Show available commands",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    const commands = ctx.registry.list().filter(c => !c.hidden);
    const lines = [
      "",
      "\x1b[1m  Commands:\x1b[0m",
      "",
      ...commands.map(c => {
        const name = `/${c.name}`.padEnd(18);
        return `  \x1b[36m${name}\x1b[0m ${c.description}`;
      }),
      "",
    ];
    ctx.displayLines(lines);
  },
};
