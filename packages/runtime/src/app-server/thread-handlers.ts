// @summary App-server thread/turn/tool request handlers extracted from server.ts

import { resolvePersistedLocalImagePath, toPersistedLocalImagePath } from "@diligent/core/llm/local-image-paths";
import { resolveModel } from "@diligent/core/llm/models";
import { supportsThinkingNone } from "@diligent/core/llm/thinking-effort";
import type { RuntimeAgent } from "../agent/runtime-agent";
import type { DiligentConfig } from "../config/schema";
import { getGlobalConfigPath, writeGlobalToolsConfig } from "../config/writer";
import { calculateUsageCost } from "../cost";
import { runCombinedHooks } from "../hooks/runner";
import type { DiligentPaths } from "../infrastructure";
import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  type DiligentServerNotification,
  type Mode,
  type PluginDescriptor,
  type SessionSummary,
  type SupportedImageMediaType,
  type ThinkingEffort,
  type ThreadItem,
  type ToolConflictPolicy,
  type ToolDescriptor,
  type TurnStartParams,
  type UserMessage,
} from "../protocol/index";
import { buildSessionContext } from "../session/context-builder";
import type { SessionManager } from "../session/manager";
import { deleteSession, listSessions, readSessionFile } from "../session/persistence";
import { generateSessionId } from "../session/types";
import type { BundledToolProvider } from "../tools/bundled-provider";
import { buildDefaultTools } from "../tools/defaults";
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

const BUILTIN_COMMAND_NAMES = new Set([
  "help",
  "model",
  "provider",
  "tools",
  "new",
  "resume",
  "delete",
  "status",
  "compact",
  "clear",
  "exit",
  "version",
  "config",
  "cost",
  "bug",
  "reload",
  "skills",
]);

function parseSlashSkillInvocation(
  message: string,
  skillNames: Set<string>,
): { skillName: string; args: string } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;

  const withoutSlash = trimmed.slice(1);
  if (!withoutSlash) return null;

  const spaceIdx = withoutSlash.indexOf(" ");
  const commandName = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).trim();
  if (!commandName || BUILTIN_COMMAND_NAMES.has(commandName) || !skillNames.has(commandName)) return null;

  const args = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();
  return { skillName: commandName, args };
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
  const threadId = runtime.manager.sessionId;
  runtime.id = threadId;

  ctx.threads.set(threadId, runtime);
  ctx.setActiveThreadId(threadId);
  ctx.knownCwds.add(params.cwd);

  await ctx.emit({ method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED, params: { threadId } });
  return { threadId };
}

export async function handleThreadResume(
  ctx: ThreadHandlersContext,
  params: { threadId?: string; mostRecent?: boolean },
): Promise<{ found: boolean; threadId?: string; context?: unknown[] }> {
  if (params.threadId) {
    const existing = ctx.threads.get(params.threadId);
    if (existing) {
      const context = existing.manager.getContext();

      ctx.setActiveThreadId(params.threadId);
      await ctx.emit({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_RESUMED,
        params: { threadId: params.threadId, restoredMessages: context.length },
      });
      return { found: true, threadId: params.threadId, context };
    }
  }

  for (const cwd of Array.from(ctx.knownCwds)) {
    const placeholderId = params.threadId ?? generateSessionId();
    const runtime = await ctx.createThreadRuntime(
      placeholderId,
      cwd,
      "default",
      false,
      await ctx.getLatestEffortForCwd(cwd),
    );

    const resumed = await runtime.manager.resume({
      sessionId: params.threadId,
      mostRecent: params.mostRecent,
    });
    if (!resumed) continue;

    const threadId = runtime.manager.sessionId;
    runtime.id = threadId;

    const context = runtime.manager.getContext();
    runtime.effort = runtime.manager.getCurrentEffort() ?? runtime.effort;
    runtime.modelId = runtime.manager.getCurrentModel()?.modelId ?? runtime.modelId;
    ctx.threads.set(threadId, runtime);

    ctx.setActiveThreadId(threadId);

    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_RESUMED,
      params: { threadId, restoredMessages: context.length },
    });

    return { found: true, threadId, context };
  }

  return { found: false };
}

