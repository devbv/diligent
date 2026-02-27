import { t } from "../../theme";
import type { Command } from "../types";

export const compactCommand: Command = {
  name: "compact",
  description: "Trigger manual compaction",
  handler: async (_args, ctx) => {
    if (!ctx.sessionManager) {
      ctx.displayError("No .diligent/ directory — compaction not available.");
      return;
    }
    ctx.displayLines([`  ${t.dim}Compaction is triggered automatically. Use /status to see token usage.${t.reset}`]);
  },
};
