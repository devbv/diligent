// @summary Agent-facing play-test tools: PIE status, input injection, and character moveTo.

import { z } from "zod";
import { call } from "../../rpc";
import type { Tool, ToolResult } from "../../types";
import {
  expandShorthand,
  type InputEvent,
  inputEventsSchema,
  MAX_EVENT_COUNT,
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
/** Navigation stops itself about this far out, and will not re-approach from inside it. */
const NAV_STOP_DISTANCE = 50;
/** Still for this long while navigation claims to be running means it is stuck, not slow. */
const MOVE_STALL_MS = 3_000;
/** How far past a point passThrough aims, so the walk crosses it rather than ending on it. */
const PASS_THROUGH_OVERSHOOT = 200;

const targetOverrides = {
  pieSessionId: z
    .string()
    .optional()
    .describe("Session to target. Omit to use the live session reported by game.pie.status."),
  clientId: z.string().optional().describe("PIE client to target. Omit to use the first injectable client."),
};

const injectParams = z.object({
  events: inputEventsSchema,
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
          "thing, and every distance the reply gives you is then measured from a place nothing is. When the " +
          "instance has a Size, arrivalTolerance defaults to its reach from the centre.",
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
        `How close, in world units, counts as arrived. Defaults to ${ARRIVAL_TOLERANCE}, which suits ` +
          "travelling to a place. Set it to the size of the thing you are testing when arriving is the point " +
          "— walking into a trigger volume 40 units across is not proven by stopping 150 units away.",
      ),
    passThrough: z
      .boolean()
      .optional()
      .describe(
        "Walk through the position rather than up to it. Navigation stops short of wherever it is sent, so a " +
          "move aimed at a trigger volume stops beside it without setting it off; this aims far enough past the " +
          "point, along the line the character is already approaching on, that the path crosses it. Use it " +
          "whenever the point of the move is to touch something rather than to arrive somewhere. " +
          "The reply then reports `passedWithin` — how near the walk came, at its closest, to the position you " +
          "asked for rather than to the point it was aimed at — and `crossed`, which is that measured against " +
          "arrivalTolerance. Read those two, not distanceToTarget: distanceToTarget says where the character " +
          "came to rest, which for a pass-through is deliberately past the target and so is large even when the " +
          "crossing worked.",
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
  character?: { CFrame?: { Position?: { X?: number; Y?: number; Z?: number } } };
}

/**
 * Where the character actually is, or undefined if it cannot be read. Studio
 * reports `reached` whenever path following returns success, which a level with
 * no navigation data can do without the character having gone anywhere — so the
 * move tools quote the distance that is left rather than the claim alone.
 */
async function readCharacterPosition(callRpc: CallRpc): Promise<{ x: number; y: number; z: number } | undefined> {
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
    return { x: position.X, y: position.Y, z: position.Z };
  } catch {
    return undefined;
  }
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
): Promise<{ position: { x: number; y: number; z: number }; reach?: number } | undefined> {
  const result = (await callRpc("game.instance.read", { name }, { timeoutMs: MOVE_RPC_TIMEOUT_MS })) as LiveInstance;
  const position = result?.instance?.CFrame?.Position;
  if (typeof position?.X !== "number" || typeof position?.Y !== "number" || typeof position?.Z !== "number") {
    return undefined;
  }
  const size = result?.instance?.Size;
  const largest = size ? Math.max(size.X ?? 0, size.Y ?? 0, size.Z ?? 0) : 0;
  return {
    position: { x: position.X, y: position.Y, z: position.Z },
    reach: largest > 0 ? largest / 2 : undefined,
  };
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
      "play test is live; the other play-test tools resolve their target on their own.",
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
      "Limits: at most 64 events, at most 10s of total wait, and every key or button pressed must be " +
      "released inside the same batch. Example — walk forward for half a second: " +
      '[{"type":"key","key":"W","action":"press","durationMs":500}]. ' +
      "To click a UI button, read its rect from studiorpc_game_ui_browse, pointerMove to the center of that " +
      "rect, then press the left pointerButton — that fires the button's Activated exactly as a real click " +
      "does, so never ask the user to press a button you can reach yourself. " +
      "The batch is cancelled with interruptedByUser if the person at the machine takes the play test back " +
      "— a key while it holds focus, or a click inside its viewport. Their typing in another window does " +
      "not count. Retry the batch; the input was released. " +
      "appliedEventCount reports the batch Studio ran, which is the expanded one: each press becomes " +
      "down/wait/up, so it exceeds the number of events you wrote. The reply gives authoredEventCount and " +
      "sentEventCount so the two are never confused.",
    parameters: injectParams,
    async execute(args: InjectParams): Promise<ToolResult> {
      const events = args.events as InputEvent[];
      // Studio has no press action, so expand before validating — the limits it
      // enforces apply to what actually reaches it, not to what was authored.
      const sent = expandShorthand(events);
      if (sent.length > MAX_EVENT_COUNT) {
        throw new Error(
          `The batch expands to ${sent.length} events, above Studio's ${MAX_EVENT_COUNT} limit ` +
            `(each press with a durationMs becomes three). Split the input across several calls.`,
        );
      }
      const batchError = validateBatch(sent);
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
async function pollMoveStatus(
  callRpc: CallRpc,
  pieSessionId: string,
  requestId: string,
  timeoutMs: number,
): Promise<{ status: string | undefined; waitedMs: number; timedOut: boolean; stalled: boolean }> {
  const startedAt = Date.now();
  let status: string | undefined;
  let stillSince: number | undefined;
  let lastPosition: { x: number; y: number; z: number } | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(MOVE_POLL_INTERVAL_MS);
    const result = (await callRpc(
      "game.character.moveStatus",
      { pieSessionId, requestId },
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as MoveStatusResult;
    status = result?.status;
    if (isTerminalMoveStatus(status)) {
      return { status, waitedMs: Date.now() - startedAt, timedOut: false, stalled: false };
    }

    const position = await readCharacterPosition(callRpc);
    if (position) {
      const still = lastPosition !== undefined && distanceBetween(position, lastPosition) <= MOVED_AT_ALL;
      stillSince = still ? (stillSince ?? Date.now()) : undefined;
      lastPosition = position;
      if (stillSince !== undefined && Date.now() - stillSince >= MOVE_STALL_MS) {
        return { status, waitedMs: Date.now() - startedAt, timedOut: false, stalled: true };
      }
    }
  }

  return { status, waitedMs: Date.now() - startedAt, timedOut: true, stalled: false };
}

function createCharacterMoveToTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_character_move_to",
    description:
      "Walk the play-test character to a world position, or to a named instance, using its own navigation " +
      "instead of steering it with key events. Naming the target is the safer form: the tool reads where the " +
      "thing actually is and sizes the tolerance to it, where typed coordinates invite an invented height " +
      "that aims at empty air above it. " +
      "Read `arrived`, not `status`: Studio reports `reached` whenever its path following " +
      "returns success, which it does even when it could not get there, so the tool measures where the " +
      `character actually stopped. \`arrived\` is true within \`arrivalTolerance\` units of the target and ` +
      `appears once the move is over, so a reply without it is one that has not finished. ` +
      `\`arrivalTolerance\` is ${ARRIVAL_TOLERANCE} by default and echoed back in the response; pass a ` +
      "smaller one when you are testing whether the character reached a specific small thing rather than " +
      "merely got there. " +
      "`distanceToTarget` is how far the character finished from the place you asked for, and `endedAt` is " +
      "where that was; a still-running move reports `at` instead, because it has not ended anywhere yet. " +
      "`moved` and `movedDistance` say whether it travelled at all, which separates a move that was " +
      "unnecessary — already inside the tolerance — from one that went nowhere. `blocked` means the move " +
      "finished without getting there and navigation did not choose to stop: something is in the way, or the " +
      "target is somewhere a walking character cannot stand. A character that walked most of the way and then " +
      "hit a wall is blocked just as much as one that never set off, so read `blocked` with `movedDistance` to " +
      "see where it got stuck. " +
      "Pass wait: false to return the requestId immediately and poll with " +
      "studiorpc_game_character_move_status yourself.",
    parameters: moveToParams,
    async execute(args: MoveToParams): Promise<ToolResult> {
      const target = await resolvePieTarget(callRpc, args);
      const named = args.targetName ? await readLiveInstance(callRpc, args.targetName) : undefined;
      if (args.targetName && !named) {
        throw new Error(
          `No instance named "${args.targetName}" is in the running Workspace, so there is nowhere to walk to. ` +
            `Call studiorpc_game_instance_read with no arguments to see what is there.`,
        );
      }
      const wantedPosition = named?.position ?? args.position;
      if (!wantedPosition) throw new Error("Pass either position or targetName to say where to walk.");
      // Where it began, so the reply can say whether the character travelled at all.
      // Two moves that end on the same spot look like a no-op otherwise.
      const startedFrom = await readCharacterPosition(callRpc);
      // Aiming past the point is what makes the path cross it. Distances stay in the
      // horizontal plane: the overshoot is about where the character walks, and
      // borrowing the target's height would send it at the floor or the ceiling.
      const destination =
        args.passThrough && startedFrom
          ? overshootPast(startedFrom, wantedPosition, PASS_THROUGH_OVERSHOOT)
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
      const polled = await pollMoveStatus(callRpc, target.pieSessionId, requestId, timeoutMs);
      const status = polled.status ?? started?.status;

      // Check the claim rather than repeat it: a level without navigation data can
      // report `reached` with the character still standing where it started.
      const endedAt = await readCharacterPosition(callRpc);
      const distanceToTarget = endedAt ? distanceBetween(endedAt, wantedPosition) : undefined;
      // A named target knows its own size, so "close enough to have touched it" is a
      // measurement rather than the caller's guess.
      const tolerance = args.arrivalTolerance ?? named?.reach ?? ARRIVAL_TOLERANCE;
      // A pass-through succeeds by crossing the target, so judge the path, not the
      // stopping place — it is meant to end beyond the thing it was sent over.
      const passedWithin =
        args.passThrough && startedFrom && endedAt ? closestApproach(startedFrom, endedAt, wantedPosition) : undefined;
      const arrived =
        passedWithin !== undefined
          ? passedWithin <= tolerance
          : distanceToTarget !== undefined && distanceToTarget <= tolerance;
      const movedDistance = startedFrom && endedAt ? distanceBetween(startedFrom, endedAt) : undefined;
      const moved = movedDistance !== undefined && movedDistance > MOVED_AT_ALL;
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

      return {
        output: jsonOutput({
          requestId,
          status,
          // The field the description tells callers to read, which it did not emit for
          // a long time — leaving them to recompute it from distance and tolerance.
          ...(settled ? { arrived } : {}),
          // `status` stays whatever navigation last said, which is `running` for a
          // character that stopped moving; this says the wait was cut short on purpose.
          ...(polled.stalled ? { stalled: true } : {}),
          clientId: target.clientId,
          waitedMs: polled.waitedMs,
          // distanceToTarget stays measured from the point you asked about, not the
          // one it was aimed at, so passThrough does not quietly move the goalposts.
          ...(named ? { targetPosition: named.position } : {}),
          ...(destination !== wantedPosition ? { aimedAt: destination } : {}),
          ...(passedWithin !== undefined
            ? {
                passedWithin: Math.round(passedWithin),
                crossed: arrived,
                passThroughNote:
                  `passedWithin is the closest the walk came to the position you asked for; ` +
                  `distanceToTarget below is where the character came to rest, which is past it on purpose.`,
              }
            : {}),
          ...(endedAt
            ? {
                [settled ? "endedAt" : "at"]: endedAt,
                distanceToTarget: Math.round(distanceToTarget ?? 0),
                arrivalTolerance: tolerance,
              }
            : {}),
          ...(movedDistance !== undefined
            ? { moved, movedDistance: Math.round(movedDistance), ...(settled ? { blocked } : {}) }
            : {}),
          ...(status === "reached" && distanceToTarget !== undefined && !arrived
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
          ...(polled.stalled
            ? {
                note:
                  `Navigation still reports "${status}", but the character has not moved for ` +
                  `${MOVE_STALL_MS / 1000} seconds, so it is stuck rather than slow and the wait was cut short. ` +
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
        render: buildMoveToRender(target, wantedPosition, requestId, status, polled.waitedMs),
        metadata: {
          tool: "studiorpc_game_character_move_to",
          clientId: target.clientId,
          requestId,
          status,
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