export async function handleThreadList(
  ctx: ThreadHandlersContext,
  limit?: number,
  includeChildren?: boolean,
): Promise<{ data: SessionSummary[] }> {
  const result: SessionSummary[] = [];

  for (const cwd of ctx.knownCwds) {
    const paths = await ctx.resolvePaths(cwd);
    const sessions = await listSessions(paths.sessions);
    for (const session of sessions) {
      result.push({
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        name: session.name,
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstUserMessage: session.firstUserMessage,
        parentSession: session.parentSession,
      });
    }
  }

  const filtered = includeChildren ? result : result.filter((s) => !s.parentSession);
  filtered.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return { data: filtered.slice(0, limit ?? 100) };
}

export async function handleThreadRead(
  ctx: ThreadHandlersContext,
  threadId?: string,
): Promise<{
  cwd: string;
  items: ThreadItem[];
  errors: unknown[];
  hasFollowUp: boolean;
  entryCount: number;
  isRunning: boolean;
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
    entryCount: runtime.manager.entryCount,
    isRunning: runtime.isRunning,
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

export async function handleTurnStart(
  ctx: ThreadHandlersContext,
  params: TurnStartParams,
  connectionId: string | undefined,
  turnInitiators: Map<string, string>,
): Promise<{ accepted: true }> {
  const { runtime, turnId } = await initializeTurnRuntime(ctx, params, connectionId, turnInitiators);

  await ctx.emit({
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
    params: { threadId: runtime.id, status: "busy" },
  });
  await ctx.emit({
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED,
    params: { threadId: runtime.id, turnId },
  });

  const { userMessage, content } = prepareTurnMessage(ctx, params, runtime);

  const hookOutcome = await applyUserPromptHooks(ctx, params, runtime, content, userMessage, turnId);
  if (hookOutcome.blocked) return { accepted: true };

  const finalUserMessage = hookOutcome.userMessage;
  const userItemId = `msg-${crypto.randomUUID().slice(0, 8)}`;
  await ctx.emit({
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT,
    params: {
      threadId: runtime.id,
      turnId,
      event: {
        type: "user_message",
        itemId: userItemId,
        message: finalUserMessage,
      },
      threadStatus: "busy",
    },
  });

  const runPromise = runtime.manager.run(finalUserMessage, {
    signal: runtime.abortController!.signal,
  });
  void ctx.consumeTurn(runtime, runPromise, turnId);
  return { accepted: true };
}

/**
 * Validate that no turn is already running, set up the turn's abort controller and metadata,
 * sync the model if it has changed, and return the initialised runtime and a new turn ID.
 */
async function initializeTurnRuntime(
  ctx: ThreadHandlersContext,
  params: TurnStartParams,
  connectionId: string | undefined,
  turnInitiators: Map<string, string>,
): Promise<{ runtime: ThreadRuntime; turnId: string }> {
  const runtime = await ctx.resolveThreadRuntime(params.threadId);
  if (runtime.isRunning) throw new Error("A turn is already running for this thread");

  if (connectionId) turnInitiators.set(runtime.id, connectionId);

  runtime.abortController = new AbortController();
  runtime.isRunning = true;
  runtime.runningEffortSnapshot = runtime.effort;
  runtime.runningModelIdSnapshot = params.model ?? runtime.modelId;
  runtime.currentTurnUserId = ctx.getUserId(connectionId);

  const effectiveModelId = runtime.runningModelIdSnapshot;
  const lastRecordedModelId = runtime.manager.getCurrentModel()?.modelId;
  if (effectiveModelId !== lastRecordedModelId) {
    const model = resolveModel(effectiveModelId);
    runtime.manager.appendModelChange(model.provider, model.id);
    runtime.modelId = effectiveModelId;
  }

  const turnId = `turn-${crypto.randomUUID().slice(0, 8)}`;
  runtime.currentTurnId = turnId;
  return { runtime, turnId };
}

/**
 * Resolve the slash-skill invocation (if any), normalize attachments, and assemble the
 * user message object that will be passed to the session manager.
 */
function prepareTurnMessage(
  ctx: ThreadHandlersContext,
  params: TurnStartParams,
  runtime: ThreadRuntime,
): { userMessage: UserMessage; content: UserMessage["content"] } {
  const timestamp = Date.now();
  const slashSkill = parseSlashSkillInvocation(params.message, new Set(ctx.getSkillNames()));
  const messageForTurn = slashSkill
    ? [
        `The user invoked /${slashSkill.skillName}.`,
        `Before any other action, call the "skill" tool with {"name":"${slashSkill.skillName}"}.`,
        slashSkill.args
          ? `After loading the skill, continue with this additional user instruction:\n${slashSkill.args}`
          : "After loading the skill, continue with the user's request.",
      ].join("\n\n")
    : params.message;

  const normalizedAttachments = params.attachments?.map((attachment) =>
    normalizeLocalImageAttachment(attachment, runtime.cwd),
  );

  const content =
    params.content && params.content.length > 0
      ? params.content
      : normalizedAttachments && normalizedAttachments.length > 0
        ? [
            ...((messageForTurn.trim().length > 0 ? [{ type: "text", text: messageForTurn }] : []) as Array<{
              type: "text";
              text: string;
            }>),
            ...normalizedAttachments,
          ]
        : messageForTurn;

  return {
    userMessage: { role: "user" as const, content: content as UserMessage["content"], timestamp },
    content: content as UserMessage["content"],
  };
}

type HookOutcome = { blocked: true } | { blocked: false; userMessage: UserMessage };

/**
 * Collect and run UserPromptSubmit hooks (shell + plugin). If a hook blocks the prompt,
 * emit error/turn-end notifications and return blocked. If a hook supplies additional
 * context, prepend it to the user message and return the augmented message.
 */
async function applyUserPromptHooks(
  ctx: ThreadHandlersContext,
  params: TurnStartParams,
  runtime: ThreadRuntime,
  content: UserMessage["content"],
  userMessage: UserMessage,
  turnId: string,
): Promise<HookOutcome> {
  const shellHandlers = ctx.hooks?.UserPromptSubmit ?? [];
  const { onUserPromptSubmit: pluginHandlers } = await ctx.getPluginHooks(runtime.cwd);

  if (shellHandlers.length === 0 && pluginHandlers.length === 0) {
    return { blocked: false, userMessage };
  }

  const hookInput = {
    session_id: runtime.manager.sessionId,
    transcript_path: runtime.manager.sessionPath ?? "",
    cwd: runtime.cwd,
    hook_event_name: "UserPromptSubmit",
    permission_mode: runtime.mode,
    user_id: runtime.currentTurnUserId,
    prompt: typeof content === "string" ? content : params.message,
  };

  const hookResult = await runCombinedHooks(shellHandlers, pluginHandlers, hookInput, runtime.cwd);

  if (hookResult.blocked) {
    resetTurnRuntimeState(runtime);
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: runtime.id,
        error: { message: hookResult.reason ?? "Prompt blocked by hook", name: "HookBlocked" },
        fatal: false,
      },
    });
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
      params: { threadId: runtime.id, turnId },
    });
    await ctx.emit({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
      params: { threadId: runtime.id, status: "idle" },
    });
    return { blocked: true };
  }

  if (hookResult.additionalContext) {
    const originalText = typeof content === "string" ? content : params.message;
    const augmentedContent = `${hookResult.additionalContext}\n\n${originalText}`;
    return { blocked: false, userMessage: { ...userMessage, content: augmentedContent as UserMessage["content"] } };
  }

  return { blocked: false, userMessage };
}

