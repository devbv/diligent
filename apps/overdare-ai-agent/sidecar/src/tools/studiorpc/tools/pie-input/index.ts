// @summary Agent-facing play-test tools: PIE status, input injection, and character moveTo.

import { z } from "zod";
import { rankNames } from "../../methods/game.instance.read";
import { call } from "../../rpc";
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
  buildMoveStatusRender,
  buildMoveToRender,
  buildPieStatusRender,
  describeEvents,
  isTerminalMoveStatus,
} from "./render";
import { type CallRpc, PIE_STATUS_TIMEOUT_MS, type PieTarget, readPieStatus, resolvePieTarget } from "./target";

/** Studio answers an inject only once the batch has played out, so the RPC waits for it. */
const INJECT_OVERHEAD_MS = 15_000;
const MOVE_RPC_TIMEOUT_MS = 10_000;
const MOVE_POLL_INTERVAL_MS = 300;
const MOVE_WAIT_DEFAULT_MS = 30_000;
const MOVE_WAIT_MAX_MS = 300_000;
/** How close counts as arrived when checking Studio's `reached` against the real position. */
const ARRIVAL_TOLERANCE = 150;
/** Below this the character has not travelled — it is jitter, not a move. */
const MOVED_AT_ALL = 5;
/** Enough near-miss names to recognise the one that was meant, short of quoting the listing. */
const MOVE_NAME_SUGGESTIONS = 8;
/** Navigation stops itself about this far out, and will not re-approach from inside it. */
const NAV_STOP_DISTANCE = 50;
/** Still for this long while navigation claims to be running means it is stuck, not slow. */
const MOVE_STALL_MS = 3_000;
/** The Studio time-scale endpoint clamps values to this minimum. */
const MIN_GAME_TIME_SCALE = 0.05;
/** How far past a point passThrough aims, so the walk crosses it rather than ending on it. */
const PASS_THROUGH_OVERSHOOT = 200;
/** The furthest a caller may aim past a target, well beyond any sensible crossing. */
const PASS_THROUGH_OVERSHOOT_MAX = 1_000;
/** Close enough to a named target's surface to count as having reached it. */
const TOUCH_MARGIN = 60;
/** A named target whose surface is this close to the character's origin is inside it. */
const ALREADY_AT_RADIUS = 30;
/** Below this a gap between samples is ordinary movement, however fast it looked. */
const TELEPORT_JUMP = 300;
/** Units per real second no walking character reaches, so beyond it something moved it. */
const TELEPORT_SPEED = 2_000;

const targetOverrides = {
  pieSessionId: z
    .string()
    .optional()
    .describe("Session to target. Omit to use the live session reported by game.pie.status."),
  clientId: z.string().optional().describe("PIE client to target. Omit to use the first injectable client."),
};

const injectParams = z.object({
  // Preprocessed so a pointer event written with flat x/y still validates; see
  // normalizeEventShapes for why that spelling keeps being tried.
  events: z.preprocess(normalizeEventShapes, inputEventsSchema),
  ...targetOverrides,
});

const moveToParams = z
  .object({
    targetName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Runtime name of an instance to walk to, instead of a position — the tool reads where it actually is " +
          "and how big it is. Prefer this over typing coordinates: a made-up height aims at a point above the " +
          "thing, and every distance the reply gives you is then measured from a place nothing is. Naming it " +
          "also changes what the distances mean: they are measured to the instance's surface rather than its " +
          `centre, so they say how far the character is from touching it, and arrivalTolerance defaults to ` +
          `${TOUCH_MARGIN}. Centre distances are useless for anything large — half of a wide gate is a long ` +
          "way, and measuring to it calls a character arrived while it stands well clear of the thing.",
      ),
    position: z
      .object({ x: z.number(), y: z.number(), z: z.number() })
      .optional()
      .describe(
        "Destination in the same world coordinates as studiorpc_instance_read and " +
          "studiorpc_game_character_read, so a position read from either can be passed straight in. " +
          "Aim at ground level: the character walks, so the height of an object's centre is somewhere it can " +
          "never stand, and asking for it just times out. Take the object's x and z and the character's own " +
          "current y.",
      ),
    arrivalTolerance: z
      .number()
      .min(1)
      .optional()
      .describe(
        `How close, in world units, counts as arrived. With a named target this is a distance to its ` +
          `surface and defaults to ${TOUCH_MARGIN}; with a bare position it is a distance to the point and ` +
          `defaults to ${ARRIVAL_TOLERANCE}, which suits travelling somewhere rather than reaching something. ` +
          "Rarely worth setting by hand now that a named target measures from the thing itself.",
      ),
    passThrough: z
      .boolean()
      .optional()
      .describe(
        "Walk through the position rather than up to it. Navigation stops short of wherever it is sent, so a " +
          "move aimed at a trigger volume stops beside it without setting it off; this aims far enough past the " +
          `point — ${PASS_THROUGH_OVERSHOOT} units past it — along the line the character is already ` +
          "approaching on, so the path crosses it. Use it whenever the point of the move is to touch " +
          "something rather than to arrive somewhere. Because it aims well beyond the target, a blocked " +
          "result can be something in the way of that further point rather than of the thing you cared " +
          "about; `aimedAt` says where it was actually sent. " +
          "The reply then reports `passedWithin` — how near the walk came, at its closest, to the position you " +
          "asked for rather than to the point it was aimed at. For a named target that is the distance to its " +
          "surface, so a path straight over a coin reads near zero; for a bare position it is the distance to " +
          "the point in three dimensions, which a target at a different height can never drive to zero. " +
          "`crossed` is the answer to what you asked. For a named target it means the walk went inside the " +
          "thing — passedWithin 0 — so a gate that never opens reports false however closely the character " +
          "pressed against its face, and walking around the side of one does not count either. For a bare " +
          "position, which has no shape to enter, it falls back to near-and-beyond and reports `wentPast` " +
          "alongside; prefer naming the target. distanceToTarget is left out of a pass-through reply, " +
          "since it would measure back to a target the move was meant to overshoot. " +
          "The aim point is past the target, so a target near a ledge aims the character off it: five " +
          "consecutive pickups beside a roof edge ended in the character walking over the side. Approach " +
          "from the outside in, or shorten the overshoot with passThroughBeyond.",
      ),
    passThroughBeyond: z
      .number()
      .min(1)
      .max(PASS_THROUGH_OVERSHOOT_MAX)
      .optional()
      .describe(
        `How far past the target passThrough aims, in world units. Defaults to ${PASS_THROUGH_OVERSHOOT}. ` +
          "Shorten it when the ground runs out just beyond the target — a ledge, a gap, a pit — since the " +
          "character is being sent to that further point and will walk off. It still has to clear the " +
          "target's own far face to count as a crossing, so a few tens of units is the useful floor.",
      ),
    wait: z.boolean().optional().describe("Poll game.character.moveStatus until the move ends. Defaults to true."),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(MOVE_WAIT_MAX_MS)
      .optional()
      .describe(`How long to poll when wait is true. Defaults to ${MOVE_WAIT_DEFAULT_MS}ms.`),
    ...targetOverrides,
  })
  .refine((value) => value.position !== undefined || value.targetName !== undefined, {
    message: "Pass either position or targetName to say where to walk.",
  });

