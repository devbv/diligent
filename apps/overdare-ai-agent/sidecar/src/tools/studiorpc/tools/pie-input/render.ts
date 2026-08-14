// @summary Render payloads for the PIE play-test input tools.

import type { ToolRenderPayload } from "../../types";
import type { InputEvent } from "./events";
import type { PieStatusSnapshot, PieTarget } from "./target";

/** moveTo statuses Studio never leaves; anything else is still in flight. */
const TERMINAL_MOVE_STATUSES = new Set([
  "reached",
  "interrupted",
  "timedOut",
  "superseded",
  "cancelled",
  "failed",
  "pieEnded",
]);

export function isTerminalMoveStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_MOVE_STATUSES.has(status);
}

function moveTone(status: string | undefined): "success" | "warning" | "info" {
  if (status === "reached") return "success";
  if (isTerminalMoveStatus(status)) return "warning";
  return "info";
}

export function describeEvent(event: InputEvent): string {
  switch (event.type) {
    case "key":
      return `${event.key} ${event.action}`;
    case "pointerButton":
      return `${event.button} button ${event.action}`;
    case "pointerMove":
      return `move to (${event.position.x}, ${event.position.y})`;
    case "mouseDelta":
      return `mouse Δ(${event.delta.x}, ${event.delta.y})`;
    case "wait":
      return `wait ${event.durationMs}ms`;
  }
}

/** One-line event summary; long batches keep the head and a remainder count. */
export function describeEvents(events: InputEvent[], maxParts = 4): string {
  const parts = events.slice(0, maxParts).map(describeEvent);
  const rest = events.length - parts.length;
  return rest > 0 ? `${parts.join(" → ")} +${rest} more` : parts.join(" → ");
}

export function buildPieStatusRender(status: PieStatusSnapshot): ToolRenderPayload {
  const injectable = status.clients.filter((client) => client.injectable);
  return {
    inputSummary: "pie status",
    outputSummary: status.running
      ? `${status.state}, ${injectable.length}/${status.clients.length} injectable`
      : `not running (${status.state || "unknown"})`,
    blocks: [
      {
        type: "key_value",
        title: "Play-in-editor session",
        items: [
          { key: "state", value: status.state || "unknown" },
          { key: "mode", value: status.mode ?? "" },
          { key: "pieSessionId", value: status.pieSessionId ?? "-" },
        ].filter((item) => item.value.length > 0),
      },
      ...(status.clients.length > 0
        ? [
            {
              type: "table" as const,
              title: "Clients",
              columns: ["clientId", "netMode", "ready", "injectable"],
              rows: status.clients.map((client) => [
                client.clientId,
                client.netMode,
                String(client.ready),
                String(client.injectable),
              ]),
            },
          ]
        : []),
      {
        type: "summary",
        text: status.running ? `PIE is running (${status.state}).` : "PIE is not running.",
        tone: status.running ? "success" : "warning",
      },
    ],
  };
}

export function buildInputInjectRender(
  target: PieTarget,
  events: InputEvent[],
  appliedEventCount: number | undefined,
): ToolRenderPayload {
  const summary = describeEvents(events);
  return {
    inputSummary: summary,
    outputSummary: `applied ${appliedEventCount ?? events.length}/${events.length} events`,
    blocks: [
      {
        type: "key_value",
        title: "Play-test input",
        items: [
          { key: "clientId", value: target.clientId },
          { key: "events", value: String(events.length) },
        ],
      },
      { type: "summary", text: summary, tone: "success" },
    ],
  };
}

export function buildMoveToRender(
  target: PieTarget,
  position: { x: number; y: number; z: number },
  requestId: string,
  status: string | undefined,
  waitedMs: number | undefined,
): ToolRenderPayload {
  const where = `(${position.x}, ${position.y}, ${position.z})`;
  return {
    inputSummary: `moveTo ${where}`,
    outputSummary: waitedMs === undefined ? `started: ${status ?? "pendingStart"}` : `${status} after ${waitedMs}ms`,
    blocks: [
      {
        type: "key_value",
        title: "Character moveTo",
        items: [
          { key: "clientId", value: target.clientId },
          { key: "position", value: where },
          { key: "requestId", value: requestId },
          { key: "status", value: status ?? "pendingStart" },
        ],
      },
      { type: "summary", text: `moveTo ${where}: ${status ?? "pendingStart"}`, tone: moveTone(status) },
    ],
  };
}

export function buildMoveStatusRender(requestId: string, status: string | undefined): ToolRenderPayload {
  return {
    inputSummary: `moveStatus ${requestId}`,
    outputSummary: status ?? "unknown",
    blocks: [{ type: "summary", text: `moveTo ${requestId}: ${status ?? "unknown"}`, tone: moveTone(status) }],
  };
}