export async function handleTurnInterrupt(
  ctx: ThreadHandlersContext,
  threadId?: string,
): Promise<{ interrupted: boolean }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  if (!runtime.isRunning || !runtime.abortController) return { interrupted: false };
  runtime.abortController.abort();
  return { interrupted: true };
}

export async function handleTurnSteer(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  content: string,
  attachments?: Array<{ type: "local_image"; path: string; mediaType: SupportedImageMediaType; fileName?: string }>,
): Promise<{ queued: true }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  const normalizedAttachments = attachments?.map((attachment) =>
    normalizeLocalImageAttachment(attachment, runtime.cwd),
  );
  const message =
    normalizedAttachments && normalizedAttachments.length > 0
      ? {
          role: "user" as const,
          content: [
            ...(content.trim().length > 0 ? ([{ type: "text", text: content }] as const) : []),
            ...normalizedAttachments,
          ],
          timestamp: Date.now(),
        }
      : {
          role: "user" as const,
          content,
          timestamp: Date.now(),
        };
  runtime.manager.steer(message);
  return { queued: true };
}

function normalizeLocalImageAttachment(
  attachment: { type: "local_image"; path: string; mediaType: SupportedImageMediaType; fileName?: string },
  cwd: string,
): { type: "local_image"; path: string; mediaType: SupportedImageMediaType; fileName?: string } {
  const absolutePath = resolvePersistedLocalImagePath(attachment.path, cwd);
  return {
    ...attachment,
    path: toPersistedLocalImagePath(absolutePath, cwd),
  };
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
  if (effort === "none" && model && !supportsThinkingNone(model)) {
    throw Object.assign(new Error("Minimal thinking is not supported for this model."), { code: -32602 });
  }
  runtime.effort = effort;
  runtime.agent?.setEffort(effort);
  runtime.manager.appendEffortChange(effort, "command");
  return { effort };
}

