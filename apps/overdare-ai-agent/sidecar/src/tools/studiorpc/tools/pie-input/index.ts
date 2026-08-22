// @summary Agent-facing play-test tools: PIE status, input injection, and character moveTo.

import { z } from "zod";
import { rankNames, stripWorkspacePrefix } from "../../methods/live-instance-names";
import { call, StudioRpcError } from "../../rpc";
import type { Tool, ToolResult } from "../../types";
import {
  expandWithOrigin,
  type InputEvent,
  inputEventsSchema,
  MAX_EVENT_COUNT,
  normalizeEventShapes,
  totalWaitMs,
  validateBatch,
} from "./events";
import {
  buildInputInjectRender,
  buildMoveRouteRender,
  buildMoveToRender,
  buildPieStatusRender,
  isTerminalMoveStatus,
} from "./render";
import { type CallRpc, type PieTarget, readPieStatus, resolvePieTarget } from "./target";

const INJECT_OVERHEAD_MS = 15_000;
const MOVE_RPC_TIMEOUT_MS = 10_000;
const MOVE_POLL_INTERVAL_MS = 300;
const MOVE_WAIT_DEFAULT_MS = 30_000;
const MOVE_WAIT_MAX_MS = 300_000;
const ARRIVAL_TOLERANCE = 150;
const MOVED_AT_ALL = 5;
const MOVE_NAME_SUGGESTIONS = 8;
const TOUCH_MARGIN = 60;
const ALREADY_AT_RADIUS = 30;
const CHARACTER_ORIGIN_ABOVE_FEET = 84;
const TRACK_MOVE_THRESHOLD = 25;
const TRACK_MAX_SAMPLES = 24;
const MAX_MOVE_WAYPOINTS = 32;

const targetOverrides = {
  pieSessionId: z
    .string()
    .optional()
    .describe("Session to target. Omit to use the live session reported by game.pie.status."),
  clientId: z.string().optional().describe("PIE client to target. Omit to use the first injectable client."),
};

const injectParams = z.object({
  events: z.preprocess(normalizeEventShapes, inputEventsSchema),
  ...targetOverrides,
});

const moveDestination = z.union([z.string().min(1), z.object({ x: z.number(), y: z.number(), z: z.number() })]);

const moveToShape = {
  target: z
    .union([moveDestination, z.array(moveDestination).min(1).max(MAX_MOVE_WAYPOINTS)])
    .describe(
      "One runtime name, dotted path, or OVERDARE world position, or an array of up to 32 waypoints to walk " +
        "in order. Named targets are measured to their surface. For a bare position, use ground-level y rather " +
        "than an object's center height.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(MOVE_WAIT_MAX_MS)
    .optional()
    .describe(
      `How long to wait for the move to end. Defaults to ${MOVE_WAIT_DEFAULT_MS}ms. For a waypoint array, ` +
        "this is the total route budget, not a new budget for each leg.",
    ),
  arrivedWithin: z
    .number()
    .min(0)
    .max(1_000)
    .optional()
    .describe(
      `Final-position acceptance radius for an {x, y, z} navigation target. Defaults to ${ARRIVAL_TOLERANCE} ` +
        "world units. Navigation still tries to approach the requested point and does not stop when it first enters " +
        "the radius; the radius accepts the result only after navigation ends or cannot progress. For a waypoint " +
        "array, the same radius applies to every coordinate. Named targets keep their surface rule.",
    ),
  pathMode: z
    .enum(["navigation", "teleport"])
    .optional()
    .describe(
      "How to reach the target. navigation (default) follows an Unreal Navigation System path around walkable " +
        "obstacles, but cannot invent jumps or operate game " +
        "mechanics. teleport moves to one target immediately and is only for arranging state outside the behavior " +
        "under test; landedAt reports the collision-adjusted destination.",
    ),
  ...targetOverrides,
};

const moveToParams = z
  .object(moveToShape)
  .strict()
  .superRefine((value, ctx) => {
    if (Array.isArray(value.target) && value.pathMode === "teleport") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pathMode"],
        message: "pathMode teleport accepts one target; use navigation for a waypoint array",
      });
    }
    if (value.arrivedWithin !== undefined) {
      const targets = Array.isArray(value.target) ? value.target : [value.target];
      if (targets.some((target) => typeof target === "string")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["arrivedWithin"],
          message: "arrivedWithin applies only to {x, y, z} targets; named targets use their surface",
        });
      }
      if (value.pathMode === "teleport") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["arrivedWithin"],
          message: "arrivedWithin applies to navigation; teleport reports its collision-adjusted landing point",
        });
      }
    }
  });

