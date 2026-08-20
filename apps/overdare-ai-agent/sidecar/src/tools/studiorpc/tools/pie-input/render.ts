// @summary Render payloads for the PIE play-test input tools.

import type { ToolRenderPayload } from "../../types";
import type { InputEvent } from "./events";
import type { PieStatusSnapshot, PieTarget } from "./target";

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

function describeUntil(until: NonNullable<Extract<InputEvent, { type: "wait" }>["until"]>): string {
  if ("log" in until) return `log "${until.log}"`;
  if ("ui" in until) {
    if (until.textEquals !== undefined) return `${until.ui} = "${until.textEquals}"`;
    if (until.textContains !== undefined) return `${until.ui} ~ "${until.textContains}"`;
    if (until.onScreen !== undefined) return `${until.ui} onScreen = ${until.onScreen}`;
    return `${until.ui} visible = ${until.visible}`;
  }
  if ("exists" in until) return `${until.instance} exists = ${until.exists}`;
  const value = until.equals ?? until.atLeast ?? until.atMost;
  const operator = until.equals !== undefined ? "=" : until.atLeast !== undefined ? "≥" : "≤";
  return `${until.instance}.${until.property} ${operator} ${value}`;
}

export function describeEvent(event: InputEvent): string {
  switch (event.type) {
    case "key":
      return `${event.key} ${event.action}`;
    case "pointerButton":
      return event.target === undefined
        ? `${event.button} button ${event.action}`
        : `${event.button} button ${event.action} on ${event.target}`;
    case "pointerMove":
      return event.position === undefined
        ? `move to ${event.target}`
        : `move to (${event.position.x}, ${event.position.y})`;
    case "look":
      return `look yaw ${event.yawDegrees ?? 0}° pitch ${event.pitchDegrees ?? 0}°`;
    case "mouseDelta":
      return `mouse Δ(${event.delta.x}, ${event.delta.y})`;
    case "scroll":
      return `scroll ${event.delta > 0 ? "+" : ""}${event.delta}`;
    case "wait":
      return event.until === undefined ? `wait ${event.durationMs}ms` : `wait for ${describeUntil(event.until)}`;
  }
}
export function describeEvents(events: InputEvent[], maxParts = 4): string {
  const parts = events.slice(0, maxParts).map(describeEvent);
  const rest = events.length - parts.length;
  return rest > 0 ? `${parts.join(" → ")} +${rest} more` : parts.join(" → ");
}

export function buildPieStatusRender(status: PieStatusSnapshot): ToolRenderPayload {
  const injectable = status.clients.filter((client) => client.injectable);
  return {
    inputSummary: "pie status",
    outputSummary: status.running ? `running, ${injectable.length}/${status.clients.length} injectable` : "not running",
    blocks: [
      {
        type: "key_value",
        title: "Play-in-editor session",
        items: [{ key: "pieSessionId", value: status.pieSessionId ?? "-" }],
      },
      ...(status.clients.length > 0
        ? [
            {
              type: "table" as const,
              title: "Clients",
              columns: ["clientId", "injectable", "targeted"],
              rows: status.clients.map((client) => [
                client.clientId,
                String(client.injectable),
                String(client.targeted ?? false),
              ]),
            },
          ]
        : []),
      {
        type: "summary",
        text: status.running ? "PIE is running." : "PIE is not running.",
        tone: status.running ? "success" : "warning",
      },
    ],
  };
}

export function buildInputInjectRender(
  target: PieTarget,
  events: InputEvent[],
  appliedEventCount: number | undefined,
  sentEventCount: number = events.length,
): ToolRenderPayload {
  const summary = describeEvents(events);
  return {
    inputSummary: summary,
    outputSummary: `applied ${appliedEventCount ?? sentEventCount}/${sentEventCount} events`,
    blocks: [
      {
        type: "key_value",
        title: "Play-test input",
        items: [
          { key: "clientId", value: target.clientId },
          { key: "events", value: String(sentEventCount) },
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

export function buildMoveRouteRender(
  target: PieTarget,
  waypointCount: number,
  completedWaypoints: number,
  outcome: string,
  waitedMs: number,
): ToolRenderPayload {
  const complete = completedWaypoints === waypointCount && outcome === "arrived";
  return {
    inputSummary: `moveTo route with ${waypointCount} waypoints`,
    outputSummary: `${completedWaypoints}/${waypointCount} waypoints, ${outcome} after ${waitedMs}ms`,
    blocks: [
      {
        type: "key_value",
        title: "Character moveTo route",
        items: [
          { key: "clientId", value: target.clientId },
          { key: "waypoints", value: `${completedWaypoints}/${waypointCount}` },
          { key: "outcome", value: outcome },
        ],
      },
      {
        type: "summary",
        text: complete ? "All waypoints reached in order." : `Route stopped after ${completedWaypoints} waypoints.`,
        tone: complete ? "success" : "warning",
      },
    ],
  };
}
