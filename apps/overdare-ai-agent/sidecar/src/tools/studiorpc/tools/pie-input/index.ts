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
import { buildInputInjectRender, buildMoveToRender, buildPieStatusRender, isTerminalMoveStatus } from "./render";
import { type CallRpc, type PieTarget, readPieStatus, resolvePieTarget } from "./target";

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
/** Still for this long while navigation claims to be running means it is stuck, not slow. */
const MOVE_STALL_MS = 3_000;
/** The Studio time-scale endpoint clamps values to this minimum. */
const MIN_GAME_TIME_SCALE = 0.05;
/** Close enough to a named target's surface to count as having reached it. */
const TOUCH_MARGIN = 60;
/** A named target whose surface is this close to the character's origin is inside it. */
const ALREADY_AT_RADIUS = 30;
/** The character's origin sits a capsule half-height above its feet; every distance inherits it. */
const CHARACTER_ORIGIN_ABOVE_FEET = 84;
/**
 * Did the character get moved rather than walk, anywhere in this stretch? Only a guard on whether
 * to keep re-aiming: once the game has put the character somewhere else, setting off again is not
 * the same walk continuing but a new one from a place the caller never asked about. playtest4
 * watched a move re-aim across a fall and a reset and called the route "more erratic than a real
 * player's". No verdict is published from this — the reader gets characterTrack and sees the jump.
 */
function wasMovedNotWalked(track: TrackSample[]): boolean {
  for (let index = 1; index < track.length; index++) {
    const gap = distanceBetween(track[index - 1], track[index]);
    const seconds = Math.max(track[index].atMs - track[index - 1].atMs, 1) / 1_000;
    if (gap >= 300 && gap / seconds >= 2_000) return true;
  }
  return false;
}

/** A sample is worth keeping when the character has gone somewhere since the last one kept. */
const TRACK_MOVE_THRESHOLD = 25;
const TRACK_MAX_SAMPLES = 24;
/**
 * A backstop on re-aiming, not the budget. `timeoutMs` is the budget: a move that is still
 * covering ground should keep going until the caller's time runs out. Set at 8 first, and
 * playtest11's 6,000-unit walk stopped 272 units short with 95 of its 180 seconds unspent —
 * the count had bounded it, which is the one thing this number must not do.
 */
const MAX_MOVE_REAIMS = 40;

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

