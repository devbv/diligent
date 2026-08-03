// @summary Orchestrates one constrained hybrid playtest with Lua observation and Windows input.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@diligent/runtime";
import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  createWindowsDesktopAdapter,
  DEFAULT_PLAYTEST_ACTIONS,
  type DesktopWindow,
  MAX_PLAYTEST_ACTION_DURATION_MS,
  MAX_PLAYTEST_TIMELINE_STEPS,
  MAX_PLAYTEST_TOTAL_DURATION_MS,
  PLAYTEST_KEYS,
  type PlaytestKey,
  type StudioDesktopAdapter,
} from "./playtest-desktop";
import { addScriptToDocument, deleteScriptFromDocument } from "./script-document-operations";

const MARKER_PREFIX = "@@DILIGENT_PLAYTEST@@";
const READY_TIMEOUT_MS = 10_000;
const INPUT_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const DEFAULT_WINDOW_MATCH = "overdare";

const PlaytestKeyParam = z.enum(PLAYTEST_KEYS);
const PlaytestActionParam = z
  .object({
    keys: z
      .array(PlaytestKeyParam)
      .max(3)
      .refine((keys) => new Set(keys).size === keys.length, "Keys in one action must be unique.")
      .describe("Keys held together for this timeline step. Use an empty array to wait."),
    durationMs: z
      .number()
      .int()
      .min(50)
      .max(MAX_PLAYTEST_ACTION_DURATION_MS)
      .describe(`Step duration in milliseconds, from 50 to ${MAX_PLAYTEST_ACTION_DURATION_MS}.`),
  })
  .strict();

const PlaytestActionListParam = z.array(PlaytestActionParam).min(1).max(MAX_PLAYTEST_TIMELINE_STEPS);
const SuccessMarkerParam = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .describe("Exact Play.log marker that the game must emit to pass.");

type PlaytestAction = z.infer<typeof PlaytestActionParam>;
type PlaytestArgs = { actions?: PlaytestAction[]; successMarker?: string };

function validateTimeline(value: PlaytestArgs, ctx: z.RefinementCtx): void {
  if (!value.actions) return;
  const totalDurationMs = value.actions.reduce((total, action) => total + action.durationMs, 0);
  if (totalDurationMs > MAX_PLAYTEST_TOTAL_DURATION_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actions"],
      message: `The action timeline may not exceed ${MAX_PLAYTEST_TOTAL_DURATION_MS} ms.`,
    });
  }
  if (!value.actions.some((action) => action.keys.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actions"],
      message: "The action timeline must include at least one key.",
    });
  }
}

const PlaytestSmokeParams = z
  .object({
    actions: PlaytestActionListParam.optional().describe(
      "Optional bounded input timeline. Omit for the default W 500 ms, SPACE press, and 500 ms wait smoke sequence.",
    ),
  })
  .strict()
  .superRefine(validateTimeline);

const PlaytestGoalParams = z
  .object({
    actions: PlaytestActionListParam.describe("Bounded input timeline for one representative game-completion path."),
    successMarker: SuccessMarkerParam,
  })
  .strict()
  .superRefine(validateTimeline);

export type PlaytestFailureCode =
  | "UNSUPPORTED_PLATFORM"
  | "STARTER_PLAYER_SCRIPTS_NOT_FOUND"
  | "STUDIO_WINDOW_NOT_FOUND"
  | "AMBIGUOUS_STUDIO_WINDOWS"
  | "OBSERVER_NOT_READY"
  | "CAPTURE_FAILED"
  | "INPUT_NOT_OBSERVED"
  | "GOAL_NOT_OBSERVED"
  | "CLEANUP_FAILED"
  | "INTERRUPTED";

export interface PlaytestClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const realClock: PlaytestClock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  },
};

interface BrowseNode {
  guid?: unknown;
  name?: unknown;
  class?: unknown;
  children?: unknown;
}

interface PositionObservation {
  label: string;
  x: number;
  y: number;
  z: number;
}

interface PlaytestTraceEvent {
  timestamp: string;
  elapsedMs: number;
  event: string;
  details?: Record<string, unknown>;
}

interface PlaytestReport {
  version: 2;
  runId: string;
  status: "PASS" | "FAIL";
  failureCode?: PlaytestFailureCode;
  message: string;
  window?: DesktopWindow;
  windowCandidates?: DesktopWindow[];
  actions: PlaytestAction[];
  requiredInputs: string[];
  observedInputs: string[];
  positions: PositionObservation[];
  successMarker?: string;
  successMarkerObserved?: boolean;
  cleanupSucceeded: boolean;
  cleanupErrors: string[];
  primaryFailure?: { code: PlaytestFailureCode; message: string };
  startedAt: string;
  finishedAt: string;
  artifacts: {
    beforeImage: string;
    afterImage: string;
    trace: string;
    report: string;
  };
}

