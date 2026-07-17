// @summary Factory for config reload and collaboration mode switching

import type { Mode as ProtocolMode, ThinkingEffort } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import { type DiligentPaths, formatModelRef, type ModelRef, type SkillMetadata } from "@diligent/runtime";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { registerBuiltinCommands } from "./commands/builtin/index";
import { CommandRegistry } from "./commands/registry";
import type { AppServerRpcClient } from "./rpc-client";

export interface ConfigManagerDeps {
  getRpcClient: () => AppServerRpcClient | null;
  getCurrentThreadId: () => string | null;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => void;
  getPaths: () => DiligentPaths | undefined;
  setCurrentMode: (mode: ProtocolMode) => void;
  setCurrentEffort: (effort: ThinkingEffort) => void;
  restartRpcClient: () => Promise<void>;
  setSkills: (skills: SkillMetadata[]) => void;
  setCommandRegistry: (registry: CommandRegistry) => void;
  updateStatusBar: (updates: Record<string, unknown>) => void;
  displayError: (msg: string) => void;
  requestRender: () => void;
}

export interface ConfigManager {
  setMode: (mode: ProtocolMode) => void;
  setEffort: (effort: ThinkingEffort) => Promise<void>;
  setModel: (model: ModelRef) => Promise<void>;
  reloadConfig: () => Promise<void>;
}

export function createConfigManager(deps: ConfigManagerDeps): ConfigManager {
  return {
    setMode(mode: ProtocolMode): void {
      deps.setCurrentMode(mode);
      deps.updateStatusBar({ mode });
      const rpc = deps.getRpcClient();
      const threadId = deps.getCurrentThreadId();
      if (rpc && threadId) {
        void rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MODE_SET, { threadId, mode }).catch(() => {});
      }
      deps.requestRender();
    },

    async setEffort(effort: ThinkingEffort): Promise<void> {
      const rpc = deps.getRpcClient();
      const threadId = deps.getCurrentThreadId();
      if (!rpc || !threadId) return;
      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET, { threadId, effort });
      deps.setCurrentEffort(effort);
      deps.updateStatusBar({ effort });
      deps.requestRender();
    },

    async setModel(model: ModelRef): Promise<void> {
      const rpc = deps.getRpcClient();
      if (!rpc) return;
      const threadId = deps.getCurrentThreadId() ?? undefined;
      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET, { threadId, model });
      deps.updateStatusBar({ model: formatModelRef(model) });
      deps.requestRender();
    },

    async reloadConfig(): Promise<void> {
      try {
        const newConfig = await loadConfig(process.cwd(), deps.getPaths());
        deps.setConfig(newConfig);
        await deps.restartRpcClient();
        deps.setSkills(newConfig.skills ?? []);

        // Rebuild command registry with new skills
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry, newConfig.skills ?? []);
        deps.setCommandRegistry(registry);

        deps.updateStatusBar({ model: formatModelRef(newConfig.model), contextWindow: newConfig.model.contextWindow });
      } catch (err) {
        deps.displayError(`Reload error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