const moveToShape = {
  target: z
    .union([z.string().min(1), z.object({ x: z.number(), y: z.number(), z: z.number() })])
    .describe(
      "Where to walk. Name it — a runtime name, or a dot-separated path where the world reuses names, the " +
        "same two forms studiorpc_game_observe's instances section takes — and the tool reads where the thing is and how " +
        "big it is, so every distance comes back measured to its surface instead of to a coordinate you " +
        "guessed. An {x, y, z} in the world coordinates studiorpc_instance_read and " +
        "studiorpc_game_character_read report is the other form, for a spot that nothing stands at. Aim " +
        "that at ground level — take the object's x and z and the character's own y — because an object's " +
        "centre height is somewhere a walking character can never stand, and asking for it times out.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(MOVE_WAIT_MAX_MS)
    .optional()
    .describe(`How long to wait for the move to end. Defaults to ${MOVE_WAIT_DEFAULT_MS}ms.`),
  speedMultiplier: z
    .number()
    .min(0.1)
    .max(10)
    .optional()
    .describe(
      "Walk this move faster or slower than the character normally walks — 2 is twice as fast, 0.5 is " +
        "half. This is the character's own WalkSpeed and nothing else: the game's clock, its timers and " +
        "its spawns all run at their usual rate, so the only thing that changes is when you get there. " +
        "(For the clock itself, that is game_play's timeScale.) " +
        "Only for crossing ground you have already judged: a long empty run to the far side of the map " +
        "inside a timer that is spending itself while you walk. Arriving early is still arriving at a " +
        "different moment than a player would, so whatever the game times, spawns or sweeps on arrival " +
        "meets you in a state it would not have. Leave it out to walk at the speed a player has, which is the only " +
        "speed a claim about the game holds at. The reply says baseWalkSpeed and walkSpeed so the change " +
        "is on the record; the speed is put back when the move ends, however it ends. A game that clamps " +
        "its own movement wins over this — playtest11 held its character to 70 units a second in its own " +
        "Heartbeat and no multiplier would have moved it.",
    ),
  teleport: z
    .boolean()
    .optional()
    .describe(
      "Put the character at the target instead of walking it there. This is how a test reaches a " +
        "state, not how it finds out whether the state can be reached: nothing about the route is " +
        "measured, and a run that teleported past an obstacle has learned nothing about whether a " +
        "player could get past it. Use it to set up the part you are not testing — the far side of a " +
        "map you have already crossed once, the ledge whose approach is not today's question — and " +
        "walk the part you are. The reply says teleported and landedAt; landedAt can " +
        "differ from what you asked for, because a blocked destination is nudged to somewhere the " +
        "character can stand. Any move already running is cancelled first.",
    ),
  ...targetOverrides,
};

const moveToParams = z
  .object(moveToShape)
  // Strict on purpose, and load-bearing. Removed from this tool: `wait`, `passThroughBeyond`,
  // `targetName`, `targetPath`, `arrivalTolerance`, `passThrough`, `stopShortOf`, `position`.
  // Measured on gpt-5.6-terra, an agent offered an optional parameter fills it — every one of its
  // move_to calls carried a contradictory `passThrough` and `stopShortOf` together, and once
  // `position` was the only optional left it walked to "PressurePump" and (0, 0, 0) in the same
  // call — so a knob that is gone has to say so rather than be quietly ignored, and two knobs for
  // one question have to become one.
  .strict();

type InjectParams = z.infer<typeof injectParams>;
type MoveToParams = z.infer<typeof moveToParams>;

interface InjectResult {
  status?: string;
  /** Where the character stood at each event boundary; absent when the batch did not move it. */
  characterTrack?: Array<{ event: number; x: number; y: number; z: number; falling?: boolean }>;
  fellAtEvent?: number;
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
  baseWalkSpeed?: number;
  walkSpeed?: number;
  teleported?: boolean;
  landedAt?: { x: number; y: number; z: number };
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
  /** standingOn came back as null — the character is in the air. Absent means unknown, not falling. */
  falling?: boolean;
}

interface GameTimeScaleReadResult {
  timeScale?: number;
}

type MoveOutcome = "arrived" | "navigationGaveUp" | "stoppedShort" | "stillMoving";

/**
 * Which of the three arrival rules produced `arrived: true`.
 *
 * Two of them accept a character further from the target than `arrivedWithin`, so without this the
 * reply contradicts its own numbers: four play tests read `arrived: true` beside
 * `distanceToTarget: 84.1` and `arrivedWithin: 60` and had to go to the documentation to find out
 * whether the success was real. Two of them wrote the fix out themselves, under this name.
 */
type ArrivalReason = "standingOnTarget" | "atopTarget" | "withinRadius";

/**
 * A waited move combines terminal polling, stall detection, and the measured
 * end position. Its public status should follow that stronger verdict.
 *
 * `blocked` used to be one of these words and is gone. Nothing here probes collision, so the tool
 * could never tell an obstacle from a target off the navmesh — and both readers who received it
 * read it as a wall. One walked away believing a level was unwinnable and only found out
 * otherwise by holding W through the same spot; the other got it for a character that had walked
 * into lava and died. `navigationGaveUp` claims only what was observed.
 */
export function normalizeWaitedMoveStatus(outcome: MoveOutcome, rawStatus: string | undefined): string | undefined {
  switch (outcome) {
    case "arrived":
      return "reached";
    case "navigationGaveUp":
      return "navigationGaveUp";
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
/**
 * Which client to measure. A move can be aimed at any injectable client, so the reading that
 * checks it has to be aimed at the same one — measured once with this omitted: the move drove
 * the second player to within 20 units of the target and the reply, read from the first,
 * said `arrived: false`, `distanceToTarget: 1603`, and offered a missing-navmesh explanation
 * for a walk that had worked.
 */
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
    /** Where in the tree the answer came from. A name alone does not identify one instance. */
    path?: string;
    /** What it is, which is how a target with no position of its own explains itself. */
    class?: string;
  };
  /** How many instances share the name that was asked for, when it was more than one. */
  matches?: number;
  otherPaths?: string[];
}

/**
 * Where an instance actually is and how far it reaches, so a caller can name the
 * thing rather than type coordinates at it. Typed coordinates are where the
 * position errors come from: an invented height aims above the target, and every
 * distance in the reply is then measured from a place nothing occupies.
 */
async function readLiveInstance(
  callRpc: CallRpc,
  target: { name?: string; path?: string },
): Promise<
  | {
      position: { x: number; y: number; z: number };
      half?: { x: number; y: number; z: number };
      /** Which instance answered, and whether the name meant more than one. */
      path?: string;
      matches?: number;
      otherPaths?: string[];
    }
  /* Found, but nothing to walk to. A Model or Folder holds things that have positions
   * without having one itself, and reporting that as "no such name" is a false statement
   * about the world — the caller goes looking for a spelling mistake in a name that is
   * right there. In a deep world this is the common case: the thing a person names is the
   * group, and the thing a character can walk to is a Part inside it. */
  | { positionless: true; path?: string; class?: string }
  | undefined
> {
  // A name that is not there is this tool's own answer to give, not the transport's.
  // Studio raises `instanceNotFound` and the raw error surfaced straight through, so
  // the caller was told the name is absent and nothing about what to walk to instead
  // — while asking studiorpc_game_instance_read the same question answered with a
  // ranked list. Swallow it here so the throw below can say the useful thing.
  let result: LiveInstance;
  const query = target.path !== undefined ? { path: target.path } : { name: target.name };
  try {
    result = (await callRpc("game.instance.read", query, { timeoutMs: MOVE_RPC_TIMEOUT_MS })) as LiveInstance;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("is in the running Workspace")) return undefined;
    throw error;
  }
  // No instance block at all is "nothing answered", not "it answered without a position".
  // Reading the first as the second turns a missing name into a confident claim that the
  // name is a Model, which is a worse error than the one this branch exists to fix.
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
    return "Call studiorpc_game_observe with instances to see what is there.";
  }
  if (names.length === 0) return "Call studiorpc_game_observe with instances to see what is there.";
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

