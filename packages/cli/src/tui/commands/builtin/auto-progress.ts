// @summary Auto progress mode command for the TUI settings surface

import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import { t } from "../../theme";
import type { Command } from "../types";

const ENABLED_ALIASES = new Set(["on", "true", "yes", "enable", "enabled"]);
const DISABLED_ALIASES = new Set(["off", "false", "no", "disable", "disabled"]);

function parseAutoProgressMode(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (ENABLED_ALIASES.has(normalized)) return true;
  if (DISABLED_ALIASES.has(normalized)) return false;
  return null;
}

export const autoProgressCommand: Command = {
  name: "auto-progress",
  description: "Toggle auto progress mode",
  supportsArgs: true,
  handler: async (args, ctx) => {
    const enabled = parseAutoProgressMode(args);
    if (enabled === null) {
      ctx.displayError("Usage: /auto-progress <on|off>");
      return;
    }

    const rpc = ctx.app.getRpcClient?.();
    if (!rpc) {
      ctx.displayError("App server is not available.");
      return;
    }

    const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET, { autoProgressMode: enabled });
    const applied = response.autoProgressMode ?? enabled;
    ctx.displayLines([
      `  Auto progress mode ${t.bold}${applied ? "enabled" : "disabled"}${t.reset}`,
      `  ${t.dim}Run /reload or open a new session to apply this change.${t.reset}`,
    ]);
    ctx.requestRender();
  },
};
