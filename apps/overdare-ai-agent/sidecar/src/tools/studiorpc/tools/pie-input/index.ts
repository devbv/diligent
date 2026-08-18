// @summary Agent-facing play-test tools: PIE status, input injection, and character moveTo.

import { statSync } from "node:fs";
import { z } from "zod";
import { rankNames, stripWorkspacePrefix } from "../../methods/game.instance.read";
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
  buildMoveToRender,
  buildPieStatusRender,
  describeEvents,
  isTerminalMoveStatus,
} from "./render";
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

/**
 * A distance printed beside the threshold it is being judged against, at whatever precision
 * keeps the sentence true.
 *
 * Measured on Glasshouse: a stop at 80.1 units against a tolerance of 80 printed as *"stopped
 * 80 units from the target, which is outside the arrivalTolerance of 80"* — a sentence that
 * refutes itself, and that a reader can only take as the tool being broken. Rounding is fine
 * until the rounded number lands on the number it is supposed to differ from.
 */
function against(distance: number, threshold: number): string {
  const rounded = Math.round(distance);
  if (rounded !== Math.round(threshold)) return String(rounded);
  const oneDecimal = Math.round(distance * 10) / 10;
  return oneDecimal === threshold ? distance.toPrecision(4) : oneDecimal.toFixed(1);
}
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