/** A place the character was seen and when, so a jump can be told apart from a walk. */
type TrackSample = { x: number; y: number; z: number; atMs: number };

/**
 * Whether the character was still covering ground when the move ended.
 *
 * A character still covering ground when navigation quit was not stopped by anything — it was
 * outrun by its own path, which is `stoppedShort`, not `navigationGaveUp`. Measured on
 * playtest11: a route to a console 5,337 units off gave up twice, each time after 850 units —
 * 12.06 seconds at a steady 70.5 units per second, which is the speed the game's own script
 * limits the character to. The run then walked the same ground with key presses, which worked,
 * and could not finish the fixture inside its budget.
 */
function movingAtTheEnd(track: TrackSample[], endedAtMs: number, windowMs: number): boolean {
  const recent = track.filter((sample) => endedAtMs - sample.atMs <= windowMs);
  if (recent.length < 2) return false;
  return distanceBetween(recent[0], recent[recent.length - 1]) > MOVED_AT_ALL;
}

/* `splitWalkedLegs` and `walkedLength` stood here. They cut the route wherever two samples were
 * further apart than anything could have walked, to count respawns and to measure the distance
 * actually covered on foot. Both were the same idea: read the route, decide what it meant, report
 * the decision. The route itself now ships as `characterTrack`, so the reader makes that decision
 * with the evidence in front of them — and the threshold the count depended on (300 units at
 * 2,000 a second) had already missed the two falls it was written for. */

/**
 * The route, small enough to read. Samples land every 300ms whether the character moved or not,
 * so most of them say nothing; keeping only the ones that went somewhere turns a recording into
 * a shape. The end is always kept, otherwise the last place that *changed* reads as the finish.
 *
 * Same rules as the track the input tool builds, so one reading applies to both replies.
 */
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
  // Past the cap, thin the middle rather than truncate it: the two ends are the ones a reader
  // always needs, and dropping the tail would hide where the walk finished.
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

function createPieStatusTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_pie_status",
    description:
      "Report the OVERDARE Studio play-in-editor (PIE) session: whether play mode runs, its pieSessionId, " +
      "the session's timeScale, and each client. Call this to check that a play test is live; the other " +
      "play-test tools resolve their target on their own. " +
      "`targeted: true` marks the default client, the one every tool uses when you name none. In a session " +
      "started with more than one player, studiorpc_game_input_inject, studiorpc_game_character_move_to and " +
      "studiorpc_game_character_read each take a `clientId` from this list, so the others can be driven and " +
      "read by id; the UI tree, screenshots and the camera cannot, and always describe the targeted one. " +
      "Instance reads are of the shared world, so every player's character is visible in them whichever " +
      "client is targeted.",
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
      "Limits: at most 64 events, at most 60s of time the batch could spend, and every key or button pressed " +
      "must be released inside the same batch. Everything that can take time counts towards the same 60s: " +
      "wait durations, every press durationMs, and each look's timeoutMs — which is 2000 by default even " +
      "when the turn finishes in milliseconds, so a look is charged what it is allowed to take rather than " +
      "what it takes. A wait with an `until` returns the moment its condition comes true, so a long " +
      "durationMs on one is a timeout rather than a cost. " +
      "Example — walk forward for half a second: " +
      '[{"type":"key","key":"W","action":"press","durationMs":500}]. ' +
      'To click a UI button, name it: {"type":"pointerButton","button":"left","action":"press",' +
      '"target":"START"}. Studio finds its centre in the live layout, so no rect has to be read first, and ' +
      "that fires the button's Activated exactly as a real click does — never ask the user to press a button " +
      "you can reach yourself. Clicking a position instead is still worth doing deliberately: a name reaches " +
      "the control wherever the layout put it, while a coordinate is the only way to find out that the " +
      "control is somewhere a player could not have clicked. " +
      "The batch is cancelled with interruptedByUser if the person at the machine takes the play test back " +
      "— a key while it holds focus, or a click inside its viewport. Their typing in another window does " +
      "not count. Retry the batch; the input was released. On any error, everything before failedEventIndex " +
      "was applied and stands, and everything held was released. " +
      "Whether the game reacted is a question for game state — read studiorpc_game_observe after, not the " +
      "reply's own fields. " +
      "characterTrack is where the character stood at each event boundary, and it appears only when the " +
      "batch actually moved it — each entry names the index of the event you wrote that it was read before, " +
      "so a route that went wrong is attributable to the event that sent it there; an index one past the " +
      "last event is the position after the batch. Positions that did not change are left out, so the list " +
      "is the shape of the walk and not a recording of it. falling on an entry means nothing was holding " +
      "the character up when it was read, and fellAtEvent names the first event where that started — the " +
      "answer to why a batch that looked correct ended somewhere else.",
    parameters: injectParams,
    async execute(args: InjectParams): Promise<ToolResult> {
      // Normalized here as well as in the schema: execute receives the arguments as
      // written, so a preprocess that only runs during validation never reaches this.
      const events = normalizeEventShapes(args.events) as InputEvent[];
      // Studio has no press action, so expand before validating — the limits it
      // enforces apply to what actually reaches it, not to what was authored.
      const { sent, origin } = expandWithOrigin(events);
      if (sent.length > MAX_EVENT_COUNT) {
        // Name the split point rather than the overage. playtest5 planned a whole victory
        // sequence, was told only that 84 was above 64, and had to work out by hand which of its
        // own events had crossed the line — the mapping back to authored indices is right here.
        const lastFitting = origin[MAX_EVENT_COUNT - 1];
        throw new Error(
          `The batch expands to ${sent.length} events, above Studio's ${MAX_EVENT_COUNT} limit ` +
            `(each press with a durationMs becomes three). Your ${events.length} events fit up to and ` +
            `including index ${lastFitting}; send events 0-${lastFitting} in one call and ` +
            `${lastFitting + 1}-${events.length - 1} in the next.`,
        );
      }
      const batchError = validateBatch(sent, origin);
      if (batchError) throw new Error(batchError);

      const target = await resolvePieTarget(callRpc, args);
      let result: InjectResult;
      try {
        result = (await callRpc(
          "game.input.inject",
          { pieSessionId: target.pieSessionId, clientId: target.clientId, events: sent },
          { timeoutMs: totalWaitMs(sent) + INJECT_OVERHEAD_MS },
        )) as InjectResult;
      } catch (error) {
        const answered = lookThatCancelledNothing(error, sent);
        if (!answered) throw error;
        result = answered;
      }

      // Studio counts the track against the batch it ran, which is the expanded one, so a
      // four-event batch came back saying it fell at event 5. Put the indices back on the scale
      // the caller wrote in — an index that names nothing they sent is worse than no index.
      const toAuthored = (sentIndex: number) => origin[Math.min(sentIndex, origin.length - 1)] ?? events.length - 1;
      const track = result?.characterTrack?.map((sample) => ({
        ...sample,
        event: sample.event >= sent.length ? events.length : toAuthored(sample.event),
      }));

      return {
        output: jsonOutput({
          ...result,
          ...(track ? { characterTrack: track } : {}),
          ...(result?.fellAtEvent === undefined ? {} : { fellAtEvent: toAuthored(result.fellAtEvent) }),
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

/**
 * A look that stopped short at the end of a batch, recovered as the answer it is.
 *
 * Studio fails an inject when a look does not land, because the events queued behind it would
 * otherwise fire at a view pointing somewhere nobody chose. That is the whole reason for the
 * failure — and when the look is the last event there is nothing behind it, so the batch
 * cancelled nothing and the failure describes no loss. What comes back instead is
 * `status: "blocked"`, which this tool's own description calls "an answer about the game rather
 * than a tool failure" and then delivered as `threw an unexpected error`. A play test asking
 * whether a game lets the player turn the view got its answer as an error and had to reason
 * past its own tooling to record the right fact.
 *
 * Narrow on purpose. A blocked look mid-batch stays an error, because there the events behind
 * it really were dropped; a pointer or key failure stays an error however it sits, because
 * those events did not happen at all. This recovers only the case where the answer arrived and
 * nothing was lost getting it.
 */
export function lookThatCancelledNothing(error: unknown, sent: InputEvent[]): InjectResult | undefined {
  if (!(error instanceof StudioRpcError) || sent[sent.length - 1]?.type !== "look") return undefined;
  const data = error.data;
  if (!data || typeof data !== "object") return undefined;
  const looks = (data as { looks?: InjectResult["looks"] }).looks;
  if (!Array.isArray(looks) || looks.length === 0) return undefined;
  // The failing look must be the one that ended the batch. An earlier look that stopped short
  // leaves the tail cancelled even when the tail ends in another look.
  if (looks.length !== sent.filter((event) => event.type === "look").length) return undefined;
  const last = looks[looks.length - 1]?.status;
  if (last !== "blocked" && last !== "timedOut") return undefined;
  // Studio ran the batch to its end; what it declined to do was turn the view.
  return { ...(data as Record<string, unknown>), status: last };
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
  clientId?: string,
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

    const position = await readCharacterPosition(callRpc, { pieSessionId, clientId });
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

const moveToDescription = [
  "Walk the play-test character to a named instance, or to a world position, using its own " +
    "navigation instead of steering it with key events. ",
  "Naming the target is the safer form: the tool reads where the thing actually is and measures to its " +
    "surface, where typed coordinates invite an invented height that aims at empty air above it. ",
  "Read `outcome`: arrived, navigationGaveUp, stoppedShort, or stillMoving. It is the tool's own " +
    "verdict, measured from where the character actually stopped, because Studio's raw " +
    "path-following word says `reached` even when it could not get there. " +
    "`navigationGaveUp` means navigation stopped without reaching the target and the character was " +
    "not still advancing — it does NOT mean the level blocks the way, and nothing here probes " +
    "collision. It reads the same for an obstacle, a target off the navmesh, and a route " +
    "navigation simply would not take. Before concluding anywhere is unreachable, hold a movement " +
    "key with studiorpc_game_input_inject and see whether the character walks it: one play test " +
    "got this 3766 units short of an open route and nearly filed the game as unwinnable. " +
    "Whether the character died, respawned or was teleported on the way is a question for the " +
    "game's own log — add a print to the script that moves it and read Play.log; `characterTrack` " +
    "shows the jump too. ",
  "`arrivalReason` names the rule that decided `arrived`, and is the field to read before " +
    "believing the distance contradicts the verdict. `withinRadius` judged `distanceToTarget` " +
    "against `arrivedWithin` (" +
    TOUCH_MARGIN +
    " units to a named target's surface, " +
    ARRIVAL_TOLERANCE +
    " to a bare position). `standingOnTarget` and `atopTarget` accept a character measured further " +
    "out than that on purpose: distances run from the character's origin, a capsule half-height " +
    "(~84) above its feet, so anything stood upon can never measure inside the radius — 84.1 " +
    "against a radius of 60 is the normal reading for a character standing on the target. " +
    "A target the character already stood at reports `alreadyAtTarget` with nothing else to judge. " +
    "Note the game's own rules are usually written flat " +
    "and from the centre, so check a stated reach against the target's Size, not this number alone. ",
  "`endedAt` is where the move ended (`at` while still moving), and `standingOn` names what is under " +
    "the character's feet there — null is a fall in progress, and the move did not really end where " +
    "the reply says. ",
  "`characterTrack` is the route as walked: one entry per place the character had actually gone " +
    "somewhere, timed in ms from the start of the move. Every question about the way — a fall, a " +
    "doubled-back walk, a game holding the character to a crawl, how long the crossing took — is " +
    "answered from it, not from separate fields. `reaimed` counts how many times navigation quit " +
    "mid-walk and was set off again at the same target, which a game that clamps movement speed in " +
    "its own script routinely causes. ",
  "`didNotSetOff` means the character never moved at all; with `declinedToWalk` true, navigation " +
    "answered `reached` without walking because it already counts that distance as close enough — " +
    "asking for the same point again will not make it move. ",
  "The call waits for the move to finish, so the reply describes where the character ended up rather " +
    "than where it was sent.",
].join("");

function createCharacterMoveToTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_character_move_to",
    description: moveToDescription,
    parameters: moveToParams,
    async execute(args: MoveToParams): Promise<ToolResult> {
      const target = await resolvePieTarget(callRpc, args);
      // One `target` takes both spellings, the way studiorpc_game_instance_read's do: a dotted
      // entry is a path first and a name second, because an instance may legitimately have a dot
      // in its own name. Two parameters for this were two ways to say the same thing.
      const wantedTarget = typeof args.target === "string" ? stripWorkspacePrefix(args.target) : undefined;
      const looksLikePath = wantedTarget?.includes(".") ?? false;
      let found = wantedTarget
        ? await readLiveInstance(callRpc, looksLikePath ? { path: wantedTarget } : { name: wantedTarget })
        : undefined;
      if (wantedTarget && !found && looksLikePath) {
        found = await readLiveInstance(callRpc, { name: wantedTarget });
      }
      if (wantedTarget && !found) {
        throw new Error(
          `Nothing in the running Workspace is called "${wantedTarget}"` +
            (looksLikePath ? ", as a path or as a name" : "") +
            `, so there is nowhere to walk to. ` +
            (await nearbyNamesSentence(callRpc, wantedTarget)),
        );
      }
      // It is there; it just is not anywhere. Saying "no such name" about a name the world
      // does have sends the caller hunting a spelling mistake, and in a nested world the
      // name a person reaches for is usually the group rather than one of its parts.
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
      // Where it began, so the reply can say whether the character travelled at all.
      // Two moves that end on the same spot look like a no-op otherwise.
      const startedFrom = await readCharacterPosition(callRpc, target);
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
        wantedTarget !== undefined && startedFrom !== undefined && measureTo(startedFrom) <= ALREADY_AT_RADIUS;
      const destination = wantedPosition;
      const started = (await callRpc(
        "game.character.moveTo",
        {
          pieSessionId: target.pieSessionId,
          clientId: target.clientId,
          position: destination,
          ...(args.speedMultiplier === undefined ? {} : { speedMultiplier: args.speedMultiplier }),
          ...(args.teleport ? { teleport: true } : {}),
        },
        { timeoutMs: MOVE_RPC_TIMEOUT_MS },
      )) as MoveToResult;

      // A teleport is over the moment it returns. Polling navigation for it would wait out a
      // stall window for a move nobody is making, and the route analysis below would read the
      // jump as a fall-and-respawn — the one thing that shape is meant to detect.
      if (args.teleport) {
        const landedState = await readCharacterState(callRpc, target);
        // landedAt can differ from what was asked for: a blocked destination is nudged to
        // somewhere the character can stand, and the reply must say where that was.
        const landed = started?.landedAt ?? landedState?.position;
        return {
          output: jsonOutput({
            outcome: "teleported",
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
      // The move always waits now. `wait: false` existed for 40 iterations and was passed 7
      // times, and what it did — hand back a requestId to poll yourself — is what
      // studiorpc_game_character_move_status is for.
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
      const gameTimeScale = await readGameTimeScale(callRpc);
      const deadlineAtMs = Date.now() + timeoutMs;

      /* Studio's path following gives up when the character cannot keep up with the path it was
       * handed, and a game that clamps its own speed in script produces exactly that: playtest11
       * held its character to 70 units a second in a Heartbeat, and a 6,000-unit walk stopped at
       * 852 with nothing wrong except that navigation expected it to be faster. The route was
       * walkable — the same ground went by fine under key presses — so the move sets off again
       * rather than reporting a wall that is not there. Only while it is still covering ground:
       * a character that has actually stopped is not going to start by being asked twice. */
      let polled = await pollMoveStatus(
        callRpc,
        target.pieSessionId,
        requestId,
        Math.max(1_000, deadlineAtMs - Date.now()),
        gameTimeScale,
        target.clientId,
      );
      // Every stretch actually walked, across re-aims. A correction is another walk, and dropping
      // the earlier ones would hide a fall-and-respawn that happened on one of them behind a
      // clean-looking final leg.
      const walkedTrack: TrackSample[] = [...polled.track];
      let endedState = await readCharacterState(callRpc, target);
      let reaims = 0;
      while (
        reaims < MAX_MOVE_REAIMS &&
        Date.now() < deadlineAtMs &&
        isTerminalMoveStatus(polled.status) &&
        endedState?.position !== undefined &&
        measureTo(endedState.position) > (named?.half ? TOUCH_MARGIN : ARRIVAL_TOLERANCE) &&
        movingAtTheEnd(polled.track, Date.now(), polled.stallWindowMs) &&
        // A falling character is moving, which is why "still covering ground" is not enough on its
        // own: the first version re-aimed straight through a fall and a respawn. Nothing underfoot
        // reads as `undefined` here, not `null` — the probe's miss is an absent name, not an empty one.
        endedState.standingOnName !== undefined &&
        !wasMovedNotWalked(polled.track)
      ) {
        const again = (await callRpc(
          "game.character.moveTo",
          {
            pieSessionId: target.pieSessionId,
            clientId: target.clientId,
            position: destination,
            ...(args.speedMultiplier === undefined ? {} : { speedMultiplier: args.speedMultiplier }),
          },
          { timeoutMs: MOVE_RPC_TIMEOUT_MS },
        )) as MoveToResult;
        if (!again?.requestId) break;
        reaims += 1;
        polled = await pollMoveStatus(
          callRpc,
          target.pieSessionId,
          again.requestId,
          Math.max(1_000, deadlineAtMs - Date.now()),
          gameTimeScale,
          target.clientId,
        );
        walkedTrack.push(...polled.track);
        endedState = await readCharacterState(callRpc, target);
      }
      const status = polled.status ?? started?.status;

      // Check the claim rather than repeat it: a level without navigation data can
      // report `reached` with the character still standing where it started.
      const endedAt = endedState?.position;
      const endedAtMs = Date.now();

      // Standing on the target is the closest a character can get to it, but the
      // measurement says otherwise: distances are taken from the character's origin,
      // a capsule half-height above its feet, so landing on a plinth reads about 84
      // units of surface distance and `arrived` is unreachable by construction. Run 44
      // was told `blocked` for a plinth it was standing on top of, and went back to
      // re-verify a move that had worked.
      //
      // Compared by leaf, not by the caller's string: standingOn reports the display
      // name, and a caller who wrote "LavaLaneCourse.GoalPad" is standing on "GoalPad".
      // Comparing against args.target verbatim made this escape hatch unreachable for
      // every path-form target — two build runs were told `blocked` on the finish pad
      // after the game's own win event had fired.
      const targetLeaf = (
        named?.path ?? (typeof args.target === "string" ? stripWorkspacePrefix(args.target) : undefined)
      )
        ?.split(".")
        .pop();
      const standingOnTarget = targetLeaf !== undefined && endedState?.standingOnName === targetLeaf;
      const distanceToTarget = endedAt ? measureTo(endedAt) : undefined;
      // A thin floor marker is a target nothing can ever stand ON: the character stands
      // on the floor around or above it, standingOn names the floor, and the 3D surface
      // distance is all vertical — the capsule origin sits ~84 above feet that are level
      // with the panel. Horizontally inside it at its height IS arrival for anything
      // flat; a game rule judged the player inside while this verdict said stoppedShort
      // at 82.2. The vertical band accepts feet from the target's top down to slightly
      // into it, and nothing hovering a storey above.
      const feetAboveTargetTop = named?.half && endedAt ? endedAt.y - (named.position.y + named.half.y) : undefined;
      const horizontalToTarget =
        named?.half && endedAt ? distanceToSurface(endedAt, named.position, named.half, true) : undefined;
      const atopTarget =
        horizontalToTarget !== undefined &&
        horizontalToTarget <= TOUCH_MARGIN &&
        feetAboveTargetTop !== undefined &&
        feetAboveTargetTop >= 0 &&
        feetAboveTargetTop <= CHARACTER_ORIGIN_ABOVE_FEET + TOUCH_MARGIN;
      // Reaching a named target is judged against its surface, a bare position against the
      // looser radius navigation actually achieves. Neither is settable: a threshold the
      // caller picks only renames a number the reply already carries.
      const tolerance = named?.half ? TOUCH_MARGIN : ARRIVAL_TOLERANCE;
      // The route as walked: where it began, every distinct place the poll caught it,
      // and where it finished. Sampled a few times a second, so a fast character can
      // still cut a corner between samples — but it is the walk, not a line drawn
      // between its ends, and that difference reported crossings that never happened.
      const route: TrackSample[] | undefined =
        startedFrom && endedAt
          ? [{ ...startedFrom, atMs: startedAtMs }, ...walkedTrack, { ...endedAt, atMs: endedAtMs }]
          : undefined;
      // Distance-based arrival is denied to a character known to be falling: passing
      // through the arrival radius mid-air is passing the target, not arriving at it —
      // one run was told `arrived` mid-fall and standingOn: null was the only field
      // telling the truth. Known falling, not merely unknown: a read that failed says
      // nothing about the air, and the distance criterion keeps its own authority there.
      const knownFalling = endedState?.falling === true;
      const arrived =
        standingOnTarget ||
        atopTarget ||
        (!knownFalling && distanceToTarget !== undefined && distanceToTarget <= tolerance);
      // Same order as the test above, so the name always matches the rule that actually decided.
      const arrivalReason: ArrivalReason | undefined = !arrived
        ? undefined
        : standingOnTarget
          ? "standingOnTarget"
          : atopTarget
            ? "atopTarget"
            : "withinRadius";
      const movedDistance = startedFrom && endedAt ? distanceBetween(startedFrom, endedAt) : undefined;
      const moved = movedDistance !== undefined && movedDistance > MOVED_AT_ALL;
      // The walk itself, compacted the same way the input tool compacts its own: only the places
      // the character had actually gone somewhere, so the list is the shape of the route and not
      // a recording of it. It replaces the three fields that used to describe the route in prose.
      const track = compactRoute(route, startedAtMs);
      // Only a finished move can be judged. While one is still running these are a
      // snapshot of a character mid-journey, and reporting them reads as a verdict.
      // A stall counts as finished: navigation has not given up, but the character
      // has stopped, and waiting out the budget would not learn anything more.
      const settled = isTerminalMoveStatus(status) || polled.stalled;
      // Whatever the verdict above, a move that never set off is a fact the caller needs, and
      // it was the one thing the reply would not say. Measured on Glasshouse: asking twice for
      // a 560-wide bed answered `blocked`, `rawNavStatus: reached`, `movedDistance: 0` at 80.1
      // units, with no hint at all. Run 76 went looking at `waitedMs` for the anomaly instead,
      // because 339 ms was the only number in the reply that looked wrong, and concluded
      // `waitedMs` was unusable.
      // It is not: 339 ms is honestly how long a move that never started took.
      //
      // This does not touch `blocked`. Whether 80 units from a wide bed is navigation being
      // content or navigation failing is a boundary this cannot draw from one call — the same
      // shape at 5000 units is a target with no navmesh under it, which `blocked` must keep
      // saying. So it adds the fact and leaves the verdict alone.
      const didNotSetOff = settled && !moved && !arrived;
      // Two ways to not set off, and they need opposite responses. Navigation answering
      // `reached` without moving is it declining to walk for a point it counts as reached —
      // asking again is futile. Navigation still `running` while the character stands still is
      // something in the way. `movedDistance: 0` is the same in both and says neither.
      const declinedToWalk = didNotSetOff && status === "reached";
      // Nothing here probes collision, so this can only say that navigation stopped without
      // getting there — never why. It used to say `blocked`, and every reader took that for a
      // wall: one asked to walk an open route, got `blocked` 3766 units short, and nearly filed
      // the game as unwinnable before holding W straight through the same spot; another got it
      // for a character that had walked into lava and died. Both are "navigation gave up", which
      // is all that was observed.
      // A character that was still advancing when navigation quit was not stopped by anything;
      // it was outrun by its own path. That is `stoppedShort`.
      const stillWalking = movingAtTheEnd(walkedTrack, endedAtMs, polled.stallWindowMs);
      const obstructed = (!moved || status !== "reached") && !stillWalking;
      // `navSatisfied` used to sit here — "stopped inside the distance navigation settles at,
      // so not blocked". It became unreachable when the caller-set tolerance went: navigation
      // settles within 50 units and the smallest radius that now counts as arrival is 60, so
      // anything it would have excused is already `arrived`.
      const gaveUp = settled && distanceToTarget !== undefined && !arrived && obstructed;
      const outcome: MoveOutcome = !settled
        ? "stillMoving"
        : arrived
          ? "arrived"
          : gaveUp
            ? "navigationGaveUp"
            : "stoppedShort";
      const navStatus = normalizeWaitedMoveStatus(outcome, status);
      // The speed the walk actually achieved, from the route as walked. `walkSpeed` reports what
      // was asked of the character controller; a game that clamps movement in its own script wins
      // that argument without telling either field. Measured: both nominal fields said 500 while
      // a Heartbeat clamp held the character to ~70, and the caller computed arrival times seven
      // times too optimistic from them.
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
          // The tool's own verdict, because navigation's raw word keeps saying `running` for a
          // character that stopped dead. arrived / blocked / stoppedShort / stillMoving.
          outcome,
          ...(settled ? { arrived } : {}),
          // Which rule said so. `standingOnTarget` and `atopTarget` both accept a character
          // measured further out than `arrivedWithin`, and a verdict a reader cannot reproduce
          // from the values beside it reads as a bug in the tool: four play tests stopped on
          // `arrived: true` next to 84.1 > 60. Naming the rule costs a string and is the whole fix.
          ...(arrivalReason ? { arrivalReason } : {}),
          // `rawNavStatus` stood here: navigation's own last word, shipped whenever it disagreed
          // with the verdict. Disagreeing was the normal case, so what readers saw was a reply
          // contradicting itself — `arrived` beside `running`, five rounds calling it confusing
          // and one trusting it over the verdict. The verdict is measured from where the
          // character actually stopped; the raw word is what it was measured against.
          // Which instance this actually walked to. A name picks one of however many share it.
          ...(named?.path ? { target: named.path } : {}),
          ...(named?.matches !== undefined && named.matches > 1
            ? { targetMatches: named.matches, targetOtherPaths: named.otherPaths ?? [] }
            : {}),
          // Standing on the target counts as arrived whatever the distance says: distances are
          // measured from the character's origin, a capsule half-height (~84) above its feet,
          // so anything stood upon can never measure inside the arrival radius.
          ...(standingOnTarget ? { standingOnTarget: args.target } : {}),
          // Being handed the character's own position as the target reads as a broken move
          // otherwise — a carried part, or the one it is standing on, always looks like this.
          ...(startedNearTarget && args.target ? { alreadyAtTarget: args.target } : {}),
          ...(endedAt
            ? {
                [settled ? "endedAt" : "at"]: endedAt,
                // One decimal, not an integer: 60.1 against a radius of 60 must not print as
                // 60 outside 60 — a reply that contradicts its own numbers reads as broken.
                distanceToTarget: Math.round((distanceToTarget ?? 0) * 10) / 10,
                // The radius `arrived` was judged against: 60 to a named target's surface,
                // 150 to a bare point.
                arrivedWithin: tolerance,
              }
            : {}),
          // What is under the character's feet where the move ended — null is falling, and a
          // move that ended falling did not really end here.
          ...(settled && endedState !== undefined ? { standingOn: endedState.standingOnName ?? null } : {}),
          // A move that navigation answered `reached` for without moving the character is it
          // declining to walk: it already counts this close as arrived, and asking for the same
          // point again will not make it move.
          ...(didNotSetOff ? { didNotSetOff: true, declinedToWalk } : {}),
          // The route as walked, timestamped from the start of the move. Every claim about what
          // happened on the way — a fall, a reset, a speed clamp, a detour — is read from this.
          ...(track && track.length > 1 ? { characterTrack: track } : {}),
          // What the walk actually did per second, next to what was asked. Games clamp movement
          // in script, and the clamp shows up only here.
          ...(measuredSpeed !== undefined ? { measuredSpeed } : {}),
          // Navigation gave up mid-walk and was set off again at the same target this many
          // times. A game that clamps its own movement speed in script is the usual reason.
          ...(reaims > 0 ? { reaimed: reaims } : {}),
          // Only when it was asked for: a walk at a speed a player does not have is a fact
          // every timing claim downstream depends on, and it is already restored by now.
          // One speed field, not three: baseWalkSpeed was walkSpeed divided by the multiplier,
          // and a second nominal number beside a wrong nominal number only doubled the error.
          ...(args.speedMultiplier !== undefined
            ? { speedMultiplier: args.speedMultiplier, walkSpeed: started?.walkSpeed }
            : {}),
          clientId: target.clientId,
        }),
        render: buildMoveToRender(target, wantedPosition, requestId, navStatus, polled.waitedMs),
        metadata: {
          tool: "studiorpc_game_character_move_to",
          clientId: target.clientId,
          requestId,
          status: navStatus,
          waitedMs: polled.waitedMs,
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
  return [createPieStatusTool(callRpc), createInputInjectTool(callRpc), createCharacterMoveToTool(callRpc)];
}

export type { PieTarget };
