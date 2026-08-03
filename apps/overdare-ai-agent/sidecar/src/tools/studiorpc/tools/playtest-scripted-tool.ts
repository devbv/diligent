// @summary Runs one bounded temporary client Luau playtest driver with checkpoints, goal evidence, and cleanup.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@diligent/runtime";
import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { addScriptToDocument, deleteScriptFromDocument } from "./script-document-operations";

const MARKER_PREFIX = "@@DILIGENT_SCRIPTED_PLAYTEST@@";
const APPLY_READY_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 10_000;
const DEFAULT_DRIVER_TIMEOUT_MS = 15_000;
const MIN_DRIVER_TIMEOUT_MS = 1_000;
const MAX_DRIVER_TIMEOUT_MS = 30_000;
const MAX_DRIVER_SOURCE_BYTES = 20_000;
const MAX_CHECKPOINTS = 20;
const POLL_INTERVAL_MS = 100;
const TOKEN_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const TokenParam = z.string().min(1).max(80).regex(TOKEN_PATTERN);
const ScriptedPlaytestParams = z
  .object({
    driverSource: z
      .string()
      .min(1)
      .refine(
        (source) => Buffer.byteLength(source, "utf8") <= MAX_DRIVER_SOURCE_BYTES,
        `driverSource may not exceed ${MAX_DRIVER_SOURCE_BYTES.toLocaleString()} UTF-8 bytes.`,
      )
      .describe(
        'Body of one temporary client Luau driver. It may call checkpoint("TOKEN") and must return after the scenario settles.',
      ),
    expectedCheckpoints: z
      .array(TokenParam)
      .min(1)
      .max(MAX_CHECKPOINTS)
      .refine((values) => new Set(values).size === values.length, "Expected checkpoint tokens must be unique.")
      .describe('Ordered checkpoint tokens that the driver must emit through checkpoint("TOKEN").'),
    successMarker: TokenParam.describe(
      "Exact marker emitted by the real game success path. The driver source must not print or contain this token.",
    ),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_DRIVER_TIMEOUT_MS)
      .max(MAX_DRIVER_TIMEOUT_MS)
      .default(DEFAULT_DRIVER_TIMEOUT_MS)
      .describe("Maximum driver runtime in milliseconds."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.driverSource.includes(MARKER_PREFIX)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["driverSource"],
        message: "driverSource may not contain the reserved scripted-playtest marker prefix.",
      });
    }
    if (value.driverSource.includes(value.successMarker)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["driverSource"],
        message: "driverSource may not contain the real game success marker.",
      });
    }
  });

export type ScriptedPlaytestFailureCode =
  | "STARTER_PLAYER_SCRIPTS_NOT_FOUND"
  | "DRIVER_NOT_READY"
  | "PLAY_NOT_STARTED"
  | "DRIVER_FAILED"
  | "DRIVER_TIMEOUT"
  | "CHECKPOINTS_NOT_OBSERVED"
  | "GOAL_NOT_OBSERVED"
  | "CLEANUP_FAILED"
  | "INTERRUPTED";

