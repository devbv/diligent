import type { Command } from "../types";

export const reloadCommand: Command = {
  name: "reload",
  description: "Reload config and skills",
  handler: async (_args, ctx) => {
    await ctx.reload();
    ctx.displayLines(["  \x1b[2mConfig and skills reloaded.\x1b[0m"]);
  },
};
