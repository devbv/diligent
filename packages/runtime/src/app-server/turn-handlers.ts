// @summary Turn lifecycle request handlers: turn start, interrupt, and steer

import { resolveModel } from "@diligent/core/model-registry";
import { runCombinedHooks } from "../hooks/runner";
import { resolvePersistedLocalImagePath, toPersistedLocalImagePath } from "../infrastructure/local-image-loader";
import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  type SupportedImageMediaType,
  type TurnStartParams,
  type UserMessage,
} from "../protocol/index";
import { resetTurnRuntimeState, type ThreadHandlersContext, type ThreadRuntime } from "./thread-handlers";

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
    runtime.agent = undefined; // force rebuild so per-turn model overrides update the provider stream
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
  steerId?: string,
): Promise<{ queued: true; steerId: string }> {
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
  const queuedSteerId = runtime.manager.steer(message, steerId);
  return { queued: true, steerId: queuedSteerId };
}

export async function handleTurnSteerCancel(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  steerId: string,
): Promise<{ cancelled: boolean }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  const cancelled = runtime.manager.cancelPendingMessage(steerId);
  return { cancelled };
}

export async function handleTurnSteerUpdate(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  steerId: string,
  content: string,
): Promise<{ updated: boolean }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  const updated = runtime.manager.updatePendingMessage(steerId, content);
  return { updated };
}
