// @summary Shared config-reload helper: ConfigReloadResult and handleConfigReload

import type { ThreadRuntime } from "./context";

export interface ConfigReloadResult {
  skills: Array<{ name: string; description: string }>;
}

/**
 * `config/reload` — re-runs skill/agent/tool discovery and reloads mcpServers/tools/hooks
 * from disk config, without restarting the process. Existing per-thread agents are cleared
 * so the next turn on each thread rebuilds with the fresh skills/agents/tools/MCP servers.
 * Web-only parity for the CLI TUI's `/reload`, which achieves the same effect by respawning
 * its app-server process.
 */
export async function handleConfigReload(
  reloadConfig: (() => Promise<ConfigReloadResult>) | undefined,
  threads: Map<string, ThreadRuntime>,
): Promise<ConfigReloadResult> {
  if (!reloadConfig) {
    throw Object.assign(new Error("Config reload is not supported by this app server."), { code: -32601 });
  }
  const result = await reloadConfig();
  for (const runtime of threads.values()) {
    runtime.agent = undefined;
  }
  return result;
}
