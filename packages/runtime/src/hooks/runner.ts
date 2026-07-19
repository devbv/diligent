// @summary Executes result-aware UserPromptSubmit hooks and result-ignoring Stop lifecycle hooks

import type { DiligentConfig } from "../config/schema";

export type { SessionUsage } from "./input-builder";
export { getLastAssistantMessage, getSessionUsage, getTurnUsage } from "./input-builder";

type HookHandler = NonNullable<NonNullable<DiligentConfig["hooks"]>["UserPromptSubmit"]>[number];

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export interface HookResult {
  blocked: boolean;
  /** Reason shown when a UserPromptSubmit hook blocks the prompt; ignored for Stop. */
  reason?: string;
  /** Context prepended for UserPromptSubmit; ignored for Stop. */
  additionalContext?: string;
}

export type HookMode = "sync" | "async";

const DEFAULT_SYNC_TIMEOUT_SECONDS = 10;

function getSyncTimeoutMs(handler: HookHandler): number {
  return (handler.timeout ?? DEFAULT_SYNC_TIMEOUT_SECONDS) * 1_000;
}

function spawnHookCommand(handler: HookHandler, inputJson: string, cwd: string) {
  return Bun.spawn(["bash", "-c", handler.command], {
    cwd,
    stdin: Buffer.from(inputJson),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
}

function runAsyncHook(handler: HookHandler, inputJson: string, cwd: string): void {
  const proc = spawnHookCommand(handler, inputJson, cwd);
  void Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).catch(() => {
    try {
      proc.kill();
    } catch {
      // ignore async hook cleanup errors
    }
  });
}

async function runSingleHook(handler: HookHandler, input: HookInput, cwd: string): Promise<HookResult> {
  const inputJson = JSON.stringify(input);
  if (handler.mode === "async") {
    runAsyncHook(handler, inputJson, cwd);
    return { blocked: false };
  }

  const timeoutMs = getSyncTimeoutMs(handler);
  const proc = spawnHookCommand(handler, inputJson, cwd);

  const timeoutHandle = setTimeout(() => proc.kill(), timeoutMs);

  let exitCode: number;
  let stdoutText: string;
  let stderrText: string;

  try {
    [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Exit 2: structured blocking result. Only UserPromptSubmit dispatch interprets it.
  if (exitCode === 2) {
    return {
      blocked: true,
      reason: stderrText.trim() || "Hook blocked the operation",
    };
  }

  // Non-zero (other than 2): isolated error — ignore and continue.
  if (exitCode !== 0) {
    return { blocked: false };
  }

  // Exit 0: parse JSON stdout for structured decisions
  const trimmed = stdoutText.trim();
  if (!trimmed) return { blocked: false };

  // Plain text becomes UserPromptSubmit context; Stop lifecycle dispatch ignores it.
  if (!trimmed.startsWith("{")) {
    return { blocked: false, additionalContext: trimmed };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { blocked: false };
  }

  const blocked = parsed.decision === "block";
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;

  // UserPromptSubmit context may be top-level or nested in hookSpecificOutput.
  const hookSpecific = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
  const additionalContext =
    typeof parsed.additionalContext === "string"
      ? parsed.additionalContext
      : typeof hookSpecific?.additionalContext === "string"
        ? hookSpecific.additionalContext
        : undefined;

  return { blocked, reason, additionalContext };
}

/** Plugin-provided hook handler function. */
export type PluginHookFn = ((input: HookInput) => Promise<Partial<HookResult>>) & { mode?: HookMode };

function runAsyncPluginHook(handler: PluginHookFn, input: HookInput): void {
  void handler(input).catch(() => {});
}

/** Run result-aware plugin hooks for UserPromptSubmit. Errors are non-blocking. */
export async function runPluginHooks(handlers: PluginHookFn[], input: HookInput): Promise<HookResult> {
  let combinedContext: string | undefined;
  for (const handler of handlers) {
    if (handler.mode === "async") {
      runAsyncPluginHook(handler, input);
      continue;
    }

    let result: Partial<HookResult>;
    try {
      result = await handler(input);
    } catch {
      continue;
    }
    if (result.blocked) return { blocked: true, reason: result.reason };
    if (result.additionalContext) {
      combinedContext = combinedContext ? `${combinedContext}\n${result.additionalContext}` : result.additionalContext;
    }
  }
  return { blocked: false, additionalContext: combinedContext };
}

/**
 * Runs result-aware UserPromptSubmit shell hooks followed by plugin hooks.
 * Stops on the first block and merges context from both stages when allowed.
 */
export async function runCombinedHooks(
  shellHandlers: HookHandler[],
  pluginHandlers: PluginHookFn[],
  input: HookInput,
  cwd: string,
): Promise<HookResult> {
  let result: HookResult = { blocked: false };

  if (shellHandlers.length > 0) {
    result = await runHooks(shellHandlers, input, cwd);
  }

  if (!result.blocked && pluginHandlers.length > 0) {
    const pluginResult = await runPluginHooks(pluginHandlers, input);
    if (pluginResult.blocked) {
      result = pluginResult;
    } else {
      const parts = [result.additionalContext, pluginResult.additionalContext].filter(Boolean);
      result = { blocked: false, additionalContext: parts.join("\n") || undefined };
    }
  }

  return result;
}

/**
 * Runs external lifecycle hooks without interpreting their output as model feedback.
 * Sync hooks are awaited, async hooks are detached, and individual failures never
 * prevent later lifecycle handlers from running.
 */
export async function runLifecycleHooks(
  shellHandlers: HookHandler[],
  pluginHandlers: PluginHookFn[],
  input: HookInput,
  cwd: string,
): Promise<void> {
  for (const handler of shellHandlers) {
    try {
      await runSingleHook(handler, input, cwd);
    } catch {
      // Lifecycle hook failures are isolated from the turn and later hooks.
    }
  }

  for (const handler of pluginHandlers) {
    if (handler.mode === "async") {
      runAsyncPluginHook(handler, input);
      continue;
    }
    try {
      await handler(input);
    } catch {
      // Lifecycle hook failures are isolated from the turn and later hooks.
    }
  }
}

/** Run result-aware UserPromptSubmit shell hooks; stop and return on the first block. */
export async function runHooks(handlers: HookHandler[], input: HookInput, cwd: string): Promise<HookResult> {
  let combinedContext: string | undefined;

  for (const handler of handlers) {
    const result = await runSingleHook(handler, input, cwd);
    if (result.blocked) return result;
    if (result.additionalContext) {
      combinedContext = combinedContext ? `${combinedContext}\n${result.additionalContext}` : result.additionalContext;
    }
  }

  return { blocked: false, additionalContext: combinedContext };
}
