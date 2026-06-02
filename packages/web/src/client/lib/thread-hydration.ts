// @summary Hydrates web thread render state from thread/read payload history

import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  ProtocolNotificationAdapter,
  type ThreadItem,
  type ThreadReadResponse,
} from "@diligent/protocol";
import type { PlanState, ThreadState } from "./thread-store";
import { reduceServerNotification } from "./thread-store";
import { normalizeToolName, parsePlanOutput, updateItem, withItem, zeroUsage } from "./thread-utils";
import { getUserFacingErrorMessage } from "./user-facing-errors";

function parseSpawnOutput(output: string): { threadId?: string; nickname?: string } {
  try {
    const parsed = JSON.parse(output) as { thread_id?: string; nickname?: string };
    return { threadId: parsed.thread_id, nickname: parsed.nickname };
  } catch {
    return {};
  }
}

function parseWaitOutput(
  output: string,
): { agents: Array<{ threadId: string; status?: string; message?: string }>; timedOut: boolean } | null {
  try {
    const parsed = JSON.parse(output) as {
      status?: Record<string, { kind?: string; output?: string; error?: string }>;
      timed_out?: boolean;
    };
    if (!parsed.status) return null;
    const agents = Object.entries(parsed.status).map(([threadId, s]) => ({
      threadId,
      status: s.kind,
      message: s.output ?? s.error,
    }));
    return { agents, timedOut: parsed.timed_out ?? false };
  } catch {
    return null;
  }
}

function parseCloseOutput(output: string): { threadId?: string; nickname?: string; status?: string } {
  try {
    const parsed = JSON.parse(output) as { thread_id?: string; nickname?: string; final_status?: { kind?: string } };
    return { threadId: parsed.thread_id, nickname: parsed.nickname, status: parsed.final_status?.kind };
  } catch {
    return {};
  }
}

function setSpawnStatus(state: ThreadState, threadId: string, status: string): ThreadState {
  const spawn = state.items
    .filter((item) => item.kind === "collab" && item.eventType === "spawn" && item.childThreadId === threadId)
    .at(-1);
  if (!spawn || spawn.kind !== "collab") return state;
  return updateItem(state, spawn.id, (item) =>
    item.kind === "collab" && item.eventType === "spawn" ? { ...item, status } : item,
  );
}

function isFinalCollabStatus(status: string | undefined): status is string {
  return status === "completed" || status === "errored" || status === "shutdown";
}

