// @summary Notification helper utilities for App-level event derivation and filtering

import type { AgentEvent, DiligentServerNotification } from "@diligent/protocol";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import type { RenderItem } from "./thread-store";

export function toNotificationParams(notification: DiligentServerNotification): Record<string, unknown> | null {
  return notification.params !== null && typeof notification.params === "object"
    ? (notification.params as Record<string, unknown>)
    : null;
}

export function shouldMarkAttentionThread(
  notification: DiligentServerNotification,
  notificationParams: Record<string, unknown> | null,
  activeThreadId: string | null,
): string | null {
  if (notification.method !== DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) return null;
  if (!notificationParams) return null;
  if (!activeThreadId) return null;
  if (typeof notificationParams.threadId !== "string") return null;
  return notificationParams.threadId !== activeThreadId ? notificationParams.threadId : null;
}

export function hasInFlightRenderItems(items: RenderItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === "tool" && item.status === "streaming") ||
      (item.kind === "assistant" && item.thinkingDone === false),
  );
}

export function shouldRehydrateAfterIdleStatus(
  notification: DiligentServerNotification,
  notificationParams: Record<string, unknown> | null,
  hasInFlightItems: boolean,
  activeThreadId: string | null,
): string | null {
  if (notification.method !== DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED) return null;
  if (!notificationParams) return null;
  if (!hasInFlightItems) return null;
  if (notificationParams.status !== "idle") return null;
  return activeThreadId;
}

export function deriveAgentEvents(notification: DiligentServerNotification): AgentEvent[] {
  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT) {
    return [notification.params.event];
  }
  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED) {
    return [{ type: "status_change", status: notification.params.status }];
  }
  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED) {
    return [
      {
        type: "turn_start",
        turnId: notification.params.turnId,
        ...(notification.params.childThreadId
          ? {
              childThreadId: notification.params.childThreadId,
              nickname: notification.params.nickname,
              turnNumber: notification.params.turnNumber,
            }
          : {}),
      },
    ];
  }
  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR) {
    return [{ type: "error", error: notification.params.error, fatal: notification.params.fatal }];
  }
  return [];
}

export function filterSteeringInjectedEvents(
  events: AgentEvent[],
  shouldSuppressNextSteeringInjected: boolean,
): { events: AgentEvent[]; consumedSuppression: boolean } {
  if (!shouldSuppressNextSteeringInjected) {
    return { events, consumedSuppression: false };
  }
  const hasSteeringInjected = events.some((event) => event.type === "steering_injected");
  if (!hasSteeringInjected) {
    return { events, consumedSuppression: false };
  }
  return {
    events: events.filter((event) => event.type !== "steering_injected"),
    consumedSuppression: true,
  };
}
