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

const moveToParams = z.object({
  position: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .describe("World-space destination in Unreal units."),
  wait: z.boolean().optional().describe("Poll game.character.moveStatus until the move ends. Defaults to true."),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(MOVE_WAIT_MAX_MS)
    .optional()
    .describe(`How long to poll when wait is true. Defaults to ${MOVE_WAIT_DEFAULT_MS}ms.`),
  ...targetOverrides,
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
      "does, so never ask the user to press a button you can reach yourself.",
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
        output: jsonOutput({ ...result, clientId: target.clientId, events: describeEvents(events, events.length) }),
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

async function pollMoveStatus(
  callRpc: CallRpc,
  pieSessionId: string,
  requestId: string,
  timeoutMs: number,
): Promise<{ status: string | undefined; waitedMs: number; timedOut: boolean }> {
  const startedAt = Date.now();
  let status: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(MOVE_POLL_INTERVAL_MS);
    const result = (await callRpc(
      "game.character.moveStatus",
      { pieSessionId, requestId },
      { timeoutMs: MOVE_RPC_TIMEOUT_MS },
    )) as MoveStatusResult;
    status = result?.status;
    if (isTerminalMoveStatus(status)) {
      return { status, waitedMs: Date.now() - startedAt, timedOut: false };
    }
  }

  return { status, waitedMs: Date.now() - startedAt, timedOut: true };
}

function createCharacterMoveToTool(callRpc: CallRpc): Tool {
  return {
    name: "studiorpc_game_character_move_to",
    description:
      "Walk the play-test character to a world position using its own navigation, instead of steering it with " +
      "key events. By default the tool polls until the move ends and reports the outcome — reached, " +
      "interrupted, timedOut, superseded, cancelled, failed, or pieEnded. Pass wait: false to return the " +
      "requestId immediately and poll with studiorpc_game_character_move_status yourself.",
    parameters: moveToParams,
    async execute(args: MoveToParams): Promise<ToolResult> {
      const target = await resolvePieTarget(callRpc, args);
      const started = (await callRpc(
        "game.character.moveTo",
        { pieSessionId: target.pieSessionId, clientId: target.clientId, position: args.position },
        { timeoutMs: MOVE_RPC_TIMEOUT_MS },
      )) as MoveToResult;

      const requestId = started?.requestId ?? "";
      const shouldWait = args.wait ?? true;
      if (!shouldWait || !requestId) {
        return {
          output: jsonOutput({ ...started, clientId: target.clientId }),
          render: buildMoveToRender(target, args.position, requestId, started?.status, undefined),
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

      return {
        output: jsonOutput({
          requestId,
          status,
          clientId: target.clientId,
          waitedMs: polled.waitedMs,
          ...(polled.timedOut
            ? { note: `Still moving after ${timeoutMs}ms; poll studiorpc_game_character_move_status for the outcome.` }
            : {}),
        }),
        render: buildMoveToRender(target, args.position, requestId, status, polled.waitedMs),
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
      "and pieEnded are final.",
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

      return {
        output: jsonOutput(result),
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
