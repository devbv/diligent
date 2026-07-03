// @summary Diligent collaboration mode definitions: Mode, tool block-lists, prompt suffixes
import type { Mode as ProtocolMode } from "@diligent/protocol";
import { EXECUTE_MODE_DISALLOWED_TOOLS, PLAN_MODE_DISALLOWED_TOOLS } from "../tools/tool-metadata";
import executePrompt from "./default/execute.md" with { type: "text" };
import planPrompt from "./default/plan.md" with { type: "text" };

// D087: Collaboration modes
export type Mode = ProtocolMode;

/**
 * Tools explicitly unavailable in plan/read-only mode. External tools are allowed by default.
 * Bash, write, apply_patch, edit, multi_edit, update_knowledge are excluded.
 * Source of truth: TOOL_CAPABILITIES in tools/tool-metadata.ts.
 */
export { PLAN_MODE_DISALLOWED_TOOLS };

/**
 * Tools explicitly unavailable in execute mode. Execute mode should not pause to ask the user.
 * Source of truth: TOOL_CAPABILITIES in tools/tool-metadata.ts.
 */
export { EXECUTE_MODE_DISALLOWED_TOOLS };

/**
 * System prompt suffixes injected per mode.
 * Empty string for "default" — no suffix added, current behavior preserved.
 */
export const MODE_SYSTEM_PROMPT_SUFFIXES: Record<Mode, string> = {
  default: "",
  plan: planPrompt,
  execute: executePrompt,
};