type InjectParams = z.infer<typeof injectParams>;
type MoveToParams = z.infer<typeof moveToParams>;
type MoveDestination = z.infer<typeof moveDestination>;

interface InjectResult {
  status?: string;
  failedEventIndex?: number;
  cancelledEventCount?: number;
  characterTrack?: Array<{ event: number; x: number; y: number; z: number; falling?: boolean }>;
  fellAtEvent?: number;
  looks?: Array<{
    status?: string;
    requested?: { yawDegrees?: number; pitchDegrees?: number };
    turned?: { yawDegrees?: number; pitchDegrees?: number };
    facing?: { yaw?: number; pitch?: number };
  }>;
}

interface MoveToResult {
  requestId?: string;
  status?: string;
  pathMode?: "navigation" | "teleport";
  teleported?: boolean;
  landedAt?: { x: number; y: number; z: number };
}

interface MoveStatusResult {
  requestId?: string;
  status?: string;
  clientId?: string;
  diagnostics?: Record<string, unknown>;
}

interface CharacterReadResult {
  character?: {
    CFrame?: { Position?: { X?: number; Y?: number; Z?: number } };
    standingOn?: { instanceName?: string; instanceGuid?: string; distance?: number } | null;
  };
}

interface CharacterState {
  position: { x: number; y: number; z: number };
  standingOnName?: string;
  falling?: boolean;
}

type MoveOutcome = "arrived" | "navigationGaveUp" | "stoppedShort" | "timedOut" | "interrupted";
type ArrivalReason = "standingOnTarget" | "atopTarget" | "withinRadius";
export function normalizeWaitedMoveStatus(outcome: MoveOutcome): string {
  switch (outcome) {
    case "arrived":
      return "reached";
    case "navigationGaveUp":
      return "navigationGaveUp";
    case "stoppedShort":
      return "stoppedShort";
    case "timedOut":
      return "timedOut";
    case "interrupted":
      return "interrupted";
  }
}
type ClientRef = { pieSessionId?: string; clientId?: string };

