// @summary App-server thread lifecycle handlers: start, read, compact, mode/effort

import { resolveModel } from "@diligent/core/llm/models";
import {
  normalizeThinkingEffort,
  supportsThinkingEffort,
  supportsThinkingNone,
} from "@diligent/core/llm/thinking-effort";
import type { RuntimeAgent } from "../agent/runtime-agent";
import type { DiligentConfig } from "../config/schema";
import { calculateUsageCost } from "../cost";
import type { DiligentPaths } from "../infrastructure";
import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  type DiligentServerNotification,
  type Mode,
  type ThinkingEffort,
  type ThreadItem,
} from "../protocol/index";
import type { SessionManager } from "../session/manager";
import { generateSessionId } from "../session/types";
import type { BundledToolProvider } from "../tools/bundled-provider";
import type { CollectedPluginHooks } from "../tools/plugin-loader";
import {
  applyLiveCollabStatusesToSnapshot,
  buildThreadReadItems,
  type ThreadReadTranscriptEntry,
} from "./thread-read-builder";

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
  resolveSkillSettingsCwd: (threadId?: string) => Promise<string>;
  resolveSubagentSettingsCwd: (threadId?: string) => Promise<string>;
  getBundledToolProviders: () => BundledToolProvider[];
  getMcpServers: () => DiligentConfig["mcpServers"];
  getSkillNames: () => string[];
  setActiveThreadId: (threadId: string | null) => void;
}

export async function handleThreadStart(
  ctx: ThreadHandlersContext,
  params: { cwd: string; mode?: Mode; effort?: ThinkingEffort; model?: string },
): Promise<{ threadId: string }> {
  const mode = params.mode ?? "default";
  const tempId = generateSessionId();
  const effort = params.effort ?? (await ctx.getLatestEffortForCwd(params.cwd));
  const modelId = params.model ?? (await ctx.getLatestModelForCwd(params.cwd));
  const runtime = await ctx.createThreadRuntime(tempId, params.cwd, mode, true, effort, modelId);
  runtime.effort = normalizeThinkingEffort(resolveModel(runtime.modelId), runtime.effort);
  const threadId = runtime.manager.sessionId;
  runtime.id = threadId;

  ctx.threads.set(threadId, runtime);
  ctx.setActiveThreadId(threadId);
  ctx.knownCwds.add(params.cwd);

  await ctx.emit({ method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED, params: { threadId } });
  return { threadId };
}

export async function handleThreadRead(
  ctx: ThreadHandlersContext,
  threadId?: string,
): Promise<{
  cwd: string;
  items: ThreadItem[];
  errors: unknown[];
  hasFollowUp: boolean;
  pendingSteers: Array<{ id: string; content: string }>;
  entryCount: number;
  isRunning: boolean;
  currentMode: Mode;
  currentEffort: ThinkingEffort;
  currentModel?: string;
  totalCost?: number;
}> {
  const runtime = await ctx.resolveThreadRuntime(threadId);

  // If runtime memory drifts from persisted JSONL, refresh from disk for read consistency.
  // Do this only when idle to avoid mutating active turn state mid-stream.
  if (!runtime.isRunning) {
    await runtime.manager.reconcileFromDisk();
  }

  const messages = runtime.manager.getContext();
  const transcript = runtime.manager.getTranscript();
  const items = applyLiveCollabStatusesToSnapshot(
    buildThreadReadItems(transcript as ThreadReadTranscriptEntry[]),
    runtime,
  );

  let totalCost = 0;
  for (const msg of messages) {
    const m = msg as {
      role?: string;
      model?: string;
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    };
    if (m.role === "assistant" && m.usage && m.model) {
      totalCost += calculateUsageCost(resolveModel(m.model), m.usage);
    }
  }

  return {
    cwd: runtime.cwd,
    items,
    errors: runtime.manager.getErrors(),
    hasFollowUp: runtime.manager.hasPendingMessages(),
    pendingSteers: runtime.manager.getPendingSteers(),
    entryCount: runtime.manager.entryCount,
    isRunning: runtime.isRunning,
    currentMode: runtime.manager.getCurrentMode() ?? runtime.mode,
    currentEffort: runtime.manager.getCurrentEffort() ?? runtime.effort,
    currentModel: runtime.manager.getCurrentModel()?.modelId ?? runtime.modelId,
    totalCost,
  };
}

export async function handleThreadCompactStart(
  ctx: ThreadHandlersContext,
  threadId?: string,
): Promise<{ compacted: boolean; entryCount: number; tokensBefore: number; tokensAfter: number; summary: string }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  if (runtime.isRunning) throw new Error("Cannot compact while a turn is running");

  runtime.isRunning = true;
  await ctx.emit({
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
    params: { threadId: runtime.id, status: "busy" },
  });

  try {
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTION_STARTED,
      params: { threadId: runtime.id, estimatedTokens: 0 },
    });
    const result = await runtime.manager.compactNow();
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTED,
      params: {
        threadId: runtime.id,
        entryCount: result.entryCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summary: result.summary,
      },
    });
    return result;
  } catch (error) {
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: runtime.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
        },
        fatal: false,
      },
    });
    throw error;
  } finally {
    runtime.isRunning = false;
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
      params: { threadId: runtime.id, status: "idle" },
    });
  }
}

export async function handleModeSet(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  mode: Mode,
): Promise<{ mode: Mode }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  runtime.mode = mode;
  runtime.agent = undefined; // force agent rebuild on next turn
  runtime.manager.appendModeChange(mode, "command");
  return { mode };
}

export async function handleEffortSet(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  effort: ThinkingEffort,
): Promise<{ effort: ThinkingEffort }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  const modelId = runtime.manager.getCurrentModel()?.modelId ?? runtime.modelId;
  const model = modelId ? resolveModel(modelId) : undefined;
  const unsupportedMinimal = effort === "none" && model && !supportsThinkingNone(model);
  const unsupportedXhigh = effort === "xhigh" && model && !supportsThinkingEffort(model, effort);
  if (unsupportedMinimal || unsupportedXhigh) {
    const message =
      effort === "none"
        ? "Minimal thinking is not supported for this model."
        : `Thinking effort "${effort}" is not supported for this model.`;
    throw Object.assign(new Error(message), { code: -32602 });
  }
  runtime.effort = effort;
  runtime.agent?.setEffort(effort);
  runtime.manager.appendEffortChange(effort, "command");
  return { effort };
}
