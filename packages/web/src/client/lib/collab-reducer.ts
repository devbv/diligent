// @summary Collab-specific thread-store reducer helpers and event handling

import type { AgentEvent, AssistantMessage } from "@diligent/protocol";
import type { RenderItem, ThreadState } from "./thread-store";
import { stringifyUnknown, updateItem, withItem } from "./thread-utils";

/** Find the most recent collab spawn RenderItem for a given childThreadId. */
export function findCollabSpawnItem(
  state: ThreadState,
  childThreadId: string,
): Extract<RenderItem, { kind: "collab" }> | undefined {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind === "collab" && item.eventType === "spawn" && item.childThreadId === childThreadId) {
      return item;
    }
  }
  return undefined;
}

/** Update the latest spawn item's status for a child thread. */
function updateCollabSpawnStatus(
  state: ThreadState,
  childThreadId: string,
  status: string,
  message?: string,
): ThreadState {
  const spawnItem = findCollabSpawnItem(state, childThreadId);
  if (!spawnItem) return state;
  return updateItem(state, spawnItem.id, (item) =>
    item.kind === "collab" && item.eventType === "spawn"
      ? {
          ...item,
          status,
          message: message ?? item.message,
        }
      : item,
  );
}

function normalizeSpawnStatusFromWait(status: string, timedOut: boolean): string {
  if (status === "pending") return "running";
  if (timedOut && status === "running") return "running";
  return status;
}

export function appendChildAssistantTimelineStart(
  state: ThreadState,
  childThreadId: string,
  itemId?: string,
): ThreadState {
  const spawnItem = findCollabSpawnItem(state, childThreadId);
  if (!spawnItem) return state;
  return updateItem(state, spawnItem.id, (item) =>
    item.kind === "collab" ? appendAssistantTimelineStartToItem(item, itemId) : item,
  );
}

export function appendChildAssistantTimelineDelta(
  state: ThreadState,
  childThreadId: string,
  delta: string,
): ThreadState {
  const spawnItem = findCollabSpawnItem(state, childThreadId);
  if (!spawnItem) return state;
  return updateItem(state, spawnItem.id, (item) => {
    if (item.kind !== "collab") return item;
    const timeline = [...(item.childTimeline ?? [])];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const entry = timeline[i];
      if (entry.kind === "assistant") {
        timeline[i] = { ...entry, message: entry.message + delta };
        return { ...item, childTimeline: timeline };
      }
    }
    timeline.push({ kind: "assistant" as const, message: delta });
    return { ...item, childTimeline: timeline };
  });
}

type CollabItem = Extract<ThreadState["items"][number], { kind: "collab" }>;

function appendAssistantTimelineStartToItem(item: CollabItem, itemId?: string): CollabItem {
  const timeline = item.childTimeline ?? [];
  if (itemId && timeline.some((entry) => entry.kind === "assistant" && entry.itemId === itemId)) return item;
  return {
    ...item,
    childTimeline: [...timeline, { kind: "assistant" as const, itemId, message: "" }],
  };
}

export function finalizeChildAssistantTimeline(
  state: ThreadState,
  childThreadId: string,
  message: AssistantMessage,
): ThreadState {
  const spawnItem = findCollabSpawnItem(state, childThreadId);
  if (!spawnItem) return state;
  const finalRaw = stringifyUnknown(message);
  return updateItem(state, spawnItem.id, (item) => {
    if (item.kind !== "collab") return item;
    const timeline = [...(item.childTimeline ?? [])];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const entry = timeline[i];
      if (entry.kind === "assistant") {
        timeline[i] = { ...entry, message: finalRaw };
        return { ...item, childTimeline: timeline };
      }
    }
    timeline.push({ kind: "assistant" as const, message: finalRaw });
    return { ...item, childTimeline: timeline };
  });
}

export type CollabAgentEvent = Extract<
  AgentEvent,
  {
    type:
      | "collab_spawn_begin"
      | "collab_spawn_end"
      | "collab_wait_begin"
      | "collab_wait_end"
      | "collab_close_begin"
      | "collab_close_end"
      | "collab_interaction_begin"
      | "collab_interaction_end";
  }
>;

export function isCollabEvent(event: AgentEvent): event is CollabAgentEvent {
  return event.type.startsWith("collab_");
}

