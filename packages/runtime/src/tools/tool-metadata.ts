// @summary Central tool metadata registry — single source of truth for built-in tool capabilities

import { COLLAB_TOOL_NAMES, CUSTOM_RENDER_TOOLS } from "@diligent/protocol";

export { COLLAB_TOOL_NAMES, CUSTOM_RENDER_TOOLS };

/**
 * Capabilities for a built-in tool.
 * When adding a new tool, add an entry here and set each applicable flag.
 * The derived sets (IMMUTABLE_TOOLS, PLAN_MODE_ALLOWED_TOOLS) are generated from this registry.
 * COLLAB_TOOL_NAMES and CUSTOM_RENDER_TOOLS are defined in @diligent/protocol/tool-classification
 * and re-exported here for backward compatibility. When adding a tool with collabExcluded or
 * hasCustomRender, update both this registry AND the corresponding set in protocol.
 */
export interface ToolCapabilities {
  /** Cannot be disabled by user config (D027). */
  immutable?: true;
  /** Allowed in plan mode (read-only exploration). Bash and file mutation tools are excluded. */
  planModeAllowed?: true;
  /** Belongs to the collab layer — excluded from child agents to prevent nesting. */
  collabExcluded?: true;
  /** Has custom render logic in render-payload.ts for richer UI display. */
  hasCustomRender?: true;
  /** Execution path for the tool. Defaults to local execution. */
  executionMode?: "local" | "provider_builtin";
  /** Provider-native capability exposed behind a built-in tool name. */
  providerCapability?: "web";
}

/** Central registry of built-in tool capabilities. */
export const TOOL_CAPABILITIES: Record<string, ToolCapabilities> = {
  // Core agent tools
  request_user_input: { immutable: true, planModeAllowed: true, hasCustomRender: true },
  plan: { immutable: true, planModeAllowed: true, hasCustomRender: true },
  skill: { immutable: true, planModeAllowed: true, hasCustomRender: true },

  // Read-only filesystem tools (plan-mode safe)
  read: { planModeAllowed: true, hasCustomRender: true },
  read_image: { planModeAllowed: true },
  glob: { planModeAllowed: true },
  grep: { planModeAllowed: true },
  ls: { planModeAllowed: true },
  search_knowledge: { planModeAllowed: true, hasCustomRender: true },
  web_action: { executionMode: "provider_builtin", providerCapability: "web" },

  // Write tools (excluded from plan mode)
  bash: { hasCustomRender: true },
  write: { hasCustomRender: true },
  apply_patch: { hasCustomRender: true },
  edit: { hasCustomRender: true },
  multi_edit: { hasCustomRender: true },
  update_knowledge: { hasCustomRender: true },

  // Collab tools (excluded from child agents to prevent nesting)
  spawn_agent: { collabExcluded: true },
  wait: { collabExcluded: true },
  send_input: { collabExcluded: true },
  close_agent: { collabExcluded: true },
};

/** Tools that cannot be disabled by user config. */
export const IMMUTABLE_TOOLS = new Set(
  Object.entries(TOOL_CAPABILITIES)
    .filter(([, caps]) => caps.immutable)
    .map(([name]) => name),
);

/** Tools allowed in plan mode (read-only exploration only). */
export const PLAN_MODE_ALLOWED_TOOLS = new Set(
  Object.entries(TOOL_CAPABILITIES)
    .filter(([, caps]) => caps.planModeAllowed)
    .map(([name]) => name),
);