async function readCharacterState(callRpc: CallRpc, client?: ClientRef): Promise<CharacterState | undefined> {
  try {
    const result = (await callRpc(
      "game.character.read",
      client?.pieSessionId && client?.clientId ? { pieSessionId: client.pieSessionId, clientId: client.clientId } : {},
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as CharacterReadResult;
    const position = result?.character?.CFrame?.Position;
    if (typeof position?.X !== "number" || typeof position?.Y !== "number" || typeof position?.Z !== "number") {
      return undefined;
    }
    return {
      position: { x: position.X, y: position.Y, z: position.Z },
      standingOnName: result?.character?.standingOn?.instanceName,
      falling: result?.character?.standingOn === null,
    };
  } catch {
    return undefined;
  }
}

async function readCharacterPosition(
  callRpc: CallRpc,
  client?: ClientRef,
): Promise<{ x: number; y: number; z: number } | undefined> {
  return (await readCharacterState(callRpc, client))?.position;
}

function distanceBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

interface LiveInstance {
  instance?: {
    CFrame?: { Position?: { X?: number; Y?: number; Z?: number } };
    Size?: { X?: number; Y?: number; Z?: number };
    path?: string;
    class?: string;
  };
  matches?: number;
  otherPaths?: string[];
}
async function readLiveInstance(
  callRpc: CallRpc,
  target: { name?: string; path?: string },
): Promise<
  | {
      position: { x: number; y: number; z: number };
      half?: { x: number; y: number; z: number };
      path?: string;
      matches?: number;
      otherPaths?: string[];
    }
  | { positionless: true; path?: string; class?: string }
  | undefined
> {
  let result: LiveInstance;
  const query = target.path !== undefined ? { path: target.path } : { name: target.name };
  try {
    result = (await callRpc("game.instance.read", query, { timeoutMs: MOVE_RPC_TIMEOUT_MS })) as LiveInstance;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("is in the running Workspace")) return undefined;
    throw error;
  }
  if (result?.instance === undefined || result.instance === null) return undefined;
  const position = result.instance.CFrame?.Position;
  if (typeof position?.X !== "number" || typeof position?.Y !== "number" || typeof position?.Z !== "number") {
    return {
      positionless: true,
      path: typeof result?.instance?.path === "string" ? result.instance.path : undefined,
      class: typeof result?.instance?.class === "string" ? result.instance.class : undefined,
    };
  }
  const size = result?.instance?.Size;
  return {
    position: { x: position.X, y: position.Y, z: position.Z },
    half: size ? { x: (size.X ?? 0) / 2, y: (size.Y ?? 0) / 2, z: (size.Z ?? 0) / 2 } : undefined,
    path: typeof result?.instance?.path === "string" ? result.instance.path : undefined,
    matches: typeof result?.matches === "number" ? result.matches : undefined,
    otherPaths: Array.isArray(result?.otherPaths) ? (result.otherPaths as string[]) : undefined,
  };
}
async function nearbyNamesSentence(callRpc: CallRpc, wanted: string): Promise<string> {
  let names: string[] = [];
  try {
    const listing = (await callRpc("game.instance.read", {}, { timeoutMs: MOVE_RPC_TIMEOUT_MS })) as {
      instances?: { name?: string }[];
    };
    names = (listing?.instances ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return "Call studiorpc_game_observe with instances to see what is there.";
  }
  if (names.length === 0) return "Call studiorpc_game_observe with instances to see what is there.";
  const nearest = rankNames(names, wanted).slice(0, MOVE_NAME_SUGGESTIONS);
  if (nearest.length > 0) {
    return `Nearest names in the running world: ${nearest.join(", ")}.`;
  }
  return `The running world has ${names.length} named instances, none resembling that one: ${names.slice(0, MOVE_NAME_SUGGESTIONS).join(", ")}.`;
}
function distanceToSurface(
  point: { x: number; y: number; z: number },
  centre: { x: number; y: number; z: number },
  half: { x: number; y: number; z: number },
  ignoreVertical = false,
): number {
  const dx = Math.max(0, Math.abs(point.x - centre.x) - half.x);
  const dy = ignoreVertical ? 0 : Math.max(0, Math.abs(point.y - centre.y) - half.y);
  const dz = Math.max(0, Math.abs(point.z - centre.z) - half.z);
  return Math.hypot(dx, dy, dz);
}
type TrackSample = { x: number; y: number; z: number; atMs: number };
function compactRoute(
  route: TrackSample[] | undefined,
  startedAtMs: number,
): Array<{ ms: number; x: number; y: number; z: number }> | undefined {
  if (route === undefined || route.length === 0) return undefined;
  const entry = (sample: TrackSample) => ({
    ms: Math.max(0, Math.round(sample.atMs - startedAtMs)),
    x: Math.round(sample.x),
    y: Math.round(sample.y),
    z: Math.round(sample.z),
  });
  const kept: TrackSample[] = [];
  for (const sample of route) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || distanceBetween(previous, sample) > TRACK_MOVE_THRESHOLD) kept.push(sample);
  }
  const final = route[route.length - 1];
  if (kept[kept.length - 1] !== final) kept.push(final);
  if (kept.length <= TRACK_MAX_SAMPLES) return kept.map(entry);
  const step = (kept.length - 2) / (TRACK_MAX_SAMPLES - 2);
  const thinned = [kept[0]];
  for (let index = 1; index < TRACK_MAX_SAMPLES - 1; index++) thinned.push(kept[Math.round(index * step)]);
  thinned.push(kept[kept.length - 1]);
  return thinned.map(entry);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonOutput(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function withSignal(callRpc: CallRpc, signal: AbortSignal): CallRpc {
  return (method, params, options = {}) => callRpc(method, params, { ...options, signal });
}

function createPieStatusTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_pie_status",
    description:
      "Report PIE session state, pieSessionId, timeScale, and clients. targeted marks the default client. " +
      "Input, move, and character.read accept another injectable clientId; UI, screenshots, camera, and " +
      "game.observe use the targeted client.",
    parameters: z.object({}),
    supportParallel: true,
    async execute(_args, ctx): Promise<ToolResult> {
      const status = await readPieStatus(withSignal(callRpc, ctx.signal));
      return {
        output: jsonOutput(status),
        render: buildPieStatusRender(status),
        metadata: { tool: "studiorpc_game_pie_status", running: status.running, clients: status.clients.length },
      };
    },
  };
}

function createInputInjectTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_input_inject",
    description:
      "Apply a self-contained ordered batch of PIE keyboard, pointer, look, scroll, and wait events. Target " +
      "ids resolve automatically. The expanded batch is limited to 64 events and 60 seconds; every down must " +
      "have an up. Physical input in the targeted viewport cancels the batch and releases held state. On " +
      "failure, earlier events remain applied and failedEventIndex marks the stop. Verify game effects with " +
      "game.observe. characterTrack and fellAtEvent appear when the batch moved or dropped the character.",
    parameters: injectParams,
    async execute(args: InjectParams, ctx): Promise<ToolResult> {
      const toolCallRpc = withSignal(callRpc, ctx.signal);
      const events = normalizeEventShapes(args.events) as InputEvent[];
      const { sent, origin, raisedLooks } = expandWithOrigin(events);
      if (sent.length > MAX_EVENT_COUNT) {
        const retryFromEventIndex = origin[MAX_EVENT_COUNT] ?? events.length;
        const acceptedThroughEventIndex = retryFromEventIndex - 1;
        return {
          output: jsonOutput({
            status: "limitExceeded",
            limit: MAX_EVENT_COUNT,
            authoredEventCount: events.length,
            expandedEventCount: sent.length,
            acceptedThroughEventIndex,
            retryFromEventIndex,
            message:
              `The authored events through index ${acceptedThroughEventIndex} expand within Studio's ` +
              `${MAX_EVENT_COUNT}-event limit. Retry from index ${retryFromEventIndex} in a second call.`,
          }),
          metadata: {
            tool: "studiorpc_game_input_inject",
            status: "limitExceeded",
            eventCount: sent.length,
          },
        };
      }
      const batchError = validateBatch(sent, origin);
      if (batchError) throw new Error(batchError);

      const target = await resolvePieTarget(toolCallRpc, args);
      let result: InjectResult;
      try {
        result = (await toolCallRpc(
          "game.input.inject",
          { pieSessionId: target.pieSessionId, clientId: target.clientId, events: sent },
          { timeoutMs: totalWaitMs(sent) + INJECT_OVERHEAD_MS },
        )) as InjectResult;
      } catch (error) {
        const answered = expectedLookResult(error, sent);
        if (!answered) throw error;
        result = answered;
      }
      const toAuthored = (sentIndex: number) => origin[Math.min(sentIndex, origin.length - 1)] ?? events.length - 1;
      const failedEventIndex = result?.failedEventIndex === undefined ? undefined : toAuthored(result.failedEventIndex);
      const cancelledEventCount =
        failedEventIndex === undefined
          ? result?.cancelledEventCount
          : Math.max(0, events.length - failedEventIndex - 1);
      const track = result?.characterTrack?.map((sample) => ({
        ...sample,
        event: sample.event >= sent.length ? events.length : toAuthored(sample.event),
      }));

      return {
        output: jsonOutput({
          ...result,
          ...(failedEventIndex === undefined ? {} : { failedEventIndex }),
          ...(cancelledEventCount === undefined ? {} : { cancelledEventCount }),
          ...(track ? { characterTrack: track } : {}),
          ...(result?.fellAtEvent === undefined ? {} : { fellAtEvent: toAuthored(result.fellAtEvent) }),
          ...(raisedLooks.length > 0 ? { raisedLookTimeouts: raisedLooks } : {}),
          clientId: target.clientId,
        }),
        render: buildInputInjectRender(target, events, undefined, sent.length),
        metadata: {
          tool: "studiorpc_game_input_inject",
          clientId: target.clientId,
          eventCount: sent.length,
          status: result?.status,
        },
      };
    },
  };
}
export function expectedLookResult(error: unknown, sent: InputEvent[]): InjectResult | undefined {
  if (!(error instanceof StudioRpcError) || error.code !== -32108) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object") return undefined;
  const typedData = data as { looks?: InjectResult["looks"]; failedEventIndex?: number };
  const looks = typedData.looks;
  if (!Array.isArray(looks) || looks.length === 0) return undefined;
  const last = looks[looks.length - 1]?.status;
  if (last !== "blocked" && last !== "timedOut") return undefined;
  const lookIndices = sent.flatMap((event, index) => (event.type === "look" ? [index] : []));
  const inferredFailedIndex = lookIndices[looks.length - 1];
  const failedEventIndex =
    typeof typedData.failedEventIndex === "number" ? typedData.failedEventIndex : inferredFailedIndex;
  if (failedEventIndex === undefined) return undefined;
  return {
    ...(data as Record<string, unknown>),
    status: last,
    failedEventIndex,
    cancelledEventCount: Math.max(0, sent.length - failedEventIndex - 1),
  };
}
async function pollMoveStatus(
  callRpc: CallRpc,
  pieSessionId: string,
  requestId: string,
  timeoutMs: number,
  clientId?: string,
): Promise<{
  status: string | undefined;
  waitedMs: number;
  timedOut: boolean;
  track: TrackSample[];
  diagnostics?: Record<string, unknown>;
}> {
  const startedAt = Date.now();
  let status: string | undefined;
  let lastTrackedPosition: { x: number; y: number; z: number } | undefined;
  let diagnostics: Record<string, unknown> | undefined;
  const track: TrackSample[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(MOVE_POLL_INTERVAL_MS);
    const result = (await callRpc(
      "game.character.moveStatus",
      { pieSessionId, requestId },
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as MoveStatusResult;
    status = result?.status;
    diagnostics = result?.diagnostics;
    if (isTerminalMoveStatus(status)) {
      return {
        status,
        waitedMs: Date.now() - startedAt,
        timedOut: false,
        track,
        ...(diagnostics ? { diagnostics } : {}),
      };
    }

    const position = await readCharacterPosition(callRpc, { pieSessionId, clientId });
    if (position) {
      if (lastTrackedPosition === undefined || distanceBetween(position, lastTrackedPosition) > MOVED_AT_ALL) {
        track.push({ ...position, atMs: Date.now() });
        lastTrackedPosition = position;
      }
    }
  }

  return {
    status,
    waitedMs: Date.now() - startedAt,
    timedOut: true,
    track,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

const moveToDescription = [
  "Navigate the play-test character to one live instance or world position, or through a target array in order, " +
    "and wait for measured results. A route stops at its first failed waypoint and reports completedWaypoints, " +
    "failedWaypointIndex, and a compact result for every attempted leg. timeoutMs is one budget for the whole route. ",
  "Movement uses pathMode navigation by default: an Unreal navmesh route around grounded walkable obstacles. " +
    "Use teleport only to arrange test state. navigation does not jump, use " +
    "elevators, press controls, or bypass scripts that constrain character movement. ",
  "Read `outcome`: arrived, interrupted, navigationGaveUp, stoppedShort, or timedOut. interrupted means " +
    "the reached position did not remain stable through Studio's confirmation window. navigationGaveUp says only that " +
    "Studio ended navigation short; it does not prove collision or an unreachable level. `rpcStatus` and " +
    "`rpcDiagnostics` preserve Studio's authoritative result; sampled position adds observations but never rewrites " +
    "that result. The sidecar does not infer failure from sampled position, reissue a completed move, or cancel " +
    "Studio navigation. timeoutMs limits how long the tool waits; routeStillRunning reports navigation that remains " +
    "active when that wait expires. ",
  "For an {x, y, z} target, arrivedWithin optionally sets the Studio-owned terminal acceptance radius from 0 to " +
    "1000. Navigation still approaches the requested point; entering this radius does not stop it early. " +
    "arrivalReason names the successful rule. withinRadius compares distanceToTarget with arrivedWithin (" +
    TOUCH_MARGIN +
    " to a named target surface, " +
    ARRIVAL_TOLERANCE +
    " to a bare position). Use the named target, not a nearby bare coordinate, when interaction reach matters. " +
    "standingOnTarget and atopTarget account for the character origin being about " +
    "84 units above its feet. ",
  "endedAt, standingOn, characterTrack, and measuredSpeed describe the final position and route. " +
    "navigation reports observed terminal state and progress facts without guessing at collision or navmesh causes. " +
    "didNotSetOff means a failed request started and ended at the same place. Use characterTrack before inferring " +
    "that no movement occurred.",
].join("");

function createCharacterMoveToTool(callRpc: CallRpc): Tool {
  const tool: Tool = {
    name: "studiorpc_game_character_move_to",
    description: moveToDescription,
    parameters: moveToParams,
    async execute(args: MoveToParams, ctx): Promise<ToolResult> {
      if (Array.isArray(args.target)) {
        const routeTarget = await resolvePieTarget(withSignal(callRpc, ctx.signal), args);
        const routeStartedAt = Date.now();
        const routeTimeoutMs = args.timeoutMs ?? MOVE_WAIT_DEFAULT_MS;
        const deadlineAt = routeStartedAt + routeTimeoutMs;
        const waypointCount = args.target.length;
        const waypoints: Array<Record<string, unknown>> = [];
        const requestIds: string[] = [];
        let completedWaypoints = 0;

        const finishRoute = (outcome: string, failedWaypointIndex?: number): ToolResult => {
          const waitedMs = Date.now() - routeStartedAt;
          const last = waypoints[waypoints.length - 1];
          const rpcStatus = typeof last?.rpcStatus === "string" ? last.rpcStatus : undefined;
          const status =
            rpcStatus ??
            (outcome === "arrived" ||
            outcome === "navigationGaveUp" ||
            outcome === "stoppedShort" ||
            outcome === "timedOut" ||
            outcome === "interrupted"
              ? normalizeWaitedMoveStatus(outcome)
              : outcome);
          return {
            output: jsonOutput({
              outcome,
              pathMode: args.pathMode ?? "navigation",
              completedWaypoints,
              waypointCount,
              ...(failedWaypointIndex === undefined ? {} : { failedWaypointIndex }),
              waypoints,
              ...(last?.endedAt === undefined ? {} : { endedAt: last.endedAt }),
              ...(last?.at === undefined ? {} : { at: last.at }),
              ...(last?.standingOn === undefined ? {} : { standingOn: last.standingOn }),
              ...(last?.navigation === undefined ? {} : { navigation: last.navigation }),
              ...(last?.interruption === undefined ? {} : { interruption: last.interruption }),
              ...(last?.rpcStatus === undefined ? {} : { rpcStatus: last.rpcStatus }),
              ...(last?.rpcDiagnostics === undefined ? {} : { rpcDiagnostics: last.rpcDiagnostics }),
              clientId: routeTarget.clientId,
            }),
            render: buildMoveRouteRender(routeTarget, waypointCount, completedWaypoints, outcome, waitedMs),
            metadata: {
              tool: "studiorpc_game_character_move_to",
              clientId: routeTarget.clientId,
              requestIds,
              status,
              waitedMs,
              completedWaypoints,
              waypointCount,
              ...(failedWaypointIndex === undefined ? {} : { failedWaypointIndex }),
            },
          };
        };

        for (let index = 0; index < args.target.length; index++) {
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs < 1_000) return finishRoute("timedOut", index);
          const requested = args.target[index] as MoveDestination;
          try {
            const leg = await tool.execute(
              {
                ...args,
                target: requested,
                pieSessionId: routeTarget.pieSessionId,
                clientId: routeTarget.clientId,
                timeoutMs: Math.max(1_000, Math.floor(remainingMs)),
              } as never,
              ctx,
            );
            const payload = JSON.parse(leg.output) as Record<string, unknown>;
            const report: Record<string, unknown> = {
              index,
              requested,
              outcome: payload.outcome ?? "unknown",
            };
            for (const field of [
              "arrived",
              "arrivalReason",
              "target",
              "endedAt",
              "at",
              "distanceToTarget",
              "arrivedWithin",
              "standingOn",
              "standingOnTarget",
              "alreadyAtTarget",
              "didNotSetOff",
              "routeStillRunning",
              "navigation",
              "interruption",
              "pathMode",
              "rpcStatus",
              "rpcDiagnostics",
            ]) {
              if (payload[field] !== undefined) report[field] = payload[field];
            }
            const requestId = typeof leg.metadata?.requestId === "string" ? leg.metadata.requestId : undefined;
            if (requestId) {
              report.requestId = requestId;
              requestIds.push(requestId);
            }
            waypoints.push(report);
            if (payload.outcome !== "arrived") {
              return finishRoute(typeof payload.outcome === "string" ? payload.outcome : "routeFailed", index);
            }
            completedWaypoints += 1;
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            waypoints.push({
              index,
              requested,
              outcome: "routeFailed",
              error: error instanceof Error ? error.message : String(error),
            });
            return finishRoute("routeFailed", index);
          }
        }
        return finishRoute("arrived");
      }

      const toolCallRpc = withSignal(callRpc, ctx.signal);
      const target = await resolvePieTarget(toolCallRpc, args);
      const wantedTarget = typeof args.target === "string" ? stripWorkspacePrefix(args.target) : undefined;
      const looksLikePath = wantedTarget?.includes(".") ?? false;
      let found = wantedTarget
        ? await readLiveInstance(toolCallRpc, looksLikePath ? { path: wantedTarget } : { name: wantedTarget })
        : undefined;
      if (wantedTarget && !found && looksLikePath) {
        found = await readLiveInstance(toolCallRpc, { name: wantedTarget });
      }
      if (wantedTarget && !found) {
        throw new Error(
          `Nothing in the running Workspace is called "${wantedTarget}"` +
            (looksLikePath ? ", as a path or as a name" : "") +
            `, so there is nowhere to walk to. ` +
            (await nearbyNamesSentence(toolCallRpc, wantedTarget)),
        );
      }
      if (found && "positionless" in found) {
        throw new Error(
          `${wantedTarget} is a ${found.class ?? "Model"}${found.path ? ` at ${found.path}` : ""}, which holds ` +
            `things that have positions without having one itself, so there is nowhere to walk to. Walk to a ` +
            `Part inside it — studiorpc_game_observe with instances under: "${found.path ?? wantedTarget}" lists ` +
            `what is in there — or pass an {x, y, z}.`,
        );
      }
      const named = found;
      const wantedPosition = named?.position ?? (typeof args.target === "string" ? undefined : args.target);
      if (!wantedPosition) throw new Error("Pass a name or an {x, y, z} to say where to walk.");
      const startedFrom = await readCharacterPosition(toolCallRpc, target);
      const startedAtMs = Date.now();
      const measureTo = (from: { x: number; y: number; z: number }) =>
        named?.half ? distanceToSurface(from, named.position, named.half) : distanceBetween(from, wantedPosition);
      const startedNearTarget =
        wantedTarget !== undefined && startedFrom !== undefined && measureTo(startedFrom) <= ALREADY_AT_RADIUS;
      const destination = wantedPosition;
      const pathMode = args.pathMode ?? "navigation";
      const tolerance = named?.half ? TOUCH_MARGIN : (args.arrivedWithin ?? ARRIVAL_TOLERANCE);
      const started = (await toolCallRpc(
        "game.character.moveTo",
        {
          pieSessionId: target.pieSessionId,
          clientId: target.clientId,
          position: destination,
          pathMode,
          acceptanceRadius: tolerance,
          ...(named?.half ? { targetHalfExtents: named.half } : {}),
        },
        { timeoutMs: MOVE_RPC_TIMEOUT_MS },
      )) as MoveToResult;
      if (pathMode === "teleport") {
        const landedState = await readCharacterState(toolCallRpc, target);
        const landed = started?.landedAt ?? landedState?.position;
        return {
          output: jsonOutput({
            outcome: "teleported",
            pathMode,
            rpcStatus: started?.status,
            teleported: started?.teleported === true,
            ...(named?.path ? { target: named.path } : {}),
            landedAt: landed,
            standingOn: landedState?.standingOnName ?? null,
            clientId: target.clientId,
          }),
          render: buildMoveToRender(target, wantedPosition, started?.requestId ?? "", "teleported", undefined),
          metadata: {
            tool: "studiorpc_game_character_move_to",
            clientId: target.clientId,
            requestId: started?.requestId ?? "",
            status: "teleported",
          },
        };
      }

      const requestId = started?.requestId ?? "";
      if (!requestId) {
        return {
          output: jsonOutput({ ...started, clientId: target.clientId }),
          render: buildMoveToRender(target, wantedPosition, requestId, started?.status, undefined),
          metadata: {
            tool: "studiorpc_game_character_move_to",
            clientId: target.clientId,
            requestId,
            status: started?.status,
          },
        };
      }

      const timeoutMs = args.timeoutMs ?? MOVE_WAIT_DEFAULT_MS;
      const deadlineAtMs = Date.now() + timeoutMs;
      const polled = await pollMoveStatus(
        toolCallRpc,
        target.pieSessionId,
        requestId,
        Math.max(1_000, deadlineAtMs - Date.now()),
        target.clientId,
      );
      const walkedTrack: TrackSample[] = polled.track;
      const endedState = await readCharacterState(toolCallRpc, target);
      const status = polled.status ?? started?.status;
      const endedAt = endedState?.position;
      const endedAtMs = Date.now();
      const targetLeaf = (
        named?.path ?? (typeof args.target === "string" ? stripWorkspacePrefix(args.target) : undefined)
      )
        ?.split(".")
        .pop();
      const standingOnTarget = targetLeaf !== undefined && endedState?.standingOnName === targetLeaf;
      const rpcDistanceToTarget = polled.diagnostics?.distanceToTargetRegion;
      const distanceToTarget =
        typeof rpcDistanceToTarget === "number" ? rpcDistanceToTarget : endedAt ? measureTo(endedAt) : undefined;
      const feetAboveTargetTop = named?.half && endedAt ? endedAt.y - (named.position.y + named.half.y) : undefined;
      const horizontalToTarget =
        named?.half && endedAt ? distanceToSurface(endedAt, named.position, named.half, true) : undefined;
      const atopTarget =
        horizontalToTarget !== undefined &&
        horizontalToTarget <= TOUCH_MARGIN &&
        feetAboveTargetTop !== undefined &&
        feetAboveTargetTop >= 0 &&
        feetAboveTargetTop <= CHARACTER_ORIGIN_ABOVE_FEET + TOUCH_MARGIN;
      const route: TrackSample[] | undefined =
        startedFrom && endedAt
          ? [{ ...startedFrom, atMs: startedAtMs }, ...walkedTrack, { ...endedAt, atMs: endedAtMs }]
          : undefined;
      const knownFalling = endedState?.falling === true;
      const interrupted = status === "interrupted";
      const observedArrivalReason: ArrivalReason | undefined = standingOnTarget
        ? "standingOnTarget"
        : atopTarget
          ? "atopTarget"
          : !knownFalling && distanceToTarget !== undefined && distanceToTarget <= tolerance
            ? "withinRadius"
            : undefined;
      const movedDistance = startedFrom && endedAt ? distanceBetween(startedFrom, endedAt) : undefined;
      const moved = movedDistance !== undefined && movedDistance > MOVED_AT_ALL;
      const track = compactRoute(route, startedAtMs);
      const settled = isTerminalMoveStatus(status);
      const ended = settled;
      const completed = settled;
      const arrived = completed && !interrupted && status === "reached";
      const arrivalReason: ArrivalReason | undefined = !arrived ? undefined : observedArrivalReason;
      const didNotSetOff = completed && !moved && !arrived;
      const gaveUp = completed && !arrived;
      const outcome: MoveOutcome = polled.timedOut
        ? "timedOut"
        : interrupted
          ? "interrupted"
          : status === "reached"
            ? "arrived"
            : status === "timedOut"
              ? "timedOut"
              : gaveUp
                ? "navigationGaveUp"
                : "stoppedShort";
      const navStatus = normalizeWaitedMoveStatus(outcome);
      const roundedDistance = distanceToTarget === undefined ? undefined : Math.round(distanceToTarget * 10) / 10;
      const engineDiagnostics = polled.diagnostics;
      const navigation =
        outcome === "navigationGaveUp" || outcome === "stoppedShort" || outcome === "interrupted"
          ? {
              ...(isTerminalMoveStatus(status)
                ? { terminalStatus: status }
                : { lastObservedStatus: status ?? "unknown" }),
              stoppedMoving: isTerminalMoveStatus(status),
              ...(roundedDistance === undefined ? {} : { remainingDistance: roundedDistance }),
              ...(engineDiagnostics ? { engine: engineDiagnostics } : {}),
            }
          : undefined;
      const interruption = interrupted ? (polled.diagnostics ?? { kind: "moveInterrupted" }) : undefined;
      const measuredSpeed = (() => {
        if (!track || track.length < 2) return undefined;
        let walked = 0;
        for (let index = 1; index < track.length; index++) {
          walked += Math.hypot(
            track[index].x - track[index - 1].x,
            track[index].y - track[index - 1].y,
            track[index].z - track[index - 1].z,
          );
        }
        const seconds = (track[track.length - 1].ms - track[0].ms) / 1_000;
        return seconds > 0.5 ? Math.round(walked / seconds) : undefined;
      })();

      return {
        output: jsonOutput({
          outcome,
          pathMode,
          rpcStatus: status,
          ...(engineDiagnostics ? { rpcDiagnostics: engineDiagnostics } : {}),
          ...(completed && !interrupted ? { arrived } : {}),
          ...(arrivalReason ? { arrivalReason } : {}),
          ...(navigation ? { navigation } : {}),
          ...(interruption ? { interruption } : {}),
          ...(polled.timedOut && !settled ? { routeStillRunning: true } : {}),
          ...(named?.path ? { target: named.path } : {}),
          ...(named?.matches !== undefined && named.matches > 1
            ? { targetMatches: named.matches, targetOtherPaths: named.otherPaths ?? [] }
            : {}),
          ...(standingOnTarget ? { standingOnTarget: args.target } : {}),
          ...(startedNearTarget && args.target ? { alreadyAtTarget: args.target } : {}),
          ...(endedAt
            ? {
                [ended ? "endedAt" : "at"]: endedAt,
                distanceToTarget: roundedDistance,
                arrivedWithin: tolerance,
              }
            : {}),
          ...(ended && endedState !== undefined ? { standingOn: endedState.standingOnName ?? null } : {}),
          ...(didNotSetOff ? { didNotSetOff: true } : {}),
          ...(track && track.length > 1 ? { characterTrack: track } : {}),
          ...(measuredSpeed !== undefined ? { measuredSpeed } : {}),
          clientId: target.clientId,
        }),
        render: buildMoveToRender(target, wantedPosition, requestId, navStatus, polled.waitedMs),
        metadata: {
          tool: "studiorpc_game_character_move_to",
          clientId: target.clientId,
          requestId,
          status: status ?? navStatus,
          waitedMs: polled.waitedMs,
        },
      };
    },
  };
  return tool;
}
export function createPieInputTools(callRpc: CallRpc = call): Tool[] {
  return [createPieStatusTool(callRpc), createInputInjectTool(callRpc), createCharacterMoveToTool(callRpc)];
}

export type { PieTarget };