const moveStatusParams = z.object({
  requestId: z.string().describe("requestId returned by studiorpc_game_character_move_to."),
  pieSessionId: z.string().optional().describe("Session the request belongs to. Omit for the live session."),
});

type InjectParams = z.infer<typeof injectParams>;
type MoveToParams = z.infer<typeof moveToParams>;
type MoveStatusParams = z.infer<typeof moveStatusParams>;

interface InjectResult {
  sequenceId?: string;
  status?: string;
  appliedEventCount?: number;
  released?: boolean;
  /** Pointer route diagnostics emitted by Studio; handled is Slate routing, not proof of game activation. */
  pointerRouteCount?: number;
  pointerHandledCount?: number;
  pointerRouteRepaired?: boolean;
  pointerCaptureRepaired?: boolean;
  pointerLeafType?: string;
  /** One entry per look event: how far the view actually turned, and why it stopped. */
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
}

interface MoveStatusResult {
  requestId?: string;
  status?: string;
  clientId?: string;
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
}

interface GameTimeScaleReadResult {
  timeScale?: number;
}

type MoveOutcome = "arrived" | "blocked" | "stoppedShort" | "stillMoving";

/**
 * A waited move combines terminal polling, stall detection, and the measured
 * end position. Its public status should follow that stronger verdict; the
 * last raw path-following word is retained separately when they differ.
 */
export function normalizeWaitedMoveStatus(outcome: MoveOutcome, rawStatus: string | undefined): string | undefined {
  switch (outcome) {
    case "arrived":
      return "reached";
    case "blocked":
      return "blocked";
    case "stoppedShort":
      return "stoppedShort";
    case "stillMoving":
      return rawStatus ?? "running";
  }
}

/**
 * MOVE_STALL_MS is a game-time observation window. A slowed world needs more
 * wall-clock time to receive the same amount of movement simulation. Speeding
 * the world up does not shorten the existing safety window.
 */
export function moveStallWindowMs(timeScale: number | undefined): number {
  if (timeScale === undefined || !Number.isFinite(timeScale) || timeScale <= 0) return MOVE_STALL_MS;
  const boundedScale = Math.max(timeScale, MIN_GAME_TIME_SCALE);
  return Math.round(MOVE_STALL_MS / Math.min(boundedScale, 1));
}

/**
 * Where the character actually is, or undefined if it cannot be read. Studio
 * reports `reached` whenever path following returns success, which a level with
 * no navigation data can do without the character having gone anywhere — so the
 * move tools quote the distance that is left rather than the claim alone.
 */
async function readCharacterState(callRpc: CallRpc): Promise<CharacterState | undefined> {
  try {
    const result = (await callRpc(
      "game.character.read",
      {},
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as CharacterReadResult;
    const position = result?.character?.CFrame?.Position;
    if (typeof position?.X !== "number" || typeof position?.Y !== "number" || typeof position?.Z !== "number") {
      return undefined;
    }
    return {
      position: { x: position.X, y: position.Y, z: position.Z },
      standingOnName: result?.character?.standingOn?.instanceName,
    };
  } catch {
    return undefined;
  }
}

async function readCharacterPosition(callRpc: CallRpc): Promise<{ x: number; y: number; z: number } | undefined> {
  return (await readCharacterState(callRpc))?.position;
}

function distanceBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

interface LiveInstance {
  instance?: {
    CFrame?: { Position?: { X?: number; Y?: number; Z?: number } };
    Size?: { X?: number; Y?: number; Z?: number };
  };
}

/**
 * Where an instance actually is and how far it reaches, so a caller can name the
 * thing rather than type coordinates at it. Typed coordinates are where the
 * position errors come from: an invented height aims above the target, and every
 * distance in the reply is then measured from a place nothing occupies.
 */
async function readLiveInstance(
  callRpc: CallRpc,
  name: string,
): Promise<{ position: { x: number; y: number; z: number }; half?: { x: number; y: number; z: number } } | undefined> {
  // A name that is not there is this tool's own answer to give, not the transport's.
  // Studio raises `instanceNotFound` and the raw error surfaced straight through, so
  // the caller was told the name is absent and nothing about what to walk to instead
  // — while asking studiorpc_game_instance_read the same question answered with a
  // ranked list. Swallow it here so the throw below can say the useful thing.
  let result: LiveInstance;
  try {
    result = (await callRpc("game.instance.read", { name }, { timeoutMs: MOVE_RPC_TIMEOUT_MS })) as LiveInstance;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("is in the running Workspace")) return undefined;
    throw error;
  }
  const position = result?.instance?.CFrame?.Position;
  if (typeof position?.X !== "number" || typeof position?.Y !== "number" || typeof position?.Z !== "number") {
    return undefined;
  }
  const size = result?.instance?.Size;
  return {
    position: { x: position.X, y: position.Y, z: position.Z },
    half: size ? { x: (size.X ?? 0) / 2, y: (size.Y ?? 0) / 2, z: (size.Z ?? 0) / 2 } : undefined,
  };
}

/**
 * What to say after "that name is not there". A bare instruction to go list the
 * world costs the caller another round trip to learn something this call already
 * had to look at, and the name it wanted is usually a near miss — the running
 * game's names come from whatever script made the instance, so they need not match
 * the level's spelling. Ranked nearest first, and silent rather than wrong if the
 * listing itself fails: the absence is still the answer without it.
 */
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
    return "Call studiorpc_game_instance_read with no arguments to see what is there.";
  }
  if (names.length === 0) return "Call studiorpc_game_instance_read with no arguments to see what is there.";
  const nearest = rankNames(names, wanted).slice(0, MOVE_NAME_SUGGESTIONS);
  if (nearest.length > 0) {
    return `Nearest names in the running world: ${nearest.join(", ")}.`;
  }
  return `The running world has ${names.length} named instances, none resembling that one: ${names.slice(0, MOVE_NAME_SUGGESTIONS).join(", ")}.`;
}

