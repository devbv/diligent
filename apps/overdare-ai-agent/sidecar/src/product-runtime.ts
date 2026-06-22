// @summary OVERDARE sidecar runtime options for bundled agents and product prompt guidance.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SystemSection } from "@diligent/runtime";

export interface OverdareRuntimeConfigOptions {
  agentPaths?: string[];
  knownToolNames: string[];
  systemPromptSections: SystemSection[];
}

export const OVERDARE_BUNDLED_TOOL_NAMES = [
  "hello_world",
  "overdaresearch",
  "overdaresearch_deep",
  "validatelua",
  "studiorpc_level_browse",
  "studiorpc_instance_read",
  "studiorpc_instance_upsert",
  "studiorpc_instance_delete",
  "studiorpc_instance_move",
  "studiorpc_script_read",
  "studiorpc_script_grep",
  "studiorpc_script_add",
  "studiorpc_script_edit",
  "studiorpc_script_delete",
  "studiorpc_level_save_file",
  "studiorpc_level_publish",
  "studiorpc_game_play",
  "studiorpc_game_stop",
  "studiorpc_game_screenshot",
  "studiorpc_asset_manager_image_import",
  "studiorpc_asset_drawer_import",
  "studiorpc_action_sequencer_service_apply_json",
  "studiorpc_hub_token_read",
  "hub_world_lookup",
  "hub_world_categories_list",
  "overdare_playtest_start",
  "overdare_playtest_status",
  "overdare_playtest_stop",
  "overdare_playtest_artifacts",
  "overdare_playtest_replay",
] as const;

export function resolveOverdareBootstrapAgentsPath(
  moduleDir: string = import.meta.dir,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = [
    env.OVERDARE_BOOTSTRAP_AGENTS_PATH,
    env.DILIGENT_BOOTSTRAP_AGENTS_PATH,
    resolve(moduleDir, "../../bootstrap/agents"),
    resolve(moduleDir, "../bootstrap/agents"),
    resolve(moduleDir, "bootstrap/agents"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  return candidates.find((candidate) => existsSync(candidate));
}

export function createOverdareRuntimeConfigOptions(
  moduleDir: string = import.meta.dir,
  env: NodeJS.ProcessEnv = process.env,
): OverdareRuntimeConfigOptions {
  const bootstrapAgentsPath = resolveOverdareBootstrapAgentsPath(moduleDir, env);
  if (!bootstrapAgentsPath) {
    console.warn("[Studio Server] OVERDARE bootstrap agents path was not found; product agents are unavailable.");
  }

  return {
    ...(bootstrapAgentsPath ? { agentPaths: [bootstrapAgentsPath] } : {}),
    knownToolNames: [...OVERDARE_BUNDLED_TOOL_NAMES],
    systemPromptSections: [
      {
        label: "overdare_autoplay_qa_routing",
        content: [
          "When the user asks to autoplay QA, smoke-test, playtest, verify gameplay automatically, or use Window MCP for OVERDARE Studio, treat it as an OVERDARE autoplay QA request.",
          'For those requests, first use spawn_agent with agent_type="autoplay-qa" and pass the user\'s concrete objective, adapter preference, duration, artifact requirements, and current cwd in the worker brief.',
          'The autoplay-qa agent must drive the bounded harness through overdare_playtest_start/status/artifacts. Prefer adapter="window-mcp" when the user mentions Window MCP or when OVERDARE_WINDOW_MCP_URL/DILIGENT_WINDOW_MCP_URL is configured.',
          "Do not add, edit, delete, or save Studio scripts/level data for autoplay setup unless the user explicitly asks to modify the UGC itself. Autoplay evidence should come from the harness, Window MCP screenshots, recordings, logs, and artifacts.",
        ].join("\n"),
      },
    ],
  };
}