export async function handleThreadDelete(ctx: ThreadHandlersContext, threadId: string): Promise<{ deleted: boolean }> {
  const existing = ctx.threads.get(threadId);
  if (existing?.isRunning) throw new Error("Cannot delete a thread that is currently running");

  const knownInMemory = ctx.threads.has(threadId);
  let deletedFromDisk = false;

  for (const cwd of ctx.knownCwds) {
    const paths = await ctx.resolvePaths(cwd);
    const result = await deleteSession(paths.sessions, threadId);
    if (!result) continue;
    deletedFromDisk = true;
    break;
  }

  const deleted = deletedFromDisk || knownInMemory;
  if (deleted) {
    existing?.manager.dispose();
    ctx.threads.delete(threadId);
    if (ctx.activeThreadId === threadId) {
      ctx.setActiveThreadId(null);
    }
  }

  return { deleted };
}

export async function handleToolsList(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
): Promise<{
  configPath: string;
  appliesOnNextTurn: true;
  trustMode: "full_trust";
  conflictPolicy: ToolConflictPolicy;
  tools: ToolDescriptor[];
  plugins: PluginDescriptor[];
}> {
  const { cwd, tools } = await ctx.resolveToolsContext(threadId);
  const paths = await ctx.resolvePaths(cwd);
  const result = await buildDefaultTools({
    cwd,
    paths,
    toolsConfig: tools,
    bundledToolProviders: ctx.getBundledToolProviders(),
  });

  return {
    configPath: getGlobalConfigPath(),
    appliesOnNextTurn: true,
    trustMode: "full_trust",
    conflictPolicy: (tools?.conflictPolicy ?? "error") as ToolConflictPolicy,
    tools: result.toolState,
    plugins: result.pluginState.map((plugin) => ({ ...plugin, loadError: plugin.loadError })),
  };
}