function hydrateFromSnapshotItems(state: ThreadState, payload: ThreadReadResponse): ThreadState {
  const adapter = new ProtocolNotificationAdapter();

  const spawnToolCallToThreadId = new Map<string, string>();
  const childNicknameByThreadId = new Map<string, string>();

  let current: ThreadState = {
    ...state,
    activeThreadCwd: payload.cwd,
    items: [],
    seenKeys: {},
    itemSlots: {},
    pendingSteers: [],
    activeTurnId: null,
    activeTurnStartedAt: null,
    activeReasoningStartedAt: null,
    activeReasoningDurationMs: 0,
    threadStatus: payload.isRunning ? "busy" : "idle",
    planState: null,
    isCompacting: false,
    usage: { ...zeroUsage },
    currentContextTokens: 0,
  };

  const applyItem = (method: "item/started" | "item/completed", item: ThreadItem): void => {
    const notification = {
      method,
      params: {
        threadId: state.activeThreadId ?? "hydrate",
        turnId: "hydrate",
        item,
      },
    } as const;
    const events = adapter.toAgentEvents(notification);
    current = reduceServerNotification(current, notification, events);
  };

  for (const error of payload.errors ?? []) {
    current = withItem(current, `history:error:${error.id}`, {
      id: `history:error:${error.id}`,
      kind: "error",
      message: getUserFacingErrorMessage(error.error),
      name: error.error.name,
      fatal: error.fatal,
      turnId: error.turnId,
      timestamp: Date.parse(error.timestamp),
      providerErrorType: error.error.providerErrorType,
    });
  }

  for (const item of payload.items) {
    if (item.type === "userMessage") {
      const event = {
        type: "user_message" as const,
        itemId: item.itemId,
        message: item.message,
      };
      const notification = {
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT,
        params: {
          threadId: state.activeThreadId ?? "hydrate",
          turnId: "hydrate",
          event,
        },
      } as const;
      current = reduceServerNotification(current, notification, [event]);
      continue;
    }

    if (item.type === "agentMessage") {
      const usage = item.message.usage;
      const turnContextTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      current = {
        ...current,
        usage: {
          ...current.usage,
          inputTokens: current.usage.inputTokens + usage.inputTokens,
          outputTokens: current.usage.outputTokens + usage.outputTokens,
          cacheReadTokens: current.usage.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: current.usage.cacheWriteTokens + usage.cacheWriteTokens,
        },
        currentContextTokens: turnContextTokens > 0 ? turnContextTokens : current.currentContextTokens,
      };
      applyItem("item/started", item);
      applyItem("item/completed", item);
      continue;
    }

    if (item.type === "toolCall") {
      const normalizedToolName = normalizeToolName(item.toolName);

      if (normalizedToolName === "spawn_agent" && typeof item.output === "string") {
        const spawn = parseSpawnOutput(item.output);
        const childThreadId = spawn.threadId;
        if (childThreadId) {
          spawnToolCallToThreadId.set(item.toolCallId, childThreadId);
          if (spawn.nickname) {
            childNicknameByThreadId.set(childThreadId, spawn.nickname);
          }
        }
        current = withItem(current, `history:collab:spawn:${item.toolCallId}`, {
          id: `history:collab:spawn:${item.toolCallId}`,
          kind: "collab",
          eventType: "spawn",
          childThreadId,
          nickname: spawn.nickname,
          agentType:
            typeof (item.input as { agent_type?: unknown })?.agent_type === "string"
              ? (item.input as { agent_type: string }).agent_type
              : undefined,
          description: (item.input as { description?: string })?.description,
          prompt:
            typeof (item.input as { message?: unknown })?.message === "string"
              ? (item.input as { message: string }).message
              : undefined,
          status: "running",
          childTools: [],
          childMessages: undefined,
          childTimeline: undefined,
          timestamp: item.timestamp ?? item.startedAt ?? Date.now(),
        });
        continue;
      }

      if (normalizedToolName === "wait" && typeof item.output === "string") {
        const waitData = parseWaitOutput(item.output);
        const snapshotWaitItem = payload.items
          .filter(
            (candidate): candidate is Extract<ThreadItem, { type: "collabEvent" }> =>
              candidate.type === "collabEvent" && candidate.eventKind === "wait",
          )
          .findLast((candidate) => candidate.timestamp === (item.timestamp ?? item.startedAt ?? Date.now()));
        const snapshotAgents = new Map((snapshotWaitItem?.agents ?? []).map((agent) => [agent.threadId, agent]));
        const agents = waitData?.agents.map((agent) => {
          const snapshotAgent = snapshotAgents.get(agent.threadId);
          const resolvedStatus = snapshotAgent?.status ?? agent.status;
          return {
            threadId: agent.threadId,
            nickname: snapshotAgent?.nickname ?? childNicknameByThreadId.get(agent.threadId),
            status: resolvedStatus,
            message: snapshotAgent?.message ?? agent.message,
          };
        });
        const anyStillRunning = agents?.some((agent) => agent.status === "running") ?? false;
        current = withItem(current, `history:collab:wait:${item.toolCallId}`, {
          id: `history:collab:wait:${item.toolCallId}`,
          kind: "collab",
          eventType: "wait",
          agents,
          status: anyStillRunning ? "running" : "completed",
          timedOut: anyStillRunning ? waitData?.timedOut : false,
          childTools: [],
          childTimeline: undefined,
          timestamp: item.timestamp ?? item.startedAt ?? Date.now(),
        });
        for (const agent of agents ?? []) {
          if (isFinalCollabStatus(agent.status)) {
            current = setSpawnStatus(current, agent.threadId, agent.status);
          }
        }
        continue;
      }

      if (normalizedToolName === "close_agent" && typeof item.output === "string") {
        const close = parseCloseOutput(item.output);
        const resolvedThreadId = close.threadId ?? spawnToolCallToThreadId.get(item.toolCallId);
        if (resolvedThreadId && close.status) {
          current = setSpawnStatus(current, resolvedThreadId, close.status);
        }
        current = withItem(current, `history:collab:close:${item.toolCallId}`, {
          id: `history:collab:close:${item.toolCallId}`,
          kind: "collab",
          eventType: "close",
          nickname: close.nickname,
          status: close.status,
          childTools: [],
          childTimeline: undefined,
          timestamp: item.timestamp ?? item.startedAt ?? Date.now(),
        });
        continue;
      }

      applyItem("item/started", item);
      if (typeof item.output === "string") {
        applyItem("item/completed", item);
      }
      continue;
    }

    if (item.type === "compaction") {
      current = withItem(current, `history:context:${item.itemId}`, {
        id: `history:context:${item.itemId}`,
        kind: "context",
        summary: item.summary,
        timestamp: item.timestamp ?? Date.now(),
      });
      continue;
    }

    if (item.type === "collabEvent") {
      if (item.eventKind === "spawn" && item.childThreadId && item.nickname) {
        childNicknameByThreadId.set(item.childThreadId, item.nickname);
      }
      current = withItem(current, `history:collab:${item.itemId}`, {
        id: `history:collab:${item.itemId}`,
        kind: "collab",
        eventType: item.eventKind,
        childThreadId: item.childThreadId,
        nickname: item.nickname,
        description: item.description,
        status: item.status,
        message: item.message,
        agents: item.agents,
        timedOut: item.timedOut,
        childTools: [],
        childTimeline: undefined,
        timestamp: item.timestamp ?? Date.now(),
      });
    }
  }

  let lastPlan: PlanState | null = null;
  for (const item of payload.items) {
    if (item.type === "toolCall" && normalizeToolName(item.toolName) === "plan" && typeof item.output === "string") {
      const plan = parsePlanOutput(item.output);
      if (plan) {
        const allResolved = plan.steps.every((s) => s.status === "done" || s.status === "cancelled");
        lastPlan = allResolved ? null : plan;
      }
    }
  }

  return {
    ...current,
    planState: lastPlan,
    usage: {
      ...current.usage,
      totalCost: payload.totalCost ?? current.usage.totalCost,
    },
  };
}

export function hydrateFromThreadRead(state: ThreadState, payload: ThreadReadResponse): ThreadState {
  return hydrateFromSnapshotItems(state, payload);
}
