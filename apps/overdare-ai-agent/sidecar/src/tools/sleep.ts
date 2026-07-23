// @summary OVERDARE sleep bundled tool provider — pauses the agent so time-delayed results can appear

import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import type { BundledToolProvider } from "@diligent/runtime";
import { z } from "zod";

const DEFAULT_SECONDS = 5;
const MIN_SECONDS = 1;
const MAX_SECONDS = 60;

/** How often remaining time is reported through `ctx.onUpdate`. */
const TICK_MS = 1000;

const SleepParams = z.object({
  seconds: z
    .number()
    .optional()
    .describe(
      `How long to wait, in seconds (default ${DEFAULT_SECONDS}, min ${MIN_SECONDS}, max ${MAX_SECONDS}). ` +
        "If the user asked for a specific wait time, pass exactly that value.",
    ),
});

const description = [
  "Pause for a fixed amount of time, then continue.",
  "",
  "Use this after starting the game when the thing you need to observe only shows up after time passes —",
  "a delayed script, a load step, a timer, or a runtime error thrown partway through the run.",
  "This does not run or advance the game: the game runs in its own process and keeps running either way.",
  "It only spends time before you read the result (for example ./Play.log).",
  "",
  `- Waits ${DEFAULT_SECONDS} seconds when \`seconds\` is omitted.`,
  "- Pass a longer value when you know the delay you are waiting on (e.g. the script calls task.wait(25),",
  "  so wait somewhat longer than 25 seconds).",
  '- If the user states a wait time ("wait 10 seconds"), pass exactly that number.',
  `- Values are clamped to ${MIN_SECONDS}–${MAX_SECONDS} seconds.`,
  "- Interrupting the turn ends the wait immediately.",
  "",
  "Do not use this to wait for the user to do something (press a button, use a skill) — waiting changes",
  "nothing there. Ask the user instead.",
].join("\n");

/**
 * Time source for the sleep tool. Injected so tests can drive virtual time instead of
 * sleeping for real — wall-clock tests are flaky on CI.
 */
export interface SleepScheduler {
  /** Current time in milliseconds. Only differences are used. */
  now(): number;
  /** Resolves after `ms` milliseconds, or earlier if `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Default scheduler backed by real timers. */
export const realSleepScheduler: SleepScheduler = {
  now: () => Date.now(),
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  },
};

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export function createSleepToolProvider(): BundledToolProvider {
  return {
    id: "@overdare/sleep-tools",
    displayName: "OVERDARE Sleep Tool",
    createTools: () => [createSleepTool()],
  };
}

export function createSleepTool(scheduler: SleepScheduler = realSleepScheduler): Tool<typeof SleepParams> {
  return {
    name: "sleep",
    description,
    parameters: SleepParams,
    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const rawSeconds = args.seconds;
      const requestedSeconds = typeof rawSeconds === "number" && Number.isFinite(rawSeconds) ? rawSeconds : undefined;
      const seconds = Math.min(Math.max(requestedSeconds ?? DEFAULT_SECONDS, MIN_SECONDS), MAX_SECONDS);
      const totalMs = Math.round(seconds * 1000);
      const clamped = requestedSeconds !== undefined && requestedSeconds !== seconds;

      const startedAt = scheduler.now();
      ctx.onUpdate?.(`Waiting ${formatSeconds(totalMs)}…`);

      let remainingMs = totalMs;
      while (remainingMs > 0 && !ctx.signal.aborted) {
        const chunkMs = Math.min(TICK_MS, remainingMs);
        await scheduler.sleep(chunkMs, ctx.signal);
        remainingMs -= chunkMs;
        if (remainingMs > 0 && !ctx.signal.aborted) {
          ctx.onUpdate?.(`Waiting ${formatSeconds(totalMs)}… ${formatSeconds(remainingMs)} remaining`);
        }
      }

      const interrupted = remainingMs > 0;
      const elapsedMs = Math.max(0, Math.min(scheduler.now() - startedAt, totalMs));

      let output: string;
      if (interrupted) {
        output = `Waited ${formatSeconds(elapsedMs)} of ${formatSeconds(totalMs)} — interrupted.`;
      } else if (clamped) {
        output = `Waited ${formatSeconds(totalMs)} (requested ${requestedSeconds}s, clamped to ${MIN_SECONDS}–${MAX_SECONDS}s).`;
      } else {
        output = `Waited ${formatSeconds(totalMs)}.`;
      }

      return {
        output,
        metadata: {
          requested_seconds: requestedSeconds ?? null,
          slept_seconds: elapsedMs / 1000,
          clamped,
          interrupted,
        },
      };
    },
  };
}
