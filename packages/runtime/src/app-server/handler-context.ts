// @summary Shared ThreadRuntime, ThreadHandlersContext, and resetTurnRuntimeState used across all app-server handlers

import type { RuntimeAgent } from "../agent/runtime-agent";
import type { DiligentConfig } from "../config/schema";
import type { DiligentPaths } from "../infrastructure";
import type { DiligentServerNotification, Mode, ThinkingEffort } from "../protocol/index";
import type { SessionManager } from "../session/manager";
import type { BundledToolProvider } from "../tools/bundled-provider";
import type { CollectedPluginHooks } from "../tools/plugin-loader";

export interface ThreadRuntime {
  id: string;
  cwd: string;
  mode: Mode;
  effort: ThinkingEffort;
  modelId: string;
  runningEffortSnapshot?: ThinkingEffort;
  runningModelIdSnapshot?: string;
  /** User ID of the connection that started the current turn (set at turn start, cleared on end). */
  currentTurnUserId?: string;
  manager: SessionManager;
  abortController: AbortController | null;
  currentTurnId: string | null;
  isRunning: boolean;
  /** Cached agent — cleared when mode/effort/model changes to force a rebuild on the next turn. */
  agent?: RuntimeAgent;
}

/**
 * Reset all turn-lifecycle state on a ThreadRuntime after a turn ends (normally, via abort, or via
 * hook block before the agent loop starts). Centralises the field list so both the normal finally
 * path in server.ts and the pre-agent hook-blocked path stay in sync.
 */
export function resetTurnRuntimeState(runtime: ThreadRuntime): void {
  runtime.abortController = null;
  runtime.currentTurnId = null;
  runtime.currentTurnUserId = undefined;
  runtime.runningEffortSnapshot = undefined;
  runtime.runningModelIdSnapshot = undefined;
  runtime.isRunning = false;
}

export interface ThreadHandlersContext {
  activeThreadId: string | null;
  threads: Map<string, ThreadRuntime>;
  knownCwds: Set<string>;
  hooks?: DiligentConfig["hooks"];
  /** Returns the user ID for a given connection, falling back to config userId or OS username. */
  getUserId: (connectionId: string | undefined) => string;
  /** Collect lifecycle hook handlers exported by enabled plugins for the given cwd. */
  getPluginHooks: (cwd: string) => Promise<CollectedPluginHooks>;
  resolvePaths: (cwd: string) => Promise<DiligentPaths>;
  createThreadRuntime: (
    threadId: string,
    cwd: string,
    mode: Mode,
    createNew: boolean,
    effort?: ThinkingEffort,
    modelId?: string,
  ) => Promise<ThreadRuntime>;
  resolveThreadRuntime: (threadId?: string) => Promise<ThreadRuntime>;
  getLatestEffortForCwd: (cwd: string) => Promise<ThinkingEffort>;
  getLatestModelForCwd: (cwd: string) => Promise<string | undefined>;
  emit: (notification: DiligentServerNotification) => Promise<void>;
  consumeTurn: (runtime: ThreadRuntime, runPromise: Promise<void>, turnId: string) => Promise<void>;
  resolveToolsContext: (threadId?: string) => Promise<{ cwd: string; tools: DiligentConfig["tools"] | undefined }>;
  getBundledToolProviders: () => BundledToolProvider[];
  getMcpServers: () => DiligentConfig["mcpServers"];
  getSkillNames: () => string[];
  setActiveThreadId: (threadId: string | null) => void;
}
