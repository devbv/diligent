// @summary Tool-event reducer helpers for thread-store item lifecycle updates

import { createLogger } from "@diligent/logging";
import type { AgentEvent } from "@diligent/protocol";
import { ToolRenderPayloadSchema } from "@diligent/protocol";
import { findCollabSpawnItem } from "./collab-reducer";
import type { ThreadState } from "./thread-store";
import {
  COLLAB_RENDERED_TOOLS,
  normalizeToolName,
  parsePlanOutput,
  stringifyUnknown,
  updateItem,
} from "./thread-utils";

let toolRenderSeq = 0;
const logger = createLogger({ scope: "web.client.thread-store", context: { component: "collab" } });

function logDroppedChildTool(event: ToolAgentEvent): void {
  logger.debug("child_tool.dropped_spawn_not_found", {
    message: `[ThreadStore][collab-debug] child ${event.type} dropped: spawn item not found`,
    threadId: event.childThreadId,
    fields: {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      toolEventType: event.type,
    },
  });
}

export function nextToolRenderId(itemId: string): string {
  return `item:${itemId}:${++toolRenderSeq}`;
}

function toToolRenderPayload(value: unknown): import("@diligent/protocol").ToolRenderPayload | undefined {
  const parsed = ToolRenderPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function mergeToolRenderPayload(
  started: import("@diligent/protocol").ToolRenderPayload | undefined,
  completed: import("@diligent/protocol").ToolRenderPayload | undefined,
): import("@diligent/protocol").ToolRenderPayload | undefined {
  if (!started) return completed;
  if (!completed) return started;
  return {
    ...completed,
    inputSummary: completed.inputSummary ?? started.inputSummary,
  };
}

export type ToolAgentEvent = Extract<AgentEvent, { type: "tool_start" | "tool_update" | "tool_end" }>;

export function isToolEvent(event: AgentEvent): event is ToolAgentEvent {
  return event.type.startsWith("tool_");
}

export function reduceToolEvent(state: ThreadState, event: ToolAgentEvent): ThreadState {
  switch (event.type) {
    case "tool_start": {
      const normalizedToolName = normalizeToolName(event.toolName);
      if (event.childThreadId) {
        const spawnItem = findCollabSpawnItem(state, event.childThreadId);
        if (!spawnItem) {
          logDroppedChildTool(event);
          return state;
        }
        const childTool = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running" as const,
          isError: false,
          inputText: stringifyUnknown(event.input),
          outputText: "",
          render: ("render" in event ? toToolRenderPayload(event.render) : undefined) ?? undefined,
        };
        const childTimelineEntry = {
          kind: "tool" as const,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running" as const,
          isError: false,
          inputText: stringifyUnknown(event.input),
          outputText: "",
        };
        return updateItem(state, spawnItem.id, (item) =>
          item.kind === "collab" ? upsertChildToolStart(item, childTool, childTimelineEntry) : item,
        );
      }

      if (COLLAB_RENDERED_TOOLS.has(normalizedToolName)) return state;
      const renderId = nextToolRenderId(event.itemId);
      if (state.itemSlots[event.itemId]) return state;
      const now = Date.now();
      return {
        ...state,
        itemSlots: { ...state.itemSlots, [event.itemId]: renderId },
        items: [
          ...state.items,
          {
            id: renderId,
            kind: "tool",
            toolName: event.toolName,
            inputText: stringifyUnknown(event.input),
            outputText: "",
            isError: false,
            status: "streaming",
            timestamp:
              typeof (event as { timestamp?: number }).timestamp === "number"
                ? (event as { timestamp?: number }).timestamp!
                : now,
            toolCallId: event.toolCallId,
            startedAt:
              typeof (event as { startedAt?: number }).startedAt === "number"
                ? (event as { startedAt?: number }).startedAt!
                : now,
            render: ("render" in event ? toToolRenderPayload(event.render) : undefined) ?? undefined,
          },
        ],
      };
    }

    case "tool_update": {
      if (event.childThreadId) {
        const spawnItem = findCollabSpawnItem(state, event.childThreadId);
        if (!spawnItem) {
          logDroppedChildTool(event);
          return state;
        }
        return updateItem(state, spawnItem.id, (item) =>
          item.kind === "collab"
            ? {
                ...item,
                childTools: item.childTools.map((t) =>
                  t.toolCallId === event.toolCallId ? { ...t, outputText: t.outputText + event.partialResult } : t,
                ),
                childTimeline: (item.childTimeline ?? []).map((entry) =>
                  entry.kind === "tool" && entry.toolCallId === event.toolCallId
                    ? { ...entry, outputText: entry.outputText + event.partialResult }
                    : entry,
                ),
              }
            : item,
        );
      }
      const renderId = state.itemSlots[event.itemId];
      if (!renderId) return state;
      return updateItem(state, renderId, (item) =>
        item.kind === "tool" ? { ...item, outputText: item.outputText + event.partialResult } : item,
      );
    }

    case "tool_end": {
      const normalizedToolName = normalizeToolName(event.toolName);
      if (event.childThreadId) {
        const spawnItem = findCollabSpawnItem(state, event.childThreadId);
        if (!spawnItem) {
          logDroppedChildTool(event);
          return state;
        }
        return updateItem(state, spawnItem.id, (item) =>
          item.kind === "collab"
            ? {
                ...item,
                childTools: item.childTools.map((t) =>
                  t.toolCallId === event.toolCallId
                    ? { ...t, status: "done" as const, isError: event.isError, outputText: event.output ?? "" }
                    : t,
                ),
                childTimeline: (item.childTimeline ?? []).map((entry) =>
                  entry.kind === "tool" && entry.toolCallId === event.toolCallId
                    ? {
                        ...entry,
                        status: "done" as const,
                        isError: event.isError,
                        outputText: event.output ?? "",
                      }
                    : entry,
                ),
              }
            : item,
        );
      }

      const slotRenderId = state.itemSlots[event.itemId];
      const renderId =
        slotRenderId ?? state.items.find((i) => i.kind === "tool" && i.toolCallId === event.toolCallId)?.id;
      if (!renderId) return state;

      const { [event.itemId]: _, ...remainingSlots } = state.itemSlots;
      let next = {
        ...updateItem(state, renderId, (current) =>
          current.kind === "tool"
            ? {
                ...current,
                outputText: event.output || current.outputText,
                isError: event.isError,
                status: "done" as const,
                timestamp:
                  typeof (event as { timestamp?: number }).timestamp === "number"
                    ? (event as { timestamp?: number }).timestamp!
                    : current.timestamp,
                durationMs:
                  typeof (event as { durationMs?: number }).durationMs === "number"
                    ? (event as { durationMs?: number }).durationMs!
                    : Date.now() - current.startedAt,
                render: mergeToolRenderPayload(
                  current.render,
                  ("render" in event ? toToolRenderPayload(event.render) : undefined) ?? undefined,
                ),
              }
            : current,
        ),
        itemSlots: remainingSlots,
      };

      if (normalizedToolName === "plan" && event.output) {
        const plan = parsePlanOutput(event.output);
        if (plan) {
          const allResolved = plan.steps.every((s) => s.status === "done" || s.status === "cancelled");
          next = { ...next, planState: allResolved ? null : plan };
        }
      }

      return next;
    }
  }
}

type CollabItem = Extract<ThreadState["items"][number], { kind: "collab" }>;
type ChildTool = CollabItem["childTools"][number];
type ChildTimelineTool = Extract<NonNullable<CollabItem["childTimeline"]>[number], { kind: "tool" }>;

function upsertChildToolStart(
  item: CollabItem,
  childTool: ChildTool,
  childTimelineEntry: ChildTimelineTool,
): CollabItem {
  const childToolExists = item.childTools.some((tool) => tool.toolCallId === childTool.toolCallId);
  const childTimeline = item.childTimeline ?? [];
  const childTimelineExists = childTimeline.some(
    (entry) => entry.kind === "tool" && entry.toolCallId === childTimelineEntry.toolCallId,
  );
  return {
    ...item,
    childTools: childToolExists ? item.childTools : [...item.childTools, childTool],
    childTimeline: childTimelineExists ? childTimeline : [...childTimeline, childTimelineEntry],
  };
}