/**
 * Distance to the nearest point on a box, rather than to its middle. Measuring to
 * the centre makes every distance about the target's size: a wide gate reads as
 * reached from two hundred units away because half its width is two hundred, and a
 * coin floating overhead never reads zero however exactly you walk under it. The
 * surface is the thing a character can touch, so it is the thing worth measuring.
 */
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

/**
 * How near the walk from `from` to `to` came to `point` at its closest, rather than
 * how near it ended. A pass-through deliberately finishes beyond its target, so where
 * it stopped says nothing about whether it went over the thing.
 */
function closestApproach(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  point: { x: number; y: number; z: number },
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) return distanceBetween(from, point);
  const along = ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, along));
  return distanceBetween({ x: from.x + dx * clamped, y: from.y + dy * clamped, z: from.z + dz * clamped }, point);
}

/**
 * Whether the walk finished on the far side of `target` from where it started,
 * measured along the approach line. Being near something and having got past it are
 * different claims, and only the second one means a solid thing let you through.
 */
function travelledBeyond(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): boolean {
  const ax = target.x - from.x;
  const az = target.z - from.z;
  const length = Math.hypot(ax, az);
  if (length < 1) return false;
  // How far along the approach direction each point sits, with the target at zero.
  const along = ((to.x - from.x) * ax + (to.z - from.z) * az) / length;
  return along > length;
}

/**
 * How near a walk came to a box at its closest, sampling each leg of the route the
 * character actually took. The route matters: navigation goes around obstacles, so a
 * straight line from start to finish can pass clean through something the character
 * gave a wide berth, and taking that line for the walk reported crossings that never
 * happened. Exact segment-to-box distance is fiddly and this is a proximity report,
 * not a physics query, so sampling is both honest and hard to get subtly wrong.
 */
function closestApproachToSurface(
  route: Array<{ x: number; y: number; z: number }>,
  centre: { x: number; y: number; z: number },
  half: { x: number; y: number; z: number },
  ignoreVertical = false,
): number {
  const perLeg = 24;
  // A single point is a leg with nothing to walk along, which the loop below skips
  // entirely and reports as infinitely far. Splitting a route at a teleport can leave
  // one, so measure the point itself rather than answering with a number that is not one.
  if (route.length === 1) return distanceToSurface(route[0], centre, half, ignoreVertical);
  let nearest = Number.POSITIVE_INFINITY;
  for (let leg = 0; leg < route.length - 1; leg++) {
    const from = route[leg];
    const to = route[leg + 1];
    for (let step = 0; step <= perLeg; step++) {
      const t = step / perLeg;
      const point = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
      };
      nearest = Math.min(nearest, distanceToSurface(point, centre, half, ignoreVertical));
    }
  }
  return nearest;
}

/** The same, for a bare point that has no shape to measure a surface against. */
function closestApproachOnRoute(
  route: Array<{ x: number; y: number; z: number }>,
  point: { x: number; y: number; z: number },
): number {
  if (route.length === 1) return distanceBetween(route[0], point);
  let nearest = Number.POSITIVE_INFINITY;
  for (let leg = 0; leg < route.length - 1; leg++) {
    nearest = Math.min(nearest, closestApproach(route[leg], route[leg + 1], point));
  }
  return nearest;
}

/** A place the character was seen and when, so a jump can be told apart from a walk. */
type TrackSample = { x: number; y: number; z: number; atMs: number };

/**
 * The stretches the character actually walked, split wherever it was moved instead.
 * Falling into a gap ends with the game putting the character back at its spawn and
 * navigation re-walking the whole route without saying so: run 47 read `arrived` for
 * a crossing that had failed, fallen, respawned and been retried, and spent several
 * calls deciding the chute was broken. Two samples are a teleport only when the gap
 * between them is both large and faster than anything on foot, so ordinary running —
 * or a slow poll that missed a few hundred units of it — stays one leg.
 *
 * The split is not only for the report. Joining the two sides draws a straight line
 * across the level that nobody walked, and closest-approach reads it as a crossing of
 * whatever happens to lie under it.
 */
function splitWalkedLegs(route: TrackSample[]): { legs: TrackSample[][]; teleports: number } {
  const legs: TrackSample[][] = [];
  let current: TrackSample[] = [];
  let teleports = 0;
  for (const [index, sample] of route.entries()) {
    const previous = index > 0 ? route[index - 1] : undefined;
    if (previous) {
      const distance = distanceBetween(previous, sample);
      const seconds = Math.max(sample.atMs - previous.atMs, 1) / 1_000;
      if (distance >= TELEPORT_JUMP && distance / seconds >= TELEPORT_SPEED) {
        teleports += 1;
        legs.push(current);
        current = [];
      }
    }
    current.push(sample);
  }
  legs.push(current);
  return { legs, teleports };
}

/** How far the character covered on foot, which a straight start-to-end line understates. */
function walkedLength(legs: TrackSample[][]): number {
  let total = 0;
  for (const leg of legs) {
    for (let step = 0; step < leg.length - 1; step++) total += distanceBetween(leg[step], leg[step + 1]);
  }
  return total;
}

/**
 * A point the given distance beyond `target`, on the line from `from` through it,
 * so walking there crosses the target instead of stopping at it. Keeps the target's
 * height, since only the ground track is being extended.
 */