export interface ScriptedPlaytestClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const realClock: ScriptedPlaytestClock = {
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

interface ScriptedObservation {
  ready: boolean;
  completed: boolean;
  checkpoints: string[];
  error?: string;
}

interface ScriptedTraceEvent {
  timestamp: string;
  elapsedMs: number;
  event: string;
  details?: Record<string, unknown>;
}

interface ScriptedPlaytestReport {
  version: 1;
  kind: "scripted";
  runId: string;
  status: "PASS" | "FAIL";
  failureCode?: ScriptedPlaytestFailureCode;
  message: string;
  driver: {
    bytes: number;
    sha256: string;
    timeoutMs: number;
  };
  expectedCheckpoints: string[];
  observedCheckpoints: string[];
  driverCompleted: boolean;
  driverError?: string;
  successMarker: string;
  successMarkerObserved: boolean;
  cleanupSucceeded: boolean;
  cleanupErrors: string[];
  primaryFailure?: { code: ScriptedPlaytestFailureCode; message: string };
  startedAt: string;
  finishedAt: string;
  artifacts: {
    driverSource: string;
    playLog: string;
    trace: string;
    report: string;
  };
}

class ScriptedPlaytestFailure extends Error {
  constructor(
    readonly code: ScriptedPlaytestFailureCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface PlaytestScriptedToolOptions {
  cwd: string;
  writeLock: WriteLock;
  callRpc: typeof call;
  clock?: ScriptedPlaytestClock;
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

function browseResultContainsGuid(result: unknown, guid: string): boolean {
  const roots = Array.isArray(result)
    ? result
    : typeof result === "object" &&
        result !== null &&
        "level" in result &&
        Array.isArray((result as { level: unknown }).level)
      ? (result as { level: unknown[] }).level
      : [];

  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return false;
    const node = value as BrowseNode;
    if (node.guid === guid) return true;
    return Array.isArray(node.children) && node.children.some(visit);
  };
  return roots.some(visit);
}

function buildDriverSource(runId: string, driverSource: string): string {
  const prefix = `${MARKER_PREFIX}|${runId}|`;
  const indentedDriver = driverSource
    .split(/\r?\n/)
    .map((line) => `\t${line}`)
    .join("\n");
  return [
    `local markerPrefix = ${JSON.stringify(prefix)}`,
    "",
    "local function __diligentEmit(value)",
    "\tprint(markerPrefix .. value)",
    "end",
    "",
    "local function checkpoint(value)",
    "\tlocal token = tostring(value)",
    '\tif #token < 1 or #token > 80 or not string.match(token, "^[%w_.:%-]+$") then',
    '\t\terror("checkpoint token must contain only letters, digits, _, ., :, or -")',
    "\tend",
    '\t__diligentEmit("checkpoint|" .. token)',
    "end",
    "",
    "local function waitUntil(predicate, timeoutSeconds, intervalSeconds)",
    "\tlocal timeout = tonumber(timeoutSeconds) or 5",
    "\tlocal interval = tonumber(intervalSeconds) or 0.05",
    '\tif timeout <= 0 or timeout > 30 then error("waitUntil timeout must be within 0-30 seconds") end',
    '\tif interval < 0.01 or interval > 1 then error("waitUntil interval must be within 0.01-1 seconds") end',
    "\tlocal deadline = os.clock() + timeout",
    "\trepeat",
    "\t\tlocal ok, result = pcall(predicate)",
    "\t\tif not ok then error(result) end",
    "\t\tif result then return result end",
    "\t\ttask.wait(interval)",
    "\tuntil os.clock() >= deadline",
    "\treturn nil",
    "end",
    "",
    "local function awaitSpawnedCharacter(timeoutSeconds)",
    '\tlocal players = game:GetService("Players")',
    "\tlocal player = players.LocalPlayer",
    '\tif not player then error("local player missing") end',
    "\tlocal character = waitUntil(function() return player.Character end, timeoutSeconds or 10, 0.05)",
    '\tif not character then error("character did not spawn before timeout") end',
    "\treturn character",
    "end",
    "",
    "local function awaitPlayableCharacter(timeoutSeconds)",
    "\tlocal timeout = tonumber(timeoutSeconds) or 10",
    "\tlocal character = awaitSpawnedCharacter(timeout)",
    '\tlocal humanoid = character:WaitForChild("Humanoid", math.min(timeout, 5))',
    '\tlocal rootPart = character:WaitForChild("HumanoidRootPart", math.min(timeout, 5))',
    '\tif not humanoid or not rootPart then error("character movement components unavailable") end',
    "\tlocal spawnGraceSeconds = math.min(1.5, timeout / 2)",
    "\ttask.wait(spawnGraceSeconds)",
    "\tlocal settledSamples = 0",
    "\tlocal lastState = humanoid:GetState()",
    "\tlocal previousY = rootPart.Position.Y",
    "\tlocal settled = waitUntil(function()",
    "\t\tlastState = humanoid:GetState()",
    "\t\tlocal verticalSpeed = math.abs(rootPart.AssemblyLinearVelocity.Y)",
    "\t\tlocal verticalPositionDelta = math.abs(rootPart.Position.Y - previousY)",
    "\t\tlocal airborne = lastState == Enum.HumanoidStateType.Freefall",
    "\t\t\tor lastState == Enum.HumanoidStateType.Jumping",
    "\t\t\tor lastState == Enum.HumanoidStateType.Dead",
    "\t\tif not airborne and verticalSpeed <= 100 and verticalPositionDelta <= 5 then",
    "\t\t\tsettledSamples += 1",
    "\t\telse",
    "\t\t\tsettledSamples = 0",
    "\t\tend",
    "\t\tpreviousY = rootPart.Position.Y",
    "\t\treturn settledSamples >= 5",
    "\tend, timeout - spawnGraceSeconds, 0.1)",
    "\tif not settled then",
    '\t\terror("character did not reach a stable playable state: " .. tostring(lastState))',
    "\tend",
    "\treturn character, humanoid, rootPart",
    "end",
    "",
    "local function awaitCharacter(timeoutSeconds)",
    "\tlocal character = awaitPlayableCharacter(timeoutSeconds)",
    "\treturn character",
    "end",
    "",
    "local function formatVector3(value)",
    '\treturn string.format("(%.2f, %.2f, %.2f)", value.X, value.Y, value.Z)',
    "end",
    "",
    "local function moveCharacterTo(humanoid, rootPart, destination, timeoutSeconds, horizontalTolerance, verticalTolerance)",
    "\tlocal destinationPosition = destination",
    '\tif typeof(destination) == "Instance" and destination:IsA("BasePart") then',
    "\t\tdestinationPosition = Vector3.new(destination.Position.X, rootPart.Position.Y, destination.Position.Z)",
    "\tend",
    '\tif typeof(destinationPosition) ~= "Vector3" then error("MoveTo destination must be a Vector3 or BasePart") end',
    "\tlocal timeout = tonumber(timeoutSeconds) or 8",
    "\tlocal allowedHorizontalError = tonumber(horizontalTolerance) or 60",
    "\tlocal allowedVerticalError = tonumber(verticalTolerance) or 200",
    "\tlocal function currentPositionError()",
    "\t\tlocal delta = rootPart.Position - destinationPosition",
    "\t\tlocal horizontalError = math.sqrt(delta.X * delta.X + delta.Z * delta.Z)",
    "\t\tlocal verticalError = math.abs(delta.Y)",
    "\t\treturn horizontalError, verticalError",
    "\tend",
    "\tlocal reached = false",
    "\tlocal connection = humanoid.MoveToFinished:Connect(function(success)",
    "\t\treached = success",
    "\tend)",
    "\thumanoid:MoveTo(destinationPosition)",
    "\tlocal completed = waitUntil(function()",
    "\t\tlocal horizontalError, verticalError = currentPositionError()",
    "\t\treturn reached or (horizontalError <= allowedHorizontalError and verticalError <= allowedVerticalError)",
    "\tend, timeout, 0.05)",
    "\tconnection:Disconnect()",
    "\tif not completed then",
    '\t\terror("MoveToFinished timed out: root=" .. formatVector3(rootPart.Position) .. " target=" .. formatVector3(destinationPosition) .. " state=" .. tostring(humanoid:GetState()))',
    "\tend",
    "\ttask.wait(0.15)",
    "\tlocal state = humanoid:GetState()",
    "\tif state == Enum.HumanoidStateType.Freefall or state == Enum.HumanoidStateType.Jumping then",
    '\t\terror("character is airborne after MoveTo")',
    "\tend",
    "\tlocal horizontalError, verticalError = currentPositionError()",
    "\tif horizontalError > allowedHorizontalError or verticalError > allowedVerticalError then",
    '\t\terror(string.format("MoveTo position mismatch: horizontal=%.2f vertical=%.2f", horizontalError, verticalError))',
    "\tend",
    "\treturn rootPart.Position",
    "end",
    "",
    '__diligentEmit("driver|ready")',
    "local __diligentOk, __diligentFailure = xpcall(function()",
    indentedDriver,
    "end, function(errorValue)",
    "\treturn tostring(errorValue)",
    "end)",
    "",
    "if __diligentOk then",
    '\t__diligentEmit("driver|complete")',
    "else",
    '\tlocal cleanFailure = string.gsub(tostring(__diligentFailure), "[|\\r\\n]", " ")',
    '\t__diligentEmit("driver|error|" .. string.sub(cleanFailure, 1, 240))',
    "end",
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

function isolateCurrentRunLog(log: string, baseline: string): string {
  if (log === baseline) return "";
  if (!baseline || !log.startsWith(baseline)) return log;
  const appended = log.slice(baseline.length);
  if (appended.startsWith("\r\n")) return appended.slice(2);
  if (appended.startsWith("\n")) return appended.slice(1);
  return appended;
}

function parseObservation(log: string, runId: string): ScriptedObservation {
  const marker = `${MARKER_PREFIX}|${runId}|`;
  const observation: ScriptedObservation = {
    ready: false,
    completed: false,
    checkpoints: [],
  };
  for (const line of log.split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const parts = line
      .slice(index + marker.length)
      .trim()
      .split("|");
    if (parts[0] === "driver" && parts[1] === "ready") {
      observation.ready = true;
    } else if (parts[0] === "driver" && parts[1] === "complete") {
      observation.completed = true;
    } else if (parts[0] === "driver" && parts[1] === "error") {
      observation.error = parts.slice(2).join("|").trim() || "unknown driver error";
    } else if (parts[0] === "checkpoint" && TOKEN_PATTERN.test(parts[1] ?? "")) {
      observation.checkpoints.push(parts[1]);
    }
  }
  return observation;
}

function countOrderedMatches(observed: string[], expected: string[]): number {
  let matched = 0;
  for (const checkpoint of observed) {
    if (checkpoint === expected[matched]) matched++;
    if (matched === expected.length) break;
  }
  return matched;
}

async function waitForLog(
  cwd: string,
  predicate: (log: string) => boolean,
  timeoutMs: number,
  clock: ScriptedPlaytestClock,
  signal: AbortSignal,
): Promise<string | undefined> {
  const startedAt = clock.now();
  while (clock.now() - startedAt <= timeoutMs) {
    if (signal.aborted) {
      throw new ScriptedPlaytestFailure("INTERRUPTED", "The scripted playtest was interrupted.");
    }
    const log = readPlayLog(cwd);
    if (predicate(log)) return log;
    const elapsedMs = clock.now() - startedAt;
    if (elapsedMs === timeoutMs) break;
    await clock.sleep(Math.min(POLL_INTERVAL_MS, timeoutMs - elapsedMs), signal);
  }
  return undefined;
}

async function waitForBrowseGuid(
  callRpc: typeof call,
  guid: string,
  timeoutMs: number,
  clock: ScriptedPlaytestClock,
  signal: AbortSignal,
): Promise<{ found: boolean; lastError?: string }> {
  const startedAt = clock.now();
  let lastError: string | undefined;
  while (clock.now() - startedAt <= timeoutMs) {
    if (signal.aborted) {
      throw new ScriptedPlaytestFailure("INTERRUPTED", "The scripted playtest was interrupted.");
    }
    try {
      const result = await callRpc("level.browse", {});
      if (browseResultContainsGuid(result, guid)) return { found: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const elapsedMs = clock.now() - startedAt;
    if (elapsedMs === timeoutMs) break;
    await clock.sleep(Math.min(POLL_INTERVAL_MS, timeoutMs - elapsedMs), signal);
  }
  return { found: false, ...(lastError ? { lastError } : {}) };
}

function toFailure(error: unknown): ScriptedPlaytestFailure {
  if (error instanceof ScriptedPlaytestFailure) return error;
  return new ScriptedPlaytestFailure("DRIVER_NOT_READY", error instanceof Error ? error.message : String(error));
}

export function createPlaytestScriptedTool(options: PlaytestScriptedToolOptions): Tool {
  const clock = options.clock ?? realClock;
  const env = options.env ?? process.env;
  const nextRunId = options.createRunId ?? createRunId;

  return {
    name: "studio_playtest_scripted",
    description:
      "Run one bounded complex gameplay scenario through a temporary client Luau driver. The driver may inspect " +
      'runtime state, call game-facing APIs, wait for conditions, and emit ordered checkpoint("TOKEN") evidence. ' +
      "The wrapper provides awaitCharacter(timeoutSeconds), which waits for a stable playable state by default, " +
      "plus bounded awaitSpawnedCharacter(timeoutSeconds), awaitPlayableCharacter(timeoutSeconds), " +
      "moveCharacterTo(humanoid, rootPart, destination, timeoutSeconds, horizontalTolerance, verticalTolerance), " +
      "and waitUntil(predicate, timeoutSeconds, intervalSeconds) helpers. " +
      "PASS additionally requires the exact successMarker from the real game path and successful cleanup. The " +
      "driver is removed after the run and its source is retained only as a playtest artifact. This is gray-box " +
      "scenario execution and does not prove real player input. Do not print or construct the success marker in " +
      "driverSource. Call once per requested run and never retry automatically after failure.",
    parameters: ScriptedPlaytestParams,
    supportParallel: false,
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = ScriptedPlaytestParams.parse(rawArgs);
      const driverBytes = Buffer.byteLength(args.driverSource, "utf8");
      const driverSha256 = createHash("sha256").update(args.driverSource).digest("hex");
      const approval = await ctx.approve({
        permission: "execute",
        toolName: "studio_playtest_scripted",
        description: "Run a temporary client Luau gameplay driver in OVERDARE Studio",
        details: {
          driverBytes,
          driverSha256,
          expectedCheckpoints: args.expectedCheckpoints,
          successMarker: args.successMarker,
          timeoutMs: args.timeoutMs,
          artifacts: "Writes driver source, Play.log evidence, a trace, and a local report.",
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
        throw new Error("Scripted playtest run ids may contain only letters, numbers, underscores, and hyphens.");
      }

      const runDir = join(resolvePaths(options.cwd, env).root, "playtests", "runs", runId);
      const driverPath = join(runDir, "driver.luau");
      const playLogPath = join(runDir, "play.log");
      const tracePath = join(runDir, "trace.jsonl");
      const reportPath = join(runDir, "report.json");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(driverPath, `${args.driverSource}\n`);

      const startedAtMs = clock.now();
      const trace: ScriptedTraceEvent[] = [];
      const addTrace = (event: string, details?: Record<string, unknown>) => {
        trace.push({
          timestamp: new Date(clock.now()).toISOString(),
          elapsedMs: Math.max(0, clock.now() - startedAtMs),
          event,
          ...(details ? { details } : {}),
        });
      };

      let driverGuid: string | undefined;
      let playAttempted = false;
      let primaryFailure: ScriptedPlaytestFailure | undefined;
      let observation: ScriptedObservation = { ready: false, completed: false, checkpoints: [] };
      let successMarkerObserved = false;
      let finalPlayLog = "";
      let playLogBaseline: string | undefined;
      const cleanupErrors: string[] = [];
      const release = await options.writeLock.acquire();

      try {
        if (ctx.signal.aborted) {
          throw new ScriptedPlaytestFailure("INTERRUPTED", "The scripted playtest was interrupted.");
        }
        addTrace("run.started", { runId, driverBytes, driverSha256 });
        ctx.onUpdate?.("Locating StarterPlayerScripts for the temporary gameplay driver…");

        let browseResult: unknown;
        try {
          browseResult = await options.callRpc("level.browse", {});
        } catch (error) {
          throw new ScriptedPlaytestFailure(
            "STARTER_PLAYER_SCRIPTS_NOT_FOUND",
            `Could not browse the Studio level: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const starterPlayerScripts = collectStarterPlayerScripts(browseResult);
        if (starterPlayerScripts.length !== 1) {
          throw new ScriptedPlaytestFailure(
            "STARTER_PLAYER_SCRIPTS_NOT_FOUND",
            `Expected exactly one StarterPlayerScripts instance, found ${starterPlayerScripts.length}.`,
            { candidates: starterPlayerScripts },
          );
        }

        const driverName = `__DiligentScriptedPlaytest_${runId}`;
        try {
          const added = addScriptToDocument(options.cwd, {
            class: "LocalScript",
            parentGuid: starterPlayerScripts[0].guid,
            name: driverName,
            source: buildDriverSource(runId, args.driverSource),
          });
          driverGuid = added.guid;
          await options.callRpc("level.apply", {});
        } catch (error) {
          throw new ScriptedPlaytestFailure(
            "DRIVER_NOT_READY",
            `Could not inject the scripted playtest driver: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        addTrace("driver.injected", { driverGuid, driverName });

        const appliedDriver = await waitForBrowseGuid(
          options.callRpc,
          driverGuid,
          APPLY_READY_TIMEOUT_MS,
          clock,
          ctx.signal,
        );
        if (!appliedDriver.found) {
          throw new ScriptedPlaytestFailure(
            "DRIVER_NOT_READY",
            `The temporary driver did not become visible in Studio within ${APPLY_READY_TIMEOUT_MS.toLocaleString()} ms.`,
            appliedDriver.lastError ? { lastBrowseError: appliedDriver.lastError } : undefined,
          );
        }
        addTrace("driver.applied", { driverGuid });

        ctx.onUpdate?.("Starting Studio play and waiting for the scripted driver…");
        playAttempted = true;
        playLogBaseline = readPlayLog(options.cwd);
        try {
          await options.callRpc("game.play", {});
        } catch (error) {
          throw new ScriptedPlaytestFailure(
            "DRIVER_NOT_READY",
            `Could not start the Studio playtest: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const readyLog = await waitForLog(
          options.cwd,
          (log) => parseObservation(isolateCurrentRunLog(log, playLogBaseline ?? ""), runId).ready,
          READY_TIMEOUT_MS,
          clock,
          ctx.signal,
        );
        if (!readyLog) {
          const latestLog = readPlayLog(options.cwd);
          finalPlayLog = isolateCurrentRunLog(latestLog, playLogBaseline ?? "");
          if (latestLog === playLogBaseline) {
            throw new ScriptedPlaytestFailure(
              "PLAY_NOT_STARTED",
              "Studio RPC returned from game.play, but Play.log did not reset or produce new output within 10 seconds.",
            );
          }
          throw new ScriptedPlaytestFailure(
            "DRIVER_NOT_READY",
            "The temporary driver did not start within 10 seconds.",
          );
        }
        const currentReadyLog = isolateCurrentRunLog(readyLog, playLogBaseline ?? "");
        observation = parseObservation(currentReadyLog, runId);
        addTrace("driver.ready");

        ctx.onUpdate?.("Executing the bounded Luau gameplay scenario…");
        const terminalLog =
          observation.completed || observation.error
            ? currentReadyLog
            : await waitForLog(
                options.cwd,
                (log) => {
                  const current = parseObservation(isolateCurrentRunLog(log, playLogBaseline ?? ""), runId);
                  return current.completed || current.error !== undefined;
                },
                args.timeoutMs,
                clock,
                ctx.signal,
              );
        finalPlayLog = terminalLog
          ? isolateCurrentRunLog(terminalLog, playLogBaseline ?? "")
          : isolateCurrentRunLog(readPlayLog(options.cwd), playLogBaseline ?? "");
        observation = parseObservation(finalPlayLog, runId);
        successMarkerObserved = finalPlayLog.includes(args.successMarker);
        addTrace("checkpoints.observed", {
          expected: args.expectedCheckpoints,
          observed: observation.checkpoints,
        });

        if (observation.error) {
          throw new ScriptedPlaytestFailure("DRIVER_FAILED", `The gameplay driver failed: ${observation.error}`, {
            driverError: observation.error,
          });
        }
        if (!observation.completed) {
          throw new ScriptedPlaytestFailure(
            "DRIVER_TIMEOUT",
            `The gameplay driver did not complete within ${args.timeoutMs.toLocaleString()} ms.`,
          );
        }
        addTrace("driver.completed");

        const matchedCheckpoints = countOrderedMatches(observation.checkpoints, args.expectedCheckpoints);
        if (matchedCheckpoints !== args.expectedCheckpoints.length) {
          throw new ScriptedPlaytestFailure(
            "CHECKPOINTS_NOT_OBSERVED",
            `Observed ${matchedCheckpoints} of ${args.expectedCheckpoints.length} required ordered checkpoints.`,
            {
              expectedCheckpoints: args.expectedCheckpoints,
              observedCheckpoints: observation.checkpoints,
            },
          );
        }
        addTrace("checkpoints.matched", { checkpoints: args.expectedCheckpoints });

        if (!successMarkerObserved) {
          throw new ScriptedPlaytestFailure(
            "GOAL_NOT_OBSERVED",
            `The driver completed, but Play.log did not contain the real game marker ${args.successMarker}.`,
            { successMarker: args.successMarker },
          );
        }
        addTrace("goal.observed", { successMarker: args.successMarker });
      } catch (error) {
        primaryFailure = toFailure(error);
        addTrace("run.failed", { code: primaryFailure.code, message: primaryFailure.message });
      } finally {
        ctx.onUpdate?.("Stopping play and removing the temporary gameplay driver…");
        if (playAttempted) {
          try {
            await options.callRpc("game.stop", {});
            addTrace("cleanup.game_stopped");
          } catch (error) {
            cleanupErrors.push(`game.stop: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (driverGuid) {
          try {
            deleteScriptFromDocument(options.cwd, driverGuid);
            await options.callRpc("level.apply", {});
            addTrace("cleanup.driver_removed", { driverGuid });
          } catch (error) {
            cleanupErrors.push(`driver.delete: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        release();
      }

      if (!finalPlayLog && playLogBaseline !== undefined) {
        finalPlayLog = isolateCurrentRunLog(readPlayLog(options.cwd), playLogBaseline);
      }
      observation = parseObservation(finalPlayLog, runId);
      successMarkerObserved = finalPlayLog.includes(args.successMarker);
      writeFileSync(playLogPath, finalPlayLog);

      const cleanupSucceeded = cleanupErrors.length === 0;
      const finalFailure = cleanupSucceeded
        ? primaryFailure
        : new ScriptedPlaytestFailure(
            "CLEANUP_FAILED",
            `Scripted playtest cleanup failed: ${cleanupErrors.join("; ")}`,
          );
      const status = finalFailure ? "FAIL" : "PASS";
      addTrace(status === "PASS" ? "run.passed" : "run.completed_with_failure", {
        ...(finalFailure ? { code: finalFailure.code } : {}),
        cleanupSucceeded,
      });

      const report: ScriptedPlaytestReport = {
        version: 1,
        kind: "scripted",
        runId,
        status,
        ...(finalFailure ? { failureCode: finalFailure.code } : {}),
        message:
          finalFailure?.message ??
          `Driver completion, ${args.expectedCheckpoints.length} ordered checkpoints, game marker ${args.successMarker}, and cleanup all succeeded.`,
        driver: {
          bytes: driverBytes,
          sha256: driverSha256,
          timeoutMs: args.timeoutMs,
        },
        expectedCheckpoints: args.expectedCheckpoints,
        observedCheckpoints: observation.checkpoints,
        driverCompleted: observation.completed,
        ...(observation.error ? { driverError: observation.error } : {}),
        successMarker: args.successMarker,
        successMarkerObserved,
        cleanupSucceeded,
        cleanupErrors,
        ...(primaryFailure && finalFailure?.code === "CLEANUP_FAILED"
          ? { primaryFailure: { code: primaryFailure.code, message: primaryFailure.message } }
          : {}),
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(clock.now()).toISOString(),
        artifacts: {
          driverSource: driverPath,
          playLog: playLogPath,
          trace: tracePath,
          report: reportPath,
        },
      };

      writeFileSync(tracePath, `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`);
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const output = {
        status,
        ...(report.failureCode ? { failureCode: report.failureCode } : {}),
        message: report.message,
        runId,
        expectedCheckpoints: report.expectedCheckpoints,
        observedCheckpoints: report.observedCheckpoints,
        driverCompleted: report.driverCompleted,
        ...(report.driverError ? { driverError: report.driverError } : {}),
        successMarker: report.successMarker,
        successMarkerObserved: report.successMarkerObserved,
        cleanupSucceeded,
        artifacts: report.artifacts,
      };
      return {
        output: JSON.stringify(output, null, 2),
        metadata: {
          ...(status === "FAIL" ? { error: true } : {}),
          status,
          ...(report.failureCode ? { failureCode: report.failureCode } : {}),
          runId,
          expectedCheckpoints: report.expectedCheckpoints,
          observedCheckpoints: report.observedCheckpoints,
          driverCompleted: report.driverCompleted,
          ...(report.driverError ? { driverError: report.driverError } : {}),
          successMarker: report.successMarker,
          successMarkerObserved: report.successMarkerObserved,
          cleanupSucceeded,
          reportPath,
          tracePath,
          playLogPath,
          driverPath,
        },
      };
    },
  };
}