class PlaytestFailure extends Error {
  constructor(
    readonly code: PlaytestFailureCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface PlaytestSmokeToolOptions {
  cwd: string;
  writeLock: WriteLock;
  callRpc: typeof call;
  desktop?: StudioDesktopAdapter;
  clock?: PlaytestClock;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  createRunId?: () => string;
}

function createRunId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function collectStarterPlayerScripts(result: unknown): Array<{ guid: string; name: string; class: string }> {
  const roots = Array.isArray(result)
    ? result
    : typeof result === "object" &&
        result !== null &&
        "level" in result &&
        Array.isArray((result as { level: unknown }).level)
      ? (result as { level: unknown[] }).level
      : [];
  const matches: Array<{ guid: string; name: string; class: string }> = [];

  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as BrowseNode;
    if (node.class === "StarterPlayerScripts" && typeof node.guid === "string" && typeof node.name === "string") {
      matches.push({ guid: node.guid, name: node.name, class: node.class });
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return matches;
}

function defaultPublicActions(): PlaytestAction[] {
  return DEFAULT_PLAYTEST_ACTIONS.flatMap((action) =>
    action.type === "set_keys" ? [{ keys: [...action.keys], durationMs: action.durationMs }] : [],
  );
}

function normalizeActions(actions: PlaytestAction[] | undefined): PlaytestAction[] {
  return (actions ?? defaultPublicActions()).map((action) => ({
    keys: PLAYTEST_KEYS.filter((key) => action.keys.includes(key)),
    durationMs: action.durationMs,
  }));
}

function toDesktopActions(actions: PlaytestAction[]) {
  return [
    { type: "click_center" as const },
    ...actions.map((action) => ({
      type: "set_keys" as const,
      keys: [...action.keys],
      durationMs: action.durationMs,
    })),
  ];
}

function requiredInputsFor(actions: PlaytestAction[]): string[] {
  const result: string[] = [];
  let held = new Set<PlaytestKey>();
  for (const action of [...actions, { keys: [], durationMs: 0 }]) {
    const target = new Set<PlaytestKey>(action.keys);
    for (const key of PLAYTEST_KEYS) {
      if (held.has(key) && !target.has(key)) result.push(`${key}:end`);
    }
    for (const key of PLAYTEST_KEYS) {
      if (!held.has(key) && target.has(key)) result.push(`${key}:begin`);
    }
    held = target;
  }
  return result;
}

function countOrderedMatches(observed: string[], required: string[]): number {
  let matched = 0;
  for (const marker of observed) {
    if (marker === required[matched]) matched++;
    if (matched === required.length) break;
  }
  return matched;
}

function buildObserverSource(runId: string): string {
  const prefix = `${MARKER_PREFIX}|${runId}|`;
  return [
    `local markerPrefix = ${JSON.stringify(prefix)}`,
    "",
    "local function emit(value)",
    "\tprint(markerPrefix .. value)",
    "end",
    "",
    "local function emitPosition(label)",
    "\tpcall(function()",
    '\t\tlocal players = game:GetService("Players")',
    "\t\tlocal player = players.LocalPlayer",
    "\t\tlocal character = player and player.Character",
    '\t\tlocal root = character and character:FindFirstChild("HumanoidRootPart")',
    "\t\tif root then",
    "\t\t\tlocal position = root.Position",
    '\t\t\temit(string.format("position|%s|%.3f|%.3f|%.3f", label, position.X, position.Y, position.Z))',
    "\t\tend",
    "\tend)",
    "end",
    "",
    'local inputService = game:GetService("UserInputService")',
    "local function observedKey(input)",
    '\tif input.KeyCode == Enum.KeyCode.W then return "W" end',
    '\tif input.KeyCode == Enum.KeyCode.A then return "A" end',
    '\tif input.KeyCode == Enum.KeyCode.S then return "S" end',
    '\tif input.KeyCode == Enum.KeyCode.D then return "D" end',
    '\tif input.KeyCode == Enum.KeyCode.Space then return "SPACE" end',
    "\treturn nil",
    "end",
    "",
    "inputService.InputBegan:Connect(function(input)",
    "\tlocal key = observedKey(input)",
    '\tif key then emit("input|" .. key .. "|begin") end',
    "end)",
    "",
    "inputService.InputEnded:Connect(function(input)",
    "\tlocal key = observedKey(input)",
    "\tif key then",
    '\t\temit("input|" .. key .. "|end")',
    '\t\temitPosition("after-" .. key)',
    "\tend",
    "end)",
    "",
    'emit("ready")',
    'emitPosition("ready")',
    "",
  ].join("\n");
}

function readPlayLog(cwd: string): string {
  try {
    return readFileSync(join(cwd, "Play.log"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function markerFor(runId: string, suffix: string): string {
  return `${MARKER_PREFIX}|${runId}|${suffix}`;
}

async function waitForLog(
  cwd: string,
  predicate: (log: string) => boolean,
  timeoutMs: number,
  clock: PlaytestClock,
  signal: AbortSignal,
): Promise<string | undefined> {
  const startedAt = clock.now();
  while (clock.now() - startedAt <= timeoutMs) {
    if (signal.aborted) {
      throw new PlaytestFailure("INTERRUPTED", "The playtest was interrupted.");
    }
    const log = readPlayLog(cwd);
    if (predicate(log)) return log;
    if (clock.now() - startedAt === timeoutMs) break;
    await clock.sleep(Math.min(POLL_INTERVAL_MS, timeoutMs - (clock.now() - startedAt)), signal);
  }
  return undefined;
}

function parseObservations(
  log: string,
  runId: string,
): {
  observedInputs: string[];
  positions: PositionObservation[];
} {
  const marker = `${MARKER_PREFIX}|${runId}|`;
  const observedInputs: string[] = [];
  const positions: PositionObservation[] = [];
  for (const line of log.split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const parts = line
      .slice(index + marker.length)
      .trim()
      .split("|");
    if (parts[0] === "input" && (PLAYTEST_KEYS as readonly string[]).includes(parts[1])) {
      if (parts[2] === "begin" || parts[2] === "end") {
        observedInputs.push(`${parts[1]}:${parts[2]}`);
      }
    } else if (parts[0] === "position" && parts.length >= 5) {
      const [x, y, z] = parts.slice(2, 5).map(Number);
      if ([x, y, z].every(Number.isFinite)) {
        positions.push({ label: parts[1], x, y, z });
      }
    }
  }
  return {
    observedInputs,
    positions,
  };
}

function assertPng(path: string): void {
  const bytes = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < signature.length || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error("Desktop capture did not produce a valid PNG file.");
  }
}

function toFailure(error: unknown): PlaytestFailure {
  if (error instanceof PlaytestFailure) return error;
  return new PlaytestFailure("OBSERVER_NOT_READY", error instanceof Error ? error.message : String(error));
}

function unsupportedResult(toolName: string): ToolResult {
  const message = `${toolName} is supported only on Windows 10/11.`;
  return {
    output: JSON.stringify({ status: "FAIL", failureCode: "UNSUPPORTED_PLATFORM", message }, null, 2),
    metadata: {
      error: true,
      status: "FAIL",
      failureCode: "UNSUPPORTED_PLATFORM",
      message,
    },
  };
}

function createOutputImages(paths: string[]): NonNullable<ToolResult["outputImages"]> {
  return paths.filter(existsSync).map((path) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data: readFileSync(path).toString("base64"),
    },
  }));
}

interface PlaytestToolSpec {
  name: "studio_playtest_smoke" | "studio_playtest_goal";
  description: string;
  parameters: z.ZodTypeAny;
}

function createPlaytestTool(options: PlaytestSmokeToolOptions, spec: PlaytestToolSpec): Tool {
  const platform = options.platform ?? process.platform;
  const desktop = options.desktop ?? createWindowsDesktopAdapter();
  const clock = options.clock ?? realClock;
  const env = options.env ?? process.env;
  const nextRunId = options.createRunId ?? createRunId;

  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    supportParallel: false,
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      if (platform !== "win32") return unsupportedResult(spec.name);

      const args = spec.parameters.parse(rawArgs) as PlaytestArgs;
      const actions = normalizeActions(args.actions);
      const desktopActions = toDesktopActions(actions);
      const requiredInputs = requiredInputsFor(actions);
      const approval = await ctx.approve({
        permission: "execute",
        toolName: spec.name,
        description: "Run a Windows OVERDARE smoke playtest with temporary script injection and real input",
        details: {
          actions,
          ...(args.successMarker ? { successMarker: args.successMarker } : {}),
          artifacts: "Writes before/after screenshots and a local playtest report.",
        },
      });
      if (approval === "reject") {
        return {
          output: "[Rejected by user]",
          metadata: { error: true, status: "FAIL", rejected: true },
        };
      }

      const runId = nextRunId();
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
        throw new Error("Playtest run ids may contain only letters, numbers, underscores, and hyphens.");
      }

      const runDir = join(resolvePaths(options.cwd, env).root, "playtests", "runs", runId);
      const beforeImage = join(runDir, "before.png");
      const afterImage = join(runDir, "after.png");
      const tracePath = join(runDir, "trace.jsonl");
      const reportPath = join(runDir, "report.json");
      mkdirSync(runDir, { recursive: true });

      const startedAtMs = clock.now();
      const trace: PlaytestTraceEvent[] = [];
      const addTrace = (event: string, details?: Record<string, unknown>) => {
        trace.push({
          timestamp: new Date(clock.now()).toISOString(),
          elapsedMs: Math.max(0, clock.now() - startedAtMs),
          event,
          ...(details ? { details } : {}),
        });
      };

      let observerGuid: string | undefined;
      let playAttempted = false;
      let selectedWindow: DesktopWindow | undefined;
      let windowCandidates: DesktopWindow[] | undefined;
      let primaryFailure: PlaytestFailure | undefined;
      let observedInputs: string[] = [];
      let positions: PositionObservation[] = [];
      let successMarkerObserved: boolean | undefined = args.successMarker ? false : undefined;
      const cleanupErrors: string[] = [];
      const release = await options.writeLock.acquire();

      try {
        if (ctx.signal.aborted) throw new PlaytestFailure("INTERRUPTED", "The playtest was interrupted.");
        addTrace("run.started", { runId });
        ctx.onUpdate?.("Locating StarterPlayerScripts…");

        let browseResult: unknown;
        try {
          browseResult = await options.callRpc("level.browse", {});
        } catch (error) {
          throw new PlaytestFailure(
            "STARTER_PLAYER_SCRIPTS_NOT_FOUND",
            `Could not browse the Studio level: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const starterPlayerScripts = collectStarterPlayerScripts(browseResult);
        if (starterPlayerScripts.length !== 1) {
          throw new PlaytestFailure(
            "STARTER_PLAYER_SCRIPTS_NOT_FOUND",
            `Expected exactly one StarterPlayerScripts instance, found ${starterPlayerScripts.length}.`,
            { candidates: starterPlayerScripts },
          );
        }

        const observerName = `__DiligentPlaytestObserver_${runId}`;
        try {
          const added = addScriptToDocument(options.cwd, {
            class: "LocalScript",
            parentGuid: starterPlayerScripts[0].guid,
            name: observerName,
            source: buildObserverSource(runId),
          });
          observerGuid = added.guid;
          await options.callRpc("level.apply", {});
        } catch (error) {
          throw new PlaytestFailure(
            "OBSERVER_NOT_READY",
            `Could not inject the playtest observer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        addTrace("observer.injected", { observerGuid, observerName });

        ctx.onUpdate?.("Starting Studio playtest and waiting for the observer…");
        playAttempted = true;
        try {
          await options.callRpc("game.play", {});
        } catch (error) {
          throw new PlaytestFailure(
            "OBSERVER_NOT_READY",
            `Could not start the Studio playtest: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const readyLog = await waitForLog(
          options.cwd,
          (log) => log.includes(markerFor(runId, "ready")),
          READY_TIMEOUT_MS,
          clock,
          ctx.signal,
        );
        if (!readyLog) {
          throw new PlaytestFailure("OBSERVER_NOT_READY", "The observer did not emit ready within 10 seconds.");
        }
        addTrace("observer.ready");

        ctx.onUpdate?.("Selecting and capturing the OVERDARE play window…");
        const windowMatch = env.OVERDARE_PLAYTEST_WINDOW_MATCH?.trim() || DEFAULT_WINDOW_MATCH;
        try {
          windowCandidates = await desktop.listWindows(windowMatch, ctx.signal);
        } catch (error) {
          if (ctx.signal.aborted) throw new PlaytestFailure("INTERRUPTED", "The playtest was interrupted.");
          throw new PlaytestFailure(
            "STUDIO_WINDOW_NOT_FOUND",
            `Could not enumerate OVERDARE windows: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (windowCandidates.length === 0) {
          throw new PlaytestFailure("STUDIO_WINDOW_NOT_FOUND", "No matching visible OVERDARE window was found.");
        } else if (windowCandidates.length > 1) {
          throw new PlaytestFailure(
            "AMBIGUOUS_STUDIO_WINDOWS",
            `Found ${windowCandidates.length} matching OVERDARE windows. Close or hide extra matching windows before a new run.`,
            { candidates: windowCandidates },
          );
        } else {
          selectedWindow = windowCandidates[0];
        }
        addTrace("window.selected", { ...selectedWindow });

        try {
          await desktop.capture({
            windowId: selectedWindow.id,
            match: windowMatch,
            outputPath: beforeImage,
            signal: ctx.signal,
          });
          assertPng(beforeImage);
          addTrace("capture.before", { path: beforeImage });
        } catch (error) {
          if (ctx.signal.aborted) throw new PlaytestFailure("INTERRUPTED", "The playtest was interrupted.");
          throw new PlaytestFailure(
            "CAPTURE_FAILED",
            `Could not capture the pre-input frame: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        ctx.onUpdate?.("Sending the bounded playtest input timeline…");
        try {
          await desktop.applyActions({
            windowId: selectedWindow.id,
            match: windowMatch,
            actions: desktopActions,
            signal: ctx.signal,
          });
          addTrace("input.applied", { actions });
        } catch (error) {
          if (ctx.signal.aborted) throw new PlaytestFailure("INTERRUPTED", "The playtest was interrupted.");
          throw new PlaytestFailure(
            "INPUT_NOT_OBSERVED",
            `Could not apply the smoke input: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        try {
          await desktop.capture({
            windowId: selectedWindow.id,
            match: windowMatch,
            outputPath: afterImage,
            signal: ctx.signal,
          });
          assertPng(afterImage);
          addTrace("capture.after", { path: afterImage });
        } catch (error) {
          if (ctx.signal.aborted) throw new PlaytestFailure("INTERRUPTED", "The playtest was interrupted.");
          throw new PlaytestFailure(
            "CAPTURE_FAILED",
            `Could not capture the post-input frame: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const inputLog = await waitForLog(
          options.cwd,
          (log) => {
            const observations = parseObservations(log, runId);
            const inputsComplete =
              countOrderedMatches(observations.observedInputs, requiredInputs) === requiredInputs.length;
            const goalComplete = !args.successMarker || log.includes(args.successMarker);
            return inputsComplete && goalComplete;
          },
          INPUT_TIMEOUT_MS,
          clock,
          ctx.signal,
        );
        const observations = parseObservations(inputLog ?? readPlayLog(options.cwd), runId);
        observedInputs = observations.observedInputs;
        positions = observations.positions;
        const matchedInputCount = countOrderedMatches(observedInputs, requiredInputs);
        if (matchedInputCount !== requiredInputs.length) {
          throw new PlaytestFailure(
            "INPUT_NOT_OBSERVED",
            `Observed ${matchedInputCount} of ${requiredInputs.length} required ordered input markers.`,
            { observedInputs, requiredInputs },
          );
        }
        addTrace("input.observed", { requiredInputs, observedInputs, positions });

        if (args.successMarker) {
          const finalLog = inputLog ?? readPlayLog(options.cwd);
          successMarkerObserved = finalLog.includes(args.successMarker);
          if (!successMarkerObserved) {
            throw new PlaytestFailure(
              "GOAL_NOT_OBSERVED",
              `Input delivery succeeded, but Play.log did not contain the required game marker ${args.successMarker}.`,
              { successMarker: args.successMarker },
            );
          }
          addTrace("goal.observed", { successMarker: args.successMarker });
        }
      } catch (error) {
        primaryFailure = toFailure(error);
        if (primaryFailure.details?.candidates && Array.isArray(primaryFailure.details.candidates)) {
          windowCandidates = primaryFailure.details.candidates as DesktopWindow[];
        }
        addTrace("run.failed", { code: primaryFailure.code, message: primaryFailure.message });
      } finally {
        ctx.onUpdate?.("Stopping playtest and removing the temporary observer…");
        if (playAttempted) {
          try {
            await options.callRpc("game.stop", {});
            addTrace("cleanup.game_stopped");
          } catch (error) {
            cleanupErrors.push(`game.stop: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (observerGuid) {
          try {
            deleteScriptFromDocument(options.cwd, observerGuid);
            await options.callRpc("level.apply", {});
            addTrace("cleanup.observer_removed", { observerGuid });
          } catch (error) {
            cleanupErrors.push(`observer.delete: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        release();
      }

      const cleanupSucceeded = cleanupErrors.length === 0;
      const finalFailure = cleanupSucceeded
        ? primaryFailure
        : new PlaytestFailure("CLEANUP_FAILED", `Playtest cleanup failed: ${cleanupErrors.join("; ")}`);
      const status = finalFailure ? "FAIL" : "PASS";
      addTrace(status === "PASS" ? "run.passed" : "run.completed_with_failure", {
        ...(finalFailure ? { code: finalFailure.code } : {}),
        cleanupSucceeded,
      });

      const report: PlaytestReport = {
        version: 2,
        runId,
        status,
        ...(finalFailure ? { failureCode: finalFailure.code } : {}),
        message:
          finalFailure?.message ??
          `Observer, ${requiredInputs.length} ordered input markers${
            args.successMarker ? `, game marker ${args.successMarker}` : ""
          }, screenshots, and cleanup all succeeded.`,
        ...(selectedWindow ? { window: selectedWindow } : {}),
        ...(windowCandidates && windowCandidates.length > 0 ? { windowCandidates } : {}),
        actions,
        requiredInputs,
        observedInputs,
        positions,
        ...(args.successMarker
          ? { successMarker: args.successMarker, successMarkerObserved: successMarkerObserved ?? false }
          : {}),
        cleanupSucceeded,
        cleanupErrors,
        ...(primaryFailure && finalFailure?.code === "CLEANUP_FAILED"
          ? { primaryFailure: { code: primaryFailure.code, message: primaryFailure.message } }
          : {}),
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(clock.now()).toISOString(),
        artifacts: {
          beforeImage,
          afterImage,
          trace: tracePath,
          report: reportPath,
        },
      };

      writeFileSync(tracePath, `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`);
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const output = {
        status: report.status,
        ...(report.failureCode ? { failureCode: report.failureCode } : {}),
        message: report.message,
        runId,
        actions,
        requiredInputs,
        observedInputs,
        positions,
        ...(args.successMarker
          ? { successMarker: args.successMarker, successMarkerObserved: successMarkerObserved ?? false }
          : {}),
        cleanupSucceeded,
        artifacts: report.artifacts,
        ...(report.windowCandidates && !selectedWindow ? { windowCandidates: report.windowCandidates } : {}),
      };
      return {
        output: JSON.stringify(output, null, 2),
        outputImages: createOutputImages([beforeImage, afterImage]),
        metadata: {
          ...(status === "FAIL" ? { error: true } : {}),
          status,
          ...(report.failureCode ? { failureCode: report.failureCode } : {}),
          runId,
          actions,
          requiredInputs,
          observedInputs,
          positions,
          ...(args.successMarker
            ? { successMarker: args.successMarker, successMarkerObserved: successMarkerObserved ?? false }
            : {}),
          cleanupSucceeded,
          reportPath,
          tracePath,
        },
      };
    },
  };
}

export function createPlaytestSmokeTool(options: PlaytestSmokeToolOptions): Tool {
  return createPlaytestTool(options, {
    name: "studio_playtest_smoke",
    description:
      "Run one bounded input-delivery playtest in OVERDARE Studio. It accepts a short timeline whose steps hold " +
      "any combination of W, A, S, D, and SPACE. Omit `actions` to use the legacy W 500 ms then SPACE smoke " +
      "sequence. The tool captures before/after images, verifies ordered input markers, stops play, removes its " +
      "temporary observer, and returns evidence. It does not evaluate a game win condition; use " +
      "`studio_playtest_goal` when a real gameplay success marker is required. Windows only. Never provide " +
      "`windowId`; the schema intentionally does not expose it. Call once per requested run, and if it fails " +
      "report the evidence without automatically retrying.",
    parameters: PlaytestSmokeParams,
  });
}

export function createPlaytestGoalTool(options: PlaytestSmokeToolOptions): Tool {
  return createPlaytestTool(options, {
    name: "studio_playtest_goal",
    description:
      "Run one bounded gameplay-goal playtest in OVERDARE Studio. Provide a short action timeline using W, A, S, " +
      "D, and SPACE plus the exact `successMarker` already emitted by the game's real win path. The tool captures " +
      "before/after images, verifies ordered input markers and the success marker, stops play, removes its " +
      "temporary observer, and returns evidence. Never invent a placeholder marker. Windows only. Never provide " +
      "`windowId`; the schema intentionally does not expose it. Call once per requested run, and if it fails " +
      "report the evidence without automatically retrying.",
    parameters: PlaytestGoalParams,
  });
}