export async function handleToolsSet(
  ctx: ThreadHandlersContext,
  toolConfig: {
    getTools: () => DiligentConfig["tools"] | undefined;
    setTools: (tools: DiligentConfig["tools"] | undefined) => void;
  },
  threadId: string | undefined,
  params: {
    web_action?: boolean;
    builtin?: Record<string, boolean>;
    plugins?: Array<{ package: string; enabled?: boolean; tools?: Record<string, boolean>; remove?: boolean }>;
    conflictPolicy?: ToolConflictPolicy;
  },
): Promise<{
  configPath: string;
  appliesOnNextTurn: true;
  trustMode: "full_trust";
  conflictPolicy: ToolConflictPolicy;
  tools: ToolDescriptor[];
  plugins: PluginDescriptor[];
}> {
  const { cwd } = await ctx.resolveToolsContext(threadId);
  const writeResult = await writeGlobalToolsConfig({
    web_action: params.web_action,
    builtin: params.builtin,
    plugins: params.plugins,
    conflictPolicy: params.conflictPolicy,
  });

  toolConfig.setTools(writeResult.config.tools);

  const paths = await ctx.resolvePaths(cwd);
  const result = await buildDefaultTools({
    cwd,
    paths,
    toolsConfig: writeResult.config.tools,
    bundledToolProviders: ctx.getBundledToolProviders(),
  });

  return {
    configPath: writeResult.configPath,
    appliesOnNextTurn: true,
    trustMode: "full_trust",
    conflictPolicy: (writeResult.config.tools?.conflictPolicy ?? "error") as ToolConflictPolicy,
    tools: result.toolState,
    plugins: result.pluginState.map((plugin) => ({ ...plugin, loadError: plugin.loadError })),
  };
}

export async function getLatestEffortFromSessions(
  resolvePaths: (cwd: string) => Promise<{ sessions: string }>,
  threads: Map<string, ThreadRuntime>,
  cwd: string,
  fallback: ThinkingEffort = "medium",
): Promise<ThinkingEffort> {
  const paths = await resolvePaths(cwd);
  const ordered = (await listSessions(paths.sessions))
    .filter((session) => session.cwd === cwd)
    .map<SessionSummary>((session) => ({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      created: session.created.toISOString(),
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
      firstUserMessage: session.firstUserMessage,
      parentSession: session.parentSession,
    }));

  for (const summary of ordered) {
    const runtime = threads.get(summary.id);
    const runtimeEffort = runtime?.manager.getCurrentEffort() ?? runtime?.effort;
    if (runtimeEffort) return runtimeEffort;
    if (!summary.path) continue;

    try {
      const { entries } = await readSessionFile(summary.path);
      const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
      const effort = buildSessionContext(entries, leafId).currentEffort;
      if (effort) return effort;
    } catch {
      // Ignore unreadable session files and continue.
    }
  }

  return fallback;
}

export async function getLatestModelFromSessions(
  resolvePaths: (cwd: string) => Promise<{ sessions: string }>,
  threads: Map<string, ThreadRuntime>,
  cwd: string,
  fallback?: string,
): Promise<string | undefined> {
  const paths = await resolvePaths(cwd);
  const ordered = (await listSessions(paths.sessions))
    .filter((session) => session.cwd === cwd)
    .map<SessionSummary>((session) => ({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      created: session.created.toISOString(),
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
      firstUserMessage: session.firstUserMessage,
      parentSession: session.parentSession,
    }));

  for (const summary of ordered) {
    const runtime = threads.get(summary.id);
    const runtimeModelId = runtime?.manager.getCurrentModel()?.modelId ?? runtime?.modelId;
    if (runtimeModelId) return runtimeModelId;
    if (!summary.path) continue;

    try {
      const { entries } = await readSessionFile(summary.path);
      const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
      const modelId = buildSessionContext(entries, leafId).currentModel?.modelId;
      if (modelId) return modelId;
    } catch {
      // Ignore unreadable session files and continue.
    }
  }

  return fallback;
}