const moveToShape = {
  target: z
    .union([z.string().min(1), z.object({ x: z.number(), y: z.number(), z: z.number() })])
    .describe(
      "Where to walk. Name it — a runtime name, or a dot-separated path where the world reuses names, the " +
        "same two forms studiorpc_game_instance_read takes — and the tool reads where the thing is and how " +
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonOutput(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * Which binary is answering, and when it was built.
 *
 * "It is in the source" and "it is what is running" are different claims, and telling them apart has
 * cost this loop real runs: the tool CLI executes the working tree, so a sidecar change looks live the
 * instant it is saved, while the installed exe still carries whatever was last copied over. Studio
 * reports its own build in capabilities.engineBuild the same way. Both are file timestamps rather than
 * version strings, because a timestamp cannot be forgotten the way a hand-bumped number can.
 *
 * host tells the two apart: the packaged server answers as diligent-web-server, the CLI as bun.
 */
function readSidecarBuild(): { host: string; build?: string } {
  try {
    const path = process.execPath;
    const host = (path.split(/[\\/]/).pop() ?? path).replace(/\.exe$/i, "");
    return { host, build: statSync(path).mtime.toISOString() };
  } catch {
    return { host: "unknown" };
  }
}

function createPieStatusTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_pie_status",
    description:
      "Report the OVERDARE Studio play-in-editor (PIE) session: whether play mode runs, its pieSessionId, and " +
      "each client with its netMode and whether input can be injected into it. Call this to check that a " +
      "play test is live; the other play-test tools resolve their target on their own. " +
      "`targeted: true` marks the default client — the injectable one with the lowest pieInstance — which is " +
      "what every tool here uses when you name none. In a session started with more than one player, " +
      "studiorpc_game_input_inject, studiorpc_game_character_move_to and studiorpc_game_character_read each " +
      "take a `clientId` from this list, so the others can be driven and read by id; the UI tree, screenshots " +
      "and the camera cannot, and always describe the targeted one. Instance reads are of the shared world, " +
      "so every player's character is visible in them whichever client is targeted. " +
      "`capabilities` says what this Studio build accepts, and `sidecar` which binary answered: compare them " +
      "against what you expect before trusting a run, because a rebuilt exe that Studio was never restarted " +
      "onto looks exactly like a feature that does not work. " +
      "`worlds` reports the server and client separately, which is what catches the two running at different " +
      "speeds: `timeDilation` is the scale that was applied and `measuredScale` is the scale the world was " +
      "observed to actually tick at. `gameTimeSeconds` is each world's own clock — already scaled, so the " +
      "difference between two reads is how much game time passed, whatever the wall clock did. " +
      "studiorpc_game_character_read carries the same clock and is cheaper to ask.",
    parameters: z.object({}),
    supportParallel: true,
    async execute(): Promise<ToolResult> {
      const status = await readPieStatus(callRpc);
      const answered = { ...status, sidecar: readSidecarBuild() };
      return {
        output: jsonOutput(answered),
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
      'To click a UI button, name it: {"type":"pointerButton","button":"left","action":"press",' +
      '"target":"START"}. Studio finds its centre in the live layout, so no rect has to be read first, and ' +
      "that fires the button's Activated exactly as a real click does — never ask the user to press a button " +
      "you can reach yourself. Clicking a position instead is still worth doing deliberately: a name reaches " +
      "the control wherever the layout put it, while a coordinate is the only way to find out that the " +
      "control is somewhere a player could not have clicked. " +
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
  return {
    ...(data as Record<string, unknown>),
    status: last,
    // Studio ran the batch to its end; what it declined to do was turn the view.
    appliedEventCount: sent.length,
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
  "Read `outcome`, which is the tool's own verdict on the move: arrived, blocked, stoppedShort, or " +
    "stillMoving. `navStatus` is the matching stable status: reached, blocked, stoppedShort, or the " +
    "still-active navigation status. When Studio's last path-following word differs, the reply preserves " +
    "it as `rawNavStatus` for diagnosis rather than placing a contradictory raw `running` beside an " +
    "arrived result. Studio reports raw `reached` whenever its path following " +
    "returns success, which it does even when it could not get there, so the tool measures where the " +
    "character actually stopped. ",
  "`arrived` is true when the move finished within reach of what you asked for — " +
    TOUCH_MARGIN +
    " units of a named target's surface, " +
    ARRIVAL_TOLERANCE +
    " of a bare position, echoed back as " +
    "`arrivedWithin` — and appears only " +
    "once the move is over, so a reply without it is one that has not finished. It is a verdict, not a " +
    "measurement: read `distanceToTarget` wherever the number is what matters, and judge the reach the " +
    "game states for yourself. Finishing on top of a named target counts as arrived whatever the distance " +
    "says, reported as `standingOnTarget`, because distances are measured from the character's origin — a " +
    "capsule half-height above its feet — so anything it stands on reads about 84 units away by " +
    "construction. A named target the character was already at reports `alreadyAtTarget`. ",
  "`distanceToTarget` is how far the character finished from the place you asked for, and `endedAt` is " +
    "where that was; a still-running move reports `at` instead, because it has not ended anywhere yet. ",
  "`distanceToTarget` is three-dimensional and measured to a named target's *surface*. Games usually " +
    "state a reach the other way round — flat, and from the thing's centre — so a named target also comes " +
    "back with `horizontalDistanceToCentre`, the X/Z distance from where the character stopped to the " +
    "target's centre. Bracket a stated reach against that one and the two numbers stop disagreeing: " +
    "standing 25 from a 50-wide pot's surface is standing 50 from its centre, and only the second is the " +
    "number the game's own rule is written in. ",
  "`stallWindowMs` is how long the character has to be *motionless* before the wait gives up on it. It " +
    "is not a deadline, and a move that keeps moving exceeds it routinely — one 1,589-unit crossing at " +
    "0.2x waited 16,599ms against a 15,000ms window and arrived, because the character was walking the " +
    "whole time. Read it beside `travelMs`, which only appears when the window was actually spent. " +
    "`waitedMs` is how long this call waited, and it is not travel time whenever `travelMs` appears " +
    "beside it. A move that parks short of a target Studio never calls terminal has its wait cut off by " +
    "the stall window, so `waitedMs` is `travelMs` plus `stallWindowMs` — a constant few seconds in which " +
    "nothing moved. Budget travel from `travelMs` when it is there and from `waitedMs` when it is not: " +
    "the same 1201 units measured 2595ms one way and 5868ms the other, and the whole difference was that " +
    "window. ",
  "`moved` and `movedDistance` say whether it travelled at all, which separates a move that was " +
    "unnecessary — already where it was sent — " +
    "from one that went nowhere. `movedDistance` is the " +
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
    "blocked. `gameTimeScale` reports the scale used when Studio provided it. ",
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
            `Part inside it — studiorpc_game_instance_read with under: "${found.path ?? wantedTarget}" lists ` +
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
        { pieSessionId: target.pieSessionId, clientId: target.clientId, position: destination },
        { timeoutMs: MOVE_RPC_TIMEOUT_MS },
      )) as MoveToResult;

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
      const polled = await pollMoveStatus(
        callRpc,
        target.pieSessionId,
        requestId,
        timeoutMs,
        gameTimeScale,
        target.clientId,
      );
      const status = polled.status ?? started?.status;

      // Check the claim rather than repeat it: a level without navigation data can
      // report `reached` with the character still standing where it started.
      const endedState = await readCharacterState(callRpc, target);
      const endedAt = endedState?.position;
      const endedAtMs = Date.now();
      // Every stretch actually walked, across re-aims. A correction is another walk,
      // and dropping the earlier ones would hide a fall-and-respawn that happened on
      // one of them behind a clean-looking final leg.
      const walkedTrack: TrackSample[] = [...polled.track];

      // Standing on the target is the closest a character can get to it, but the
      // measurement says otherwise: distances are taken from the character's origin,
      // a capsule half-height above its feet, so landing on a plinth reads about 84
      // units of surface distance and `arrived` is unreachable by construction. Run 44
      // was told `blocked` for a plinth it was standing on top of, and went back to
      // re-verify a move that had worked.
      const standingOnTarget = args.target !== undefined && endedState?.standingOnName === args.target;
      const distanceToTarget = endedAt ? measureTo(endedAt) : undefined;
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
      // Only the stretches walked on foot. A fall and respawn mid-move otherwise joins
      // two ends of the level with a line the character never travelled, and the
      // crossing test happily reports whatever sits under it.
      const walked = route ? splitWalkedLegs(route) : undefined;
      const arrived = standingOnTarget || (distanceToTarget !== undefined && distanceToTarget <= tolerance);
      const movedDistance = startedFrom && endedAt ? distanceBetween(startedFrom, endedAt) : undefined;
      const moved = movedDistance !== undefined && movedDistance > MOVED_AT_ALL;
      const walkedDistance = walked ? walkedLength(walked.legs) : undefined;
      const respawns = walked?.teleports ?? 0;
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
      // `blocked` has to mean something got in the way, because that is what every reader does
      // with the word. A real walk that navigation reported as `reached` is not that — it is a
      // target the character stopped short of, which is what `stoppedShort` already says.
      // Runs 68 and 69 both read `blocked` as a collision and went hunting a wall that was not
      // there: 69's case was a 200-wide Pad, approached normally over 418 units, whose surface
      // sits 99 units below a character standing on the spawn pad on top of it. Requiring
      // either "it never really moved" or "navigation did not report success" keeps the word
      // for the case it describes, and leaves the distance warning to say the rest.
      const obstructed = !moved || status !== "reached";
      // `navSatisfied` used to sit here — "stopped inside the distance navigation settles at,
      // so not blocked". It became unreachable when the caller-set tolerance went: navigation
      // settles within 50 units and the smallest radius that now counts as arrival is 60, so
      // anything it would have excused is already `arrived`.
      const blocked = settled && distanceToTarget !== undefined && !arrived && obstructed;
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
          // Which instance this actually walked to. A name picks one of however many share
          // it, and a run that asked for a pot in one tray and was silently walked to the
          // identically named pot in another has no way to notice from anything else here.
          ...(named?.path ? { target: named.path } : {}),
          ...(named?.matches !== undefined && named.matches > 1
            ? {
                targetMatches: named.matches,
                targetOtherPaths: named.otherPaths ?? [],
                targetAmbiguityNote:
                  `${named.matches} instances are called "${args.target}" and this walked to the one at ` +
                  `${named.path}. Pass the dotted path as \`target\` to choose a different one.`,
              }
            : {}),
          // Without this, `arrived: true` sits beside a distanceToTarget of 84 and an
          // arrivedWithin of 60 and reads as the tool contradicting itself.
          ...(standingOnTarget
            ? {
                standingOnTarget: args.target,
                arrivalNote:
                  `The character finished standing on ${args.target}, which is why this counts as arrived ` +
                  `even though distanceToTarget is larger than arrivedWithin. Distances are measured from ` +
                  `the character's origin, which sits a capsule half-height (about 84 units) above its feet, ` +
                  `so anything you stand on top of can never measure as close as that radius asks.`,
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
          // Suppressing the *word* on an arrived move is right; suppressing the *time* is not.
          // A move that parks short of a target Studio never calls terminal waits the stall
          // window out, so waitedMs carries a constant three seconds nothing travelled in.
          // Measured on playtest2: the same 1201 units took 2595ms southbound and 5868ms
          // northbound, twice each, and the difference is exactly this window. A run reported
          // waitedMs as "not proportional to distance" off that shape, which it is not, because
          // the number was two numbers added together and only one of them was travel.
          ...(polled.stalled ? { travelMs: Math.max(0, polled.waitedMs - polled.stallWindowMs) } : {}),
          ...(polled.gameTimeScale !== undefined ? { gameTimeScale: polled.gameTimeScale } : {}),
          // Where the named thing actually was, so `distanceToTarget` can be checked rather
          // than trusted — and so a name that resolved to the wrong instance is visible.
          ...(named ? { targetPosition: named.position } : {}),
          // Games state a reach the other way round: flat, and from the thing's centre.
          // distanceToTarget is neither — it is three-dimensional and to the surface — so a run
          // bracketing "about sixty units" was converting by hand from endedAt and the target's
          // centre. Two runs did that same arithmetic, which by this harness's own rule means a
          // missing field rather than a careful tester. Both numbers ship; neither is renamed.
          ...(named && endedAt
            ? {
                horizontalDistanceToCentre:
                  Math.round(Math.hypot(endedAt.x - named.position.x, endedAt.z - named.position.z) * 10) / 10,
              }
            : {}),
          ...(endedAt
            ? {
                [settled ? "endedAt" : "at"]: endedAt,
                distanceToTarget: Math.round(distanceToTarget ?? 0),
                // The radius `arrived` was judged against. Named for what it is rather than
                // for a parameter: nobody sets it, and a caller whose own rule wants a different
                // radius re-judges `distanceToTarget` against this one.
                arrivedWithin: tolerance,
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
                  `studiorpc_game_character_read again once it has landed. Aiming at a point where the ` +
                  `ground runs out is the usual way to get here.`,
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
          ...(startedNearTarget && args.target
            ? {
                alreadyAtTarget: args.target,
                alreadyAtNote:
                  `${args.target} was already where the character was when the move started, so there was ` +
                  `nowhere to walk and no approach to judge — pass-through figures are left out rather than ` +
                  `reported against a target the character never approached. A part the character is carrying ` +
                  `moves with it and always reads like this, as does one it is standing on. Whether it is held ` +
                  `is a question for the game's own state, not for a move.`,
              }
            : {}),
          ...(status === "reached" && distanceToTarget !== undefined && !arrived
            ? {
                warning:
                  // Two very different failures share this branch. Falling short of a
                  // tight tolerance is navigation working normally; not travelling at
                  // all is the level having nothing to navigate on.
                  distanceToTarget <= ARRIVAL_TOLERANCE
                    ? `The character stopped ${against(distanceToTarget, tolerance)} units from the target, which is ` +
                      `outside the ${tolerance} units that count as arrival here. Navigation stops the ` +
                      `character a little short of any point, so this distance is normal travel rather than a ` +
                      // "Unproven" without qualification overstates it, and a run said so: endedAt is
                      // exact, so anything measured *from where it stood* is still good evidence. What
                      // is unproven is only what needed the character to be at the point you named.
                      `failed move — but it did not get as close as you needed. Anything that depended on ` +
                      `standing at the point you asked for is unproven; anything you measure from ` +
                      `\`endedAt\` still holds, since that is exactly where it stood — so when the distance ` +
                      `itself is what you are testing, take it from \`endedAt\` rather than from where the ` +
                      `move was aimed.`
                    : `Studio reported "reached" but the character stopped ${Math.round(distanceToTarget)} units ` +
                      `from the target. Path following returns success even when it cannot get there — usually ` +
                      `because the level has no navigation data there, or the target is somewhere a walking ` +
                      `character cannot stand. Aim at ground level near the target, or pick a reachable point.`,
              }
            : {}),
          ...(didNotSetOff
            ? {
                // `movedDistance: 0` is in the reply already and nobody reads it as a cause.
                // Run 76 had this exact reply and reached for `waitedMs` instead, because a
                // 339 ms move was the only thing in it that looked like an anomaly. Naming the
                // cause is cheaper than leaving every caller to infer it from a zero.
                didNotSetOff: true,
                hint: declinedToWalk
                  ? `The character never set off: navigation answered "reached" without moving it, so it ` +
                    `already counts ${Math.round(distanceToTarget ?? 0)} units away as close enough and asking ` +
                    `for the same point again will not make it walk. A short waitedMs here is that, not a fast ` +
                    `walk. To get closer, aim at a point beyond the target so the path crosses it, or step ` +
                    `away first and approach from further off.` +
                    // What that means — content, or unable to get there — is the warning's call, and it
                    // draws the line at a threshold with its own history behind it. Saying it twice, in
                    // two places, with two thresholds, is how the two answers start disagreeing.
                    (blocked ? " Read `warning` for whether this distance is normal travel or a bad target." : "")
                  : `The character never set off: it travelled 0 units, and navigation never reported ` +
                    `reaching anything either. Nothing here was measured at the target — treat whatever you ` +
                    `were testing there as untested rather than as failed. Something is holding it where it ` +
                    `stands, which is what \`blocked\` says; walking is not the way past it.`,
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
                  `than where it ended up — there is no blocked verdict yet. Ask again with a larger ` +
                  `timeoutMs: this is a walk that needed longer than you allowed, and under a slowed clock a ` +
                  `long crossing routinely does.`,
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
