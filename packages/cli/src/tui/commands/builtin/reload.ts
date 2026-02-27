import { t } from "../../theme";
import type { Command } from "../types";

export const reloadCommand: Command = {
  name: "reload",
  description: "Reload config and skills",
  handler: async (_args, ctx) => {
    await ctx.reload();
    ctx.displayLines([`  ${t.dim}Config and skills reloaded.${t.reset}`]);
  },
};