export function reduceCollabEvent(state: ThreadState, event: CollabAgentEvent): ThreadState {
  switch (event.type) {
    case "collab_spawn_begin": {
      const renderId = `collab:spawn:${event.callId}`;
      return withItem(state, renderId, {
        id: renderId,
        kind: "collab",
        eventType: "spawn",
        childThreadId: event.callId,
        agentType: event.agentType,
        prompt: event.prompt,
        status: "running",
        childTools: [],
        childTimeline: [],
        timestamp: Date.now(),
      });
    }

    case "collab_spawn_end": {
      const renderId = `collab:spawn:${event.callId}`;
      const existing = findCollabSpawnItem(state, event.childThreadId);
      if (existing) {
        return updateItem(state, existing.id, (item) =>
          item.kind === "collab" && item.eventType === "spawn"
            ? {
                ...item,
                childThreadId: event.childThreadId,
                nickname: event.nickname,
                agentType: event.agentType ?? item.agentType,
                description: event.description,
                prompt: event.prompt,
                status: event.status,
                message: event.message,
                childTimeline: item.childTimeline ?? [],
              }
            : item,
        );
      }
      return withItem(state, renderId, {
        id: renderId,
        kind: "collab",
        eventType: "spawn",
        childThreadId: event.childThreadId,
        nickname: event.nickname,
        agentType: event.agentType,
        description: event.description,
        prompt: event.prompt,
        status: event.status,
        message: event.message,
        childTools: [],
        childTimeline: [],
        timestamp: Date.now(),
      });
    }

    case "collab_wait_begin": {
      const renderId = `collab:wait:${event.callId}`;
      return withItem(state, renderId, {
        id: renderId,
        kind: "collab",
        eventType: "wait",
        status: "running",
        agents: event.agents.map((agent) => ({
          threadId: agent.threadId,
          nickname: agent.nickname,
          status: "running",
          message: undefined,
        })),
        timedOut: false,
        childTools: [],
        timestamp: Date.now(),
      });
    }

    case "collab_wait_end": {
      const renderId = `collab:wait:${event.callId}`;
      const waitItem = state.items.find((item) => item.kind === "collab" && item.id === renderId);
      let next = waitItem
        ? updateItem(state, renderId, (item) =>
            item.kind === "collab" && item.eventType === "wait"
              ? {
                  ...item,
                  status: event.timedOut ? "running" : "completed",
                  agents: event.agentStatuses.map((a) => ({
                    threadId: a.threadId,
                    nickname: a.nickname,
                    status: a.status,
                    message: a.message,
                  })),
                  timedOut: event.timedOut,
                }
              : item,
          )
        : withItem(state, renderId, {
            id: renderId,
            kind: "collab",
            eventType: "wait",
            status: event.timedOut ? "running" : "completed",
            agents: event.agentStatuses.map((a) => ({
              threadId: a.threadId,
              nickname: a.nickname,
              status: a.status,
              message: a.message,
            })),
            timedOut: event.timedOut,
            childTools: [],
            timestamp: Date.now(),
          });

      for (const agent of event.agentStatuses) {
        next = updateCollabSpawnStatus(
          next,
          agent.threadId,
          normalizeSpawnStatusFromWait(agent.status, event.timedOut),
          agent.message,
        );
      }
      return next;
    }

    case "collab_close_begin":
      return state;

    case "collab_close_end": {
      const renderId = `collab:close:${event.callId}`;
      let next = withItem(state, renderId, {
        id: renderId,
        kind: "collab",
        eventType: "close",
        childThreadId: event.childThreadId,
        nickname: event.nickname,
        status: event.status,
        message: event.message,
        childTools: [],
        timestamp: Date.now(),
      });

      next = updateCollabSpawnStatus(next, event.childThreadId, event.status, event.message);
      return next;
    }

    case "collab_interaction_begin":
      return state;

    case "collab_interaction_end": {
      const renderId = `collab:interaction:${event.callId}`;
      return withItem(state, renderId, {
        id: renderId,
        kind: "collab",
        eventType: "interaction",
        childThreadId: event.receiverThreadId,
        nickname: event.receiverNickname,
        message: event.prompt,
        status: event.status,
        childTools: [],
        timestamp: Date.now(),
      });
    }
  }
}
