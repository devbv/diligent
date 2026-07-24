// @summary Tests for App notification helper logic (event derivation and gating)

import { expect, test } from "bun:test";
import type { DiligentServerNotification } from "@diligent/protocol";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import {
  deriveAgentEvents,
  filterSteeringInjectedEvents,
  hasInFlightRenderItems,
  shouldMarkAttentionThread,
  shouldRehydrateAfterIdleStatus,
  toNotificationParams,
} from "../../../../src/web/client/lib/app-notification";

test("deriveAgentEvents maps thread status notifications to status_change event", () => {
  const notification: DiligentServerNotification = {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
    params: { threadId: "t1", status: "busy" },
  };

  expect(deriveAgentEvents(notification)).toEqual([{ type: "status_change", status: "busy" }]);
});

test("deriveAgentEvents maps ERROR notifications to error event", () => {
  const notification: DiligentServerNotification = {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
    params: {
      threadId: "t1",
      error: { message: "Compaction failed", name: "Error" },
      fatal: false,
    },
  };

  expect(deriveAgentEvents(notification)).toEqual([
    { type: "error", error: { message: "Compaction failed", name: "Error" }, fatal: false },
  ]);
});

test("filterSteeringInjectedEvents removes steering_injected and consumes suppression", () => {
  const result = filterSteeringInjectedEvents(
    [
      { type: "message_delta", itemId: "a", delta: "hello" },
      { type: "steering_injected", text: "retry" },
    ],
    true,
  );

  expect(result.consumedSuppression).toBe(true);
  expect(result.events.some((event) => event.type === "steering_injected")).toBe(false);
  expect(result.events).toHaveLength(1);
});

test("shouldMarkAttentionThread returns non-active thread on turn completed", () => {
  const notification: DiligentServerNotification = {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
    params: { threadId: "other-thread", turnId: "turn-1" },
  };

  const params = toNotificationParams(notification);
  expect(shouldMarkAttentionThread(notification, params, "active-thread")).toBe("other-thread");
  expect(shouldMarkAttentionThread(notification, params, "other-thread")).toBeNull();
});

test("hasInFlightRenderItems detects assistant thinking and streaming tools", () => {
  expect(
    hasInFlightRenderItems([
      { id: "a", kind: "assistant", text: "", thinking: "...", thinkingDone: false, timestamp: 1 },
    ]),
  ).toBe(true);

  expect(
    hasInFlightRenderItems([
      {
        id: "t",
        kind: "tool",
        toolName: "bash",
        inputText: "ls",
        outputText: "",
        isError: false,
        status: "streaming",
        timestamp: 1,
        toolCallId: "tool-1",
        startedAt: 1,
      },
    ]),
  ).toBe(true);
});

test("shouldRehydrateAfterIdleStatus requires idle status and in-flight items", () => {
  const notification: DiligentServerNotification = {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
    params: { threadId: "t1", status: "idle" },
  };

  const params = toNotificationParams(notification);
  expect(shouldRehydrateAfterIdleStatus(notification, params, true, "active-thread")).toBe("active-thread");
  expect(shouldRehydrateAfterIdleStatus(notification, params, false, "active-thread")).toBeNull();
});
