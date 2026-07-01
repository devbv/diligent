// @summary Diligent collaboration mode definitions: Mode, tool allow-list, prompt suffixes
import type { Mode as ProtocolMode } from "@diligent/protocol";
import { PLAN_MODE_ALLOWED_TOOLS } from "../tools/tool-metadata";
import executePrompt from "./default/execute.md" with { type: "text" };
import planPrompt from "./default/plan.md" with { type: "text" };

// D087: Collaboration modes
export type Mode = ProtocolMode;

/**
 * Tools available in plan mode (read-only exploration only).
 * Bash, write, apply_patch, edit, multi_edit, update_knowledge are excluded.
 * D088: request_user_input is allowed in all modes.
 * Source of truth: TOOL_CAPABILITIES in tools/tool-metadata.ts.
 */
export { PLAN_MODE_ALLOWED_TOOLS };

/**
 * System prompt suffixes injected per mode.
 * Empty string for "default" — no suffix added, current behavior preserved.
 */
export const MODE_SYSTEM_PROMPT_SUFFIXES: Record<Mode, string> = {
  default: "",
  plan: planPrompt,
  execute: executePrompt,
};
