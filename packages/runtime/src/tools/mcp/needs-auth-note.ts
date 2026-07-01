// @summary Builds a system-prompt note listing MCP servers that require interactive authentication

import type { McpServerStatus } from "./types";

/**
 * Builds a short system-prompt section telling the agent which configured MCP servers are not
 * authenticated (their tools are therefore absent this session). This lets the agent answer "can I
 * use <server>?" honestly — pointing the user at `/mcp login <name>` — instead of guessing or
 * poking at token files. Returns `undefined` when nothing needs auth, so no empty section is added.
 *
 * The `needs_auth` status is discovered authoritatively by the MCP connection attempt (see
 * `McpConnectionManager.sync`), not from any local flag, so this note reflects the same result the
 * tool builder used when deciding which server tools to expose.
 */
export function buildMcpNeedsAuthNote(statuses: McpServerStatus[]): string | undefined {
  const needsAuth = statuses.filter((status) => status.status === "needs_auth").map((status) => status.name);
  if (needsAuth.length === 0) return undefined;

  return [
    "Some configured MCP servers are not authenticated, so their tools are unavailable this session.",
    "If the user asks whether they can use one of these servers, or asks you to use its tools, do not attempt the tools — tell the user to authenticate first with the command shown below.",
    ...needsAuth.map((name) => `- ${name}: not authenticated — run \`/mcp login ${name}\``),
  ].join("\n");
}