function overshootPast(
  from: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  beyond: number,
): { x: number; y: number; z: number } {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const flat = Math.hypot(dx, dz);
  // Standing on the target already: there is no approach line to extend.
  if (flat < 1) return target;
  return { x: target.x + (dx / flat) * beyond, y: target.y, z: target.z + (dz / flat) * beyond };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonOutput(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function createPieStatusTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_pie_status",
    description:
      "Report the OVERDARE Studio play-in-editor (PIE) session: whether play mode runs, its pieSessionId, and " +
      "each client with its netMode and whether input can be injected into it. Call this to check that a " +
      "play test is live; the other play-test tools resolve their target on their own. " +
      "`worlds` reports the server and client separately, which is what catches the two running at different " +
      "speeds: `timeDilation` is the scale that was applied and `measuredScale` is the scale the world was " +
      "observed to actually tick at. `gameTimeSeconds` is each world's own clock — already scaled, so the " +
      "difference between two reads is how much game time passed, whatever the wall clock did. " +
      "studiorpc_game_character_read carries the same clock and is cheaper to ask.",
    parameters: z.object({}),
    supportParallel: true,
    async execute(): Promise<ToolResult> {
      const status = await readPieStatus(callRpc);
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
      "Play a batch of keyboard and mouse events into the running play test, as if a human were at the " +
      "keyboard. The batch is applied in order and the call returns once it has played out, so the character " +
      "has finished moving when the result arrives. pieSessionId and clientId are resolved automatically. " +
      "Limits: at most 64 events, at most 10s of time the batch could spend, and every key or button pressed " +
      "must be released inside the same batch. Everything that can take time counts towards the same 10s: " +
      "wait durations, every press durationMs, and each look's timeoutMs — which is 2000 by default even " +
      "when the turn finishes in milliseconds, so two looks and an 8s wait is over the limit. Two 3s presses " +
      "and a 5s wait is over it too. " +
      "Example — walk forward for half a second: " +
      '[{"type":"key","key":"W","action":"press","durationMs":500}]. ' +
      "To click a UI button, read its rect from studiorpc_game_ui_browse, pointerMove to the center of that " +
      "rect, then press the left pointerButton — that fires the button's Activated exactly as a real click " +
      "does, so never ask the user to press a button you can reach yourself. " +
      "The batch is cancelled with interruptedByUser if the person at the machine takes the play test back " +
      "— a key while it holds focus, or a click inside its viewport. Their typing in another window does " +
      "not count. Retry the batch; the input was released. " +
      "appliedEventCount reports the batch Studio ran, which is the expanded one: each press becomes " +
      "down/wait/up, so it exceeds the number of events you wrote. The reply gives authoredEventCount and " +
      "sentEventCount so the two are never confused. Pointer replies also include pointerRouteCount, " +
      "pointerHandledCount, pointerLeafType, pointerRouteRepaired, and pointerCaptureRepaired for routing " +
      "diagnosis. pointerCaptureRepaired means Studio honored the target widget's own mouse-capture request " +
      "while its native window was inactive; handled means Slate accepted the route, not that game code " +
      "necessarily changed state.",
    parameters: injectParams,
    async execute(args: InjectParams): Promise<ToolResult> {
      // Normalized here as well as in the schema: execute receives the arguments as
      // written, so a preprocess that only runs during validation never reaches this.
      const events = normalizeEventShapes(args.events) as InputEvent[];
      // Studio has no press action, so expand before validating — the limits it
      // enforces apply to what actually reaches it, not to what was authored.
      const { sent, origin } = expandWithOrigin(events);
      if (sent.length > MAX_EVENT_COUNT) {
        throw new Error(
          `The batch expands to ${sent.length} events, above Studio's ${MAX_EVENT_COUNT} limit ` +
            `(each press with a durationMs becomes three). Split the input across several calls.`,
        );
      }
      const batchError = validateBatch(sent, origin);
      if (batchError) throw new Error(batchError);

      const target = await resolvePieTarget(callRpc, args);
      const result = (await callRpc(
        "game.input.inject",
        { pieSessionId: target.pieSessionId, clientId: target.clientId, events: sent },
        { timeoutMs: totalWaitMs(sent) + INJECT_OVERHEAD_MS },
      )) as InjectResult;

      return {
        // appliedEventCount counts what Studio ran, which is the expanded batch — a press
        // becomes down/wait/up. Reporting both stops that looking like a miscount.
        output: jsonOutput({
          ...result,
          clientId: target.clientId,
          authoredEventCount: events.length,
          sentEventCount: sent.length,
          events: describeEvents(events, events.length),
        }),
        render: buildInputInjectRender(target, events, result?.appliedEventCount, sent.length),
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

/**
 * Waits for a move to finish, and gives up early on one that never will.
 *
 * A character walking into a wall keeps `running` until the caller's whole budget
 * is gone, so waiting for a terminal status means the clearest case — genuinely
 * stuck — is the one case that never gets an answer. Watching the position instead
 * settles it in a few seconds: a character that has not moved while navigation
 * still claims to be working is against something.
 */
/**
 * The clock speed the session is running at, so a stall window measured in real
 * seconds still covers the same amount of game time.
 *
 * This used to come from a dedicated game.time.scale read. That call is gone —
 * the scale is now fixed for a session by game.play and reset by game.stop — so
 * the status call, which already reports what each world ended up running at, is
 * the one place left that knows.
 */
async function readGameTimeScale(callRpc: CallRpc): Promise<number | undefined> {
  try {
    const result = (await callRpc(
      "game.pie.status",
      {},
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as GameTimeScaleReadResult;
    const scale = result?.timeScale;
    return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : undefined;
  } catch {
    // Movement remains usable against an older Studio or a transient clock-read
    // failure; the conservative pre-time-scale behavior is the fallback.
    return undefined;
  }
}

async function pollMoveStatus(
  callRpc: CallRpc,
  pieSessionId: string,
  requestId: string,
  timeoutMs: number,
  gameTimeScale: number | undefined,
): Promise<{
  status: string | undefined;
  waitedMs: number;
  timedOut: boolean;
  stalled: boolean;
  gameTimeScale: number | undefined;
  stallWindowMs: number;
  track: TrackSample[];
}> {
  const startedAt = Date.now();
  const stallWindowMs = moveStallWindowMs(gameTimeScale);
  let status: string | undefined;
  let stillSince: number | undefined;
  let stillAnchor: { x: number; y: number; z: number } | undefined;
  let lastTrackedPosition: { x: number; y: number; z: number } | undefined;
  // Where the character actually went. Navigation routes around obstacles, so the
  // straight line between where a move started and ended is not the walk — treating
  // it as one reported crossings of things the character never came near.
  const track: TrackSample[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(MOVE_POLL_INTERVAL_MS);
    const result = (await callRpc(
      "game.character.moveStatus",
      { pieSessionId, requestId },
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as MoveStatusResult;
    status = result?.status;
    if (isTerminalMoveStatus(status)) {
      return {
        status,
        waitedMs: Date.now() - startedAt,
        timedOut: false,
        stalled: false,
        gameTimeScale,
        stallWindowMs,
        track,
      };
    }

    const position = await readCharacterPosition(callRpc);
    if (position) {
      // Compare against the point where the still period began, not only the
      // immediately previous sample. At a low game-time scale every individual
      // 300ms step can be under the jitter threshold even though those steps add
      // up to real travel.
      const madeProgress = stillAnchor !== undefined && distanceBetween(position, stillAnchor) > MOVED_AT_ALL;
      if (stillAnchor === undefined || madeProgress) {
        stillAnchor = position;
        stillSince = Date.now();
      }
      if (lastTrackedPosition === undefined || distanceBetween(position, lastTrackedPosition) > MOVED_AT_ALL) {
        // Stamped, because how fast the character covered the gap is what separates a
        // run from a respawn — the distance alone cannot, since a slow poll and a
        // teleport leave the same hole in the track.
        track.push({ ...position, atMs: Date.now() });
        lastTrackedPosition = position;
      }
      if (stillSince !== undefined && Date.now() - stillSince >= stallWindowMs) {
        return {
          status,
          waitedMs: Date.now() - startedAt,
          timedOut: false,
          stalled: true,
          gameTimeScale,
          stallWindowMs,
          track,
        };
      }
    }
  }

  return {
    status,
    waitedMs: Date.now() - startedAt,
    timedOut: true,
    stalled: false,
    gameTimeScale,
    stallWindowMs,
    track,
  };
}

function createCharacterMoveToTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_character_move_to",
    description:
      "Walk the play-test character to a world position, or to a named instance, using its own navigation " +
      "instead of steering it with key events. Naming the target is the safer form: the tool reads where the " +
      "thing actually is and sizes the tolerance to it, where typed coordinates invite an invented height " +
      "that aims at empty air above it. " +
      "Read `outcome`, which is the tool's own verdict on the move: arrived, blocked, stoppedShort, or " +
      "stillMoving. `navStatus` is the matching stable status: reached, blocked, stoppedShort, or the " +
      "still-active navigation status. When Studio's last path-following word differs, the reply preserves " +
      "it as `rawNavStatus` for diagnosis rather than placing a contradictory raw `running` beside an " +
      "arrived result. Studio reports raw `reached` whenever its path following " +
      "returns success, which it does even when it could not get there, so the tool measures where the " +
      `character actually stopped. \`arrived\` is true within \`arrivalTolerance\` units of the target and ` +
      `appears once the move is over, so a reply without it is one that has not finished. ` +
      `\`arrivalTolerance\` is ${ARRIVAL_TOLERANCE} by default and echoed back in the response; pass a ` +
      "smaller one when you are testing whether the character reached a specific small thing rather than " +
      "merely got there. Finishing on top of the named target counts as arrived whatever the tolerance says, " +
      "reported as `standingOnTarget`: every distance here is measured from the character's origin, which " +
      "rides a capsule half-height above its feet, so anything you stand on is about 84 units away by " +
      "construction and could never satisfy a tolerance. A named target that was already where the character " +
      "stood — one it is carrying, or standing on — reports `alreadyAtTarget` and skips the pass-through " +
      "figures, since there was no approach to measure. " +
      "`distanceToTarget` is how far the character finished from the place you asked for, and `endedAt` is " +
      "where that was; a still-running move reports `at` instead, because it has not ended anywhere yet. " +
      "`moved` and `movedDistance` say whether it travelled at all, which separates a move that was " +
      "unnecessary — already inside the tolerance — from one that went nowhere. `movedDistance` is the " +
      "straight line between the ends, so `walkedDistance` appears alongside it when the route taken was " +
      "meaningfully longer. `endedInAir` says there was nothing under the character's feet when the move " +
      "finished, which is a fall in progress and not an arrival wherever the reply says it stopped. " +
      "`respawnedMidMove` says the character was moved rather than walked partway " +
      "through — it fell or died, the game put it back, and navigation set off again — which endpoints alone " +
      "hide completely; treat anything you were testing along that walk as unproven. `blocked` means the move " +
      "finished without getting there and navigation did not choose to stop: something is in the way, or the " +
      "target is somewhere a walking character cannot stand. A character that walked most of the way and then " +
      "hit a wall is blocked just as much as one that never set off, so read `blocked` with `movedDistance` to " +
      "see where it got stuck. The stall check is three seconds of game time, not blindly three seconds of " +
      "wall time: when the game clock is slowed, `stallWindowMs` expands so normal slow movement is not called " +
      "blocked. `gameTimeScale` reports the scale used when Studio provided it. " +
      "Pass wait: false to return the requestId immediately and poll with " +
      "studiorpc_game_character_move_status yourself.",
    parameters: moveToParams,
    async execute(args: MoveToParams): Promise<ToolResult> {
      const target = await resolvePieTarget(callRpc, args);
      const named = args.targetName ? await readLiveInstance(callRpc, args.targetName) : undefined;
      if (args.targetName && !named) {
        throw new Error(
          `No instance named "${args.targetName}" is in the running Workspace, so there is nowhere to walk to. ` +
            (await nearbyNamesSentence(callRpc, args.targetName)),
        );
      }
      const wantedPosition = named?.position ?? args.position;
      if (!wantedPosition) throw new Error("Pass either position or targetName to say where to walk.");
      // Where it began, so the reply can say whether the character travelled at all.
      // Two moves that end on the same spot look like a no-op otherwise.
      const startedFrom = await readCharacterPosition(callRpc);
      const startedAtMs = Date.now();
      // For a named target these are distances to its surface, which is what a
      // character can actually touch; for a bare position there is no surface to
      // speak of, so it stays the distance to the point itself.
      const measureTo = (from: { x: number; y: number; z: number }) =>
        named?.half ? distanceToSurface(from, named.position, named.half) : distanceBetween(from, wantedPosition);
      // A named target the character is holding rides along with it, so its position
      // reads back as the character's own and there is nowhere to walk. Run 47 asked
      // for the parcel in its hands and got targetPosition equal to its own position,
      // movedDistance 0, and a note claiming the walk had gone directly over it. The
      // test is the target's surface enclosing the character's origin, not mere
      // nearness: a pickup lying at its feet is 84 units below that origin and is
      // something the character genuinely has to walk over.
      const startedNearTarget =
        args.targetName !== undefined && startedFrom !== undefined && measureTo(startedFrom) <= ALREADY_AT_RADIUS;
      // Aiming past the point is what makes the path cross it. Distances stay in the
      // horizontal plane: the overshoot is about where the character walks, and
      // borrowing the target's height would send it at the floor or the ceiling.
      const destination =
        args.passThrough && startedFrom
          ? overshootPast(startedFrom, wantedPosition, args.passThroughBeyond ?? PASS_THROUGH_OVERSHOOT)
          : wantedPosition;
      const started = (await callRpc(
        "game.character.moveTo",
        { pieSessionId: target.pieSessionId, clientId: target.clientId, position: destination },
        { timeoutMs: MOVE_RPC_TIMEOUT_MS },
      )) as MoveToResult;

      const requestId = started?.requestId ?? "";
      const shouldWait = args.wait ?? true;
      if (!shouldWait || !requestId) {
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
      const gameTimeScale = await readGameTimeScale(callRpc);
      const polled = await pollMoveStatus(callRpc, target.pieSessionId, requestId, timeoutMs, gameTimeScale);
      const status = polled.status ?? started?.status;

      // Check the claim rather than repeat it: a level without navigation data can
      // report `reached` with the character still standing where it started.
      const endedState = await readCharacterState(callRpc);
      const endedAt = endedState?.position;
      const endedAtMs = Date.now();
      // Standing on the target is the closest a character can get to it, but the
      // measurement says otherwise: distances are taken from the character's origin,
      // a capsule half-height above its feet, so landing on a plinth reads about 84
      // units of surface distance and `arrived` is unreachable by construction. Run 44
      // was told `blocked` for a plinth it was standing on top of, and went back to
      // re-verify a move that had worked.
      const standingOnTarget = args.targetName !== undefined && endedState?.standingOnName === args.targetName;
      const distanceToTarget = endedAt ? measureTo(endedAt) : undefined;
      const tolerance = args.arrivalTolerance ?? (named?.half ? TOUCH_MARGIN : ARRIVAL_TOLERANCE);
      // A pass-through succeeds by crossing the target, so judge the path, not the
      // stopping place — it is meant to end beyond the thing it was sent over.
      // The route as walked: where it began, every distinct place the poll caught it,
      // and where it finished. Sampled a few times a second, so a fast character can
      // still cut a corner between samples — but it is the walk, not a line drawn
      // between its ends, and that difference reported crossings that never happened.
      const route: TrackSample[] | undefined =
        startedFrom && endedAt
          ? [{ ...startedFrom, atMs: startedAtMs }, ...polled.track, { ...endedAt, atMs: endedAtMs }]
          : undefined;
      // Only the stretches walked on foot. A fall and respawn mid-move otherwise joins
      // two ends of the level with a line the character never travelled, and the
      // crossing test happily reports whatever sits under it.
      const walked = route ? splitWalkedLegs(route) : undefined;
      const nearestOnWalk = (measure: (leg: TrackSample[]) => number): number =>
        Math.min(...(walked?.legs ?? []).map(measure));
      const shape = named?.half ? { centre: named.position, half: named.half } : undefined;
      // A target the character is already on or holding has no approach to judge:
      // every leg starts inside it, so a crossing would be reported for standing still.
      const passedWithin =
        args.passThrough && walked && !startedNearTarget
          ? shape
            ? nearestOnWalk((leg) => closestApproachToSurface(leg, shape.centre, shape.half))
            : nearestOnWalk((leg) => closestApproachOnRoute(leg, wantedPosition))
          : undefined;
      // The route is the character's origin, a point, while the character is a capsule
      // most of two metres tall. Walking straight over a pickup lying on the floor puts
      // that origin above it, so the surface distance is pure vertical clearance and the
      // walk reads as a miss — one tester reported `passedWithin: 14, crossed: false`
      // for a pickup that had just fired, and only the game log contradicted it. The
      // horizontal figure separates "went past to one side" from "went over the top".
      const passedWithinHorizontal =
        args.passThrough && walked && !startedNearTarget && shape
          ? nearestOnWalk((leg) => closestApproachToSurface(leg, shape.centre, shape.half, true))
          : undefined;
      const passedOverIt =
        passedWithin !== undefined &&
        passedWithinHorizontal !== undefined &&
        passedWithinHorizontal < 1 &&
        passedWithin >= 1;
      // Coming near the target is not going over it. A character stopped dead against
      // a solid gate passes within a few units of its face and gets nowhere, so a
      // crossing has to have come out the far side to count as one.
      // Progress along the approach line is not a crossing. A character walking
      // sideways past a wall gets further along that line than the wall is without
      // ever going through it, and reported a crossing for doing so. Only meaningful
      // where the target has no known shape; where it has one, entering it is the test.
      const wentPast =
        startedFrom && endedAt && !named?.half ? travelledBeyond(startedFrom, endedAt, wantedPosition) : undefined;
      // A pass-through is asking "did it go over the thing", which needs both: near
      // enough to have touched it, and out the other side.
      // With a shape, a crossing means the walk went inside it — nothing else counts,
      // and a character stopped against a gate's face never does. Without one, fall
      // back to near-and-beyond, which is the best a bare point allows.
      const crossed =
        passedWithin === undefined
          ? undefined
          : named?.half
            ? passedWithin <= 0
            : passedWithin <= tolerance && wentPast === true;
      // A pass-through keeps its own test — it is asking about the walk, not the
      // stopping place, and its note already carries the "went over the top" case.
      const arrived =
        crossed !== undefined
          ? crossed
          : standingOnTarget || (distanceToTarget !== undefined && distanceToTarget <= tolerance);
      const movedDistance = startedFrom && endedAt ? distanceBetween(startedFrom, endedAt) : undefined;
      const moved = movedDistance !== undefined && movedDistance > MOVED_AT_ALL;
      const walkedDistance = walked ? walkedLength(walked.legs) : undefined;
      const respawns = walked?.teleports ?? 0;
      // Standing still because navigation is already satisfied is not being blocked.
      // Distance alone cannot tell that from a wall — stopping 44 units short against
      // a solid gate and 34 short of a point nav likes look identical. The status can:
      // navigation says `reached` when it is satisfied and times out when it is stuck.
      const navSatisfied =
        status === "reached" && distanceToTarget !== undefined && distanceToTarget <= NAV_STOP_DISTANCE;
      // Only a finished move can be judged. While one is still running these are a
      // snapshot of a character mid-journey, and reporting them reads as a verdict.
      // A stall counts as finished: navigation has not given up, but the character
      // has stopped, and waiting out the budget would not learn anything more.
      const settled = isTerminalMoveStatus(status) || polled.stalled;
      const blocked = settled && distanceToTarget !== undefined && !arrived && !navSatisfied;
      // Nothing under the character's feet when the move ended. `arrived: true` beside
      // an endedAt with a negative y read as success to run 49, which had in fact been
      // walked off the map by the pass-through overshoot and was in free fall.
      const endedInAir = settled && endedState !== undefined && endedState.standingOnName === undefined;

      const outcome: MoveOutcome = !settled
        ? "stillMoving"
        : arrived
          ? "arrived"
          : blocked
            ? "blocked"
            : "stoppedShort";
      const navStatus = normalizeWaitedMoveStatus(outcome, status);

      return {
        output: jsonOutput({
          requestId,
          // The tool's own verdict, because `status` is navigation's word and keeps
          // saying `running` for a character that stopped dead — three testers read
          // that as "still going" on a call that had already returned.
          outcome,
          // A waited call has already combined navigation, stall detection, and the
          // measured end position. Keep its public status consistent with that verdict.
          navStatus,
          // Studio's last path-following word remains useful when diagnosing why the
          // wrapper overruled it, but it must not masquerade as the final result.
          ...(status !== undefined && status !== navStatus ? { rawNavStatus: status } : {}),
          // The field the description tells callers to read, which it did not emit for
          // a long time — leaving them to recompute it from distance and tolerance.
          ...(settled ? { arrived } : {}),
          // Without this, `arrived: true` sits beside a distanceToTarget of 84 and an
          // arrivalTolerance of 60 and reads as the tool contradicting itself.
          ...(standingOnTarget
            ? {
                standingOnTarget: args.targetName,
                arrivalNote:
                  `The character finished standing on ${args.targetName}, which is why this counts as arrived ` +
                  `even though distanceToTarget is larger than arrivalTolerance. Distances are measured from ` +
                  `the character's origin, which sits a capsule half-height (about 84 units) above its feet, ` +
                  `so anything you stand on top of can never measure as close as the tolerance asks.`,
              }
            : {}),
          // A raw running status can remain after the measured move has settled; this
          // says the wait was cut short on purpose.
          // Not worth saying when it got there: "arrived and stalled" reads as a
          // contradiction, and a character that stopped where it was going is just done.
          ...(polled.stalled && !arrived ? { stalled: true } : {}),
          clientId: target.clientId,
          waitedMs: polled.waitedMs,
          stallWindowMs: polled.stallWindowMs,
          ...(polled.gameTimeScale !== undefined ? { gameTimeScale: polled.gameTimeScale } : {}),
          // distanceToTarget stays measured from the point you asked about, not the
          // one it was aimed at, so passThrough does not quietly move the goalposts.
          ...(named ? { targetPosition: named.position } : {}),
          ...(destination !== wantedPosition ? { aimedAt: destination } : {}),
          ...(passedWithin !== undefined
            ? {
                passedWithin: Math.round(passedWithin),
                ...(passedWithinHorizontal !== undefined
                  ? { passedWithinHorizontal: Math.round(passedWithinHorizontal) }
                  : {}),
                crossed,
                ...(wentPast !== undefined ? { wentPast } : {}),
                passThroughNote: named?.half
                  ? passedOverIt
                    ? `The walk went directly over ${args.targetName}: passedWithinHorizontal is 0 and the ` +
                      `passedWithin of ${Math.round(passedWithin)} is vertical clearance between the ` +
                      `character's origin and the part. The origin is a point but the character is a ` +
                      `body, so it can overlap something its origin passes above — crossed is false here ` +
                      `because the origin stayed outside the box, and that is not evidence a pickup did ` +
                      `not fire. Only the game's own state shows that.`
                    : `crossed means the walk went inside ${args.targetName}, which is passedWithin 0. ` +
                      `Stopping against its face reads as a small passedWithin and not a crossing, which is ` +
                      `what walking into something solid looks like. This is geometry, not consequence: it ` +
                      `says the character went through the space the thing occupies, never that anything ` +
                      `fired. Only the game's own state changing shows that.`
                  : `Without a known shape a crossing is judged as near-and-beyond: passedWithin within ` +
                    `arrivalTolerance, plus wentPast. Name the target instead and it is judged on whether ` +
                    `the walk actually entered it.`,
              }
            : {}),
          ...(endedAt
            ? {
                [settled ? "endedAt" : "at"]: endedAt,
                // Left out of a pass-through, where it is the distance back to a target
                // the character was meant to overshoot. Two testers read that large
                // number as a miss on every pickup and had to talk themselves out of it.
                ...(passedWithin === undefined ? { distanceToTarget: Math.round(distanceToTarget ?? 0) } : {}),
                arrivalTolerance: tolerance,
              }
            : {}),
          ...(movedDistance !== undefined
            ? { moved, movedDistance: Math.round(movedDistance), ...(settled ? { blocked } : {}) }
            : {}),
          // movedDistance is the straight line between the ends, which understates any
          // route that went around something and says nothing at all about one that was
          // walked twice. Only worth printing when the two genuinely disagree.
          ...(walkedDistance !== undefined && movedDistance !== undefined && walkedDistance > movedDistance * 1.2
            ? { walkedDistance: Math.round(walkedDistance) }
            : {}),
          // A move that ends in mid-air has not really ended: the character is still
          // going, downwards, and wherever it lands is not where this reply says it is.
          ...(endedInAir
            ? {
                endedInAir: true,
                endedInAirNote:
                  `Nothing is under the character's feet where this move finished, so it is falling rather ` +
                  `than standing anywhere. Whatever the outcome says, it did not end here — read ` +
                  `studiorpc_game_character_read again once it has landed. A pass-through aimed past a ` +
                  `target near a ledge is the usual way to get here; passThroughBeyond shortens the aim.`,
              }
            : {}),
          // The move looks clean from its endpoints even when the character fell in,
          // was put back at the spawn, and navigation quietly re-walked the lot.
          ...(respawns > 0
            ? {
                respawnedMidMove: respawns,
                respawnNote:
                  `The character jumped position ${respawns === 1 ? "once" : `${respawns} times`} mid-move, ` +
                  `faster than anything can walk — it fell or died and the game put it back, and navigation ` +
                  `then set off again on its own. Whatever the outcome says, this move is not one clean walk: ` +
                  `anything you were testing along the way happened to a character that was somewhere else in ` +
                  `between. Crossing figures ignore the jump itself and cover only the stretches actually ` +
                  `walked. Re-run the move from a known position before trusting what it says.`,
              }
            : {}),
          // Being handed the character's own position as the target reads as a broken
          // reply otherwise: a zero-length move onto a thing that is somehow already here.
          ...(startedNearTarget && args.targetName
            ? {
                alreadyAtTarget: args.targetName,
                alreadyAtNote:
                  `${args.targetName} was already where the character was when the move started, so there was ` +
                  `nowhere to walk and no approach to judge — pass-through figures are left out rather than ` +
                  `reported against a target the character never approached. A part the character is carrying ` +
                  `moves with it and always reads like this, as does one it is standing on. Whether it is held ` +
                  `is a question for the game's own state, not for a move.`,
              }
            : {}),
          // A walk that went straight over the target is not an unproven test, and saying
          // so next to a note explaining the opposite is worse than saying nothing: run 42
          // reported the top-level verdict contradicting its own passThroughNote while the
          // pickup had in fact fired. The note carries this case on its own.
          ...(status === "reached" && distanceToTarget !== undefined && !arrived && !passedOverIt
            ? {
                warning:
                  // Two very different failures share this branch. Falling short of a
                  // tight tolerance is navigation working normally; not travelling at
                  // all is the level having nothing to navigate on.
                  distanceToTarget <= ARRIVAL_TOLERANCE
                    ? `The character stopped ${Math.round(distanceToTarget)} units from the target, which is ` +
                      `outside the arrivalTolerance of ${tolerance} you asked for. Navigation stops the ` +
                      `character a little short of any point, so this distance is normal travel rather than a ` +
                      `failed move — but it did not get as close as you needed, so treat whatever you were ` +
                      `testing at that spot as unproven.`
                    : `Studio reported "reached" but the character stopped ${Math.round(distanceToTarget)} units ` +
                      `from the target. Path following returns success even when it cannot get there — usually ` +
                      `because the level has no navigation data there, or the target is somewhere a walking ` +
                      `character cannot stand. Aim at ground level near the target, or pick a reachable point.`,
              }
            : {}),
          ...(settled && !moved && navSatisfied && !arrived
            ? {
                hint:
                  `The character did not move: navigation already counts ${Math.round(distanceToTarget ?? 0)} ` +
                  `units away as arrived, so asking for the same point again will not make it walk. If you ` +
                  `need it to pass through something there, send it to a point beyond the target so the path ` +
                  `crosses it, or step it away first and approach from further off.`,
              }
            : {}),
          ...(polled.stalled && !arrived
            ? {
                note:
                  `Studio navigation still reports "${status}" in rawNavStatus, but the character has not moved for ` +
                  `${polled.stallWindowMs / 1000} real seconds (${MOVE_STALL_MS / 1000} seconds of game time ` +
                  `at scale ${polled.gameTimeScale ?? 1}), so it is stuck rather than slow and the wait was cut short. ` +
                  `Something is in the way: check what it is standing against before assuming the target is bad.`,
              }
            : {}),
          ...(polled.timedOut
            ? {
                note:
                  `Still moving after ${timeoutMs}ms, so this is where the character is partway through rather ` +
                  `than where it ended up — there is no blocked verdict yet. Poll ` +
                  `studiorpc_game_character_move_status for the outcome; two polls reporting the same \`at\` ` +
                  `mean it is stuck rather than slow.`,
              }
            : {}),
        }),
        render: buildMoveToRender(target, wantedPosition, requestId, navStatus, polled.waitedMs),
        metadata: {
          tool: "studiorpc_game_character_move_to",
          clientId: target.clientId,
          requestId,
          status: navStatus,
          ...(status !== undefined && status !== navStatus ? { rawNavStatus: status } : {}),
          waitedMs: polled.waitedMs,
        },
      };
    },
  };
}

function createCharacterMoveStatusTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_character_move_status",
    description:
      "Report the outcome of a studiorpc_game_character_move_to request. Statuses pendingStart and running " +
      "mean the character is still on its way; reached, interrupted, timedOut, superseded, cancelled, failed, " +
      "and pieEnded are final. `at` is where the character is right now, so two polls that return running with " +
      "the same `at` mean it is stuck rather than slow — which is the question `running` alone cannot answer.",
    parameters: moveStatusParams,
    supportParallel: true,
    async execute(args: MoveStatusParams): Promise<ToolResult> {
      // Only the session id matters here, so a client that stopped accepting
      // input must not block reading the outcome of a move already underway.
      const pieSessionId = args.pieSessionId ?? (await readPieStatus(callRpc)).pieSessionId;
      if (!pieSessionId) {
        throw new Error("No live PIE session, so move status cannot be read. Pass pieSessionId explicitly.");
      }
      const result = (await callRpc(
        "game.character.moveStatus",
        { pieSessionId, requestId: args.requestId },
        { timeoutMs: PIE_STATUS_TIMEOUT_MS },
      )) as MoveStatusResult;

      // `running` on its own cannot tell progress from stuck. The position comes
      // back with it so one call answers which, instead of sending the caller to
      // game.character.read to find out.
      const at = await readCharacterPosition(callRpc);

      return {
        output: jsonOutput({ ...result, ...(at ? { at } : {}) }),
        render: buildMoveStatusRender(args.requestId, result?.status),
        metadata: {
          tool: "studiorpc_game_character_move_status",
          requestId: args.requestId,
          status: result?.status,
          done: isTerminalMoveStatus(result?.status),
        },
      };
    },
  };
}

/**
 * Play-test tools. Studio scopes held input and running sequences to the TCP
 * connection that sent them, and every call here opens its own connection, so a
 * batch must be self-contained — which is also what Studio's validator demands.
 *
 * There is deliberately no release-held-input tool: Studio releases on sequence
 * end, connection close, PIE end, and physical input, and `game.input.releaseAll`
 * only touches sequences owned by the calling connection — which a fresh
 * per-call connection never has. `studiorpc_game_stop` is the escape hatch.
 */
export function createPieInputTools(callRpc: CallRpc = call): Tool[] {
  return [
    createPieStatusTool(callRpc),
    createInputInjectTool(callRpc),
    createCharacterMoveToTool(callRpc),
    createCharacterMoveStatusTool(callRpc),
  ];
}

export type { PieTarget };
