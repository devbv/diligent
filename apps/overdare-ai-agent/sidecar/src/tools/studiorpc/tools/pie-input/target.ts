// @summary Reads game.pie.status and resolves the PIE client that input is injected into.

import type { call } from "../../rpc";

export type CallRpc = typeof call;

export interface PieClientSnapshot {
  clientId: string;
  clientIndex: number;
  pieInstance: number;
  processId: number;
  netMode: string;
  ready: boolean;
  injectable: boolean;
}

export interface PieStatusSnapshot {
  protocolVersion: number;
  running: boolean;
  state: string;
  pieSessionId?: string;
  mode: string;
  scope: string;
  clients: PieClientSnapshot[];
  capabilities: {
    multiProcess: boolean;
    crossRequestHeldInput: boolean;
    mouseDeltaRequiresCapture: boolean;
  };
}

export interface PieTarget {
  pieSessionId: string;
  clientId: string;
  status: PieStatusSnapshot;
}

export interface PieTargetOverrides {
  pieSessionId?: string;
  clientId?: string;
}

export const PIE_STATUS_TIMEOUT_MS = 10_000;

export async function readPieStatus(callRpc: CallRpc): Promise<PieStatusSnapshot> {
  const result = (await callRpc("game.pie.status", {}, { timeoutMs: PIE_STATUS_TIMEOUT_MS })) as PieStatusSnapshot;
  return {
    ...result,
    clients: Array.isArray(result?.clients) ? result.clients : [],
  };
}

function describeClients(clients: PieClientSnapshot[]): string {
  if (clients.length === 0) return "no PIE clients are registered";
  return clients
    .map(
      (client) =>
        `${client.clientId} (netMode=${client.netMode}, ready=${client.ready}, injectable=${client.injectable})`,
    )
    .join("; ");
}

/**
 * Resolve the session and client to inject into. Both ids are optional so the
 * model can send input without a preceding status call; explicit ids win, and
 * are validated against the live snapshot so a stale id fails here with a
 * readable message instead of as a Studio error code.
 */
export async function resolvePieTarget(callRpc: CallRpc, overrides: PieTargetOverrides = {}): Promise<PieTarget> {
  const status = await readPieStatus(callRpc);

  if (!status.running) {
    throw new Error(
      `PIE is not running (state=${status.state || "unknown"}). ` +
        "Start play mode with studiorpc_game_play, then retry.",
    );
  }
  if (status.mode !== "singleProcess") {
    throw new Error(
      `PIE runs in ${status.mode} mode; input injection needs singleProcess (unsupportedPieMode). ` +
        "Restart play mode with a single process.",
    );
  }

  const pieSessionId = overrides.pieSessionId ?? status.pieSessionId;
  if (!pieSessionId) {
    throw new Error("game.pie.status returned no pieSessionId, so there is no session to inject into.");
  }
  if (status.pieSessionId && pieSessionId !== status.pieSessionId) {
    throw new Error(
      `pieSessionId "${pieSessionId}" is stale — the live session is "${status.pieSessionId}" (stalePieSession).`,
    );
  }

  const client = overrides.clientId
    ? status.clients.find((candidate) => candidate.clientId === overrides.clientId)
    : status.clients.find((candidate) => candidate.injectable);

  if (!client) {
    const suffix = overrides.clientId ? ` "${overrides.clientId}"` : "";
    throw new Error(`No injectable PIE client${suffix} was found: ${describeClients(status.clients)}.`);
  }
  if (!client.injectable) {
    throw new Error(
      `PIE client "${client.clientId}" is not injectable (ready=${client.ready}, netMode=${client.netMode}).`,
    );
  }

  return { pieSessionId, clientId: client.clientId, status };
}
