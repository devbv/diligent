// @summary Tests for app event controller notification and request orchestration
import { describe, expect, mock, test } from "bun:test";
import { AppEventController } from "../../src/tui/app-event-controller";
import { AppRuntimeState } from "../../src/tui/app-runtime-state";

describe("AppEventController", () => {
  test("routes turn completion to finish callback for current thread", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    runtime.currentThreadId = "thread-1";
    const onTurnFinished = mock(() => {});
    const controller = new AppEventController({
      runtime,
      handleAgentEvent: () => {},
      onTurnFinished,
      onTurnErrored: () => {},
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval: async () => "once",
      requestUserInput: async () => ({ answers: {} }),
    });

    await controller.handleServerNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" },
    });

    expect(onTurnFinished).toHaveBeenCalledTimes(1);
  });

  test("maps thread status changed notifications to status_change events", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    runtime.currentThreadId = "thread-1";
    const handleAgentEvent = mock(() => {});
    const controller = new AppEventController({
      runtime,
      handleAgentEvent,
      onTurnFinished: () => {},
      onTurnErrored: () => {},
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval: async () => "once",
      requestUserInput: async () => ({ answers: {} }),
    });

    await controller.handleServerNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: "idle" },
    });

    expect(handleAgentEvent).toHaveBeenCalledWith({ type: "status_change", status: "idle" });
  });

  test("maps thread compaction notifications to compaction events", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    runtime.currentThreadId = "thread-1";
    const handleAgentEvent = mock(() => {});
    const controller = new AppEventController({
      runtime,
      handleAgentEvent,
      onTurnFinished: () => {},
      onTurnErrored: () => {},
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval: async () => "once",
      requestUserInput: async () => ({ answers: {} }),
    });

    await controller.handleServerNotification({
      method: "thread/compaction/started",
      params: { threadId: "thread-1", estimatedTokens: 1234 },
    });

    await controller.handleServerNotification({
      method: "thread/compacted",
      params: {
        threadId: "thread-1",
        entryCount: 3,
        tokensBefore: 4000,
        tokensAfter: 1800,
        summary: "Actual compacted summary",
      },
    });

    expect(handleAgentEvent).toHaveBeenNthCalledWith(1, {
      type: "compaction_start",
      estimatedTokens: 1234,
    });
    expect(handleAgentEvent).toHaveBeenNthCalledWith(2, {
      type: "compaction_end",
      tokensBefore: 4000,
      tokensAfter: 1800,
      summary: "Actual compacted summary",
    });
  });

  test("applies threadStatus snapshot from agent_event before forwarding event", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    runtime.currentThreadId = "thread-1";
    const handleAgentEvent = mock(() => {});
    const controller = new AppEventController({
      runtime,
      handleAgentEvent,
      onTurnFinished: () => {},
      onTurnErrored: () => {},
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval: async () => "once",
      requestUserInput: async () => ({ answers: {} }),
    });

    await controller.handleServerNotification({
      method: "agent/event",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        threadStatus: "busy",
        event: { type: "message_start" },
      },
    });

    expect(handleAgentEvent).toHaveBeenNthCalledWith(1, { type: "status_change", status: "busy" });
    expect(handleAgentEvent).toHaveBeenNthCalledWith(2, { type: "message_start" });
  });

  test("applies threadStatus snapshot from turn_started notification", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    runtime.currentThreadId = "thread-1";
    const handleAgentEvent = mock(() => {});
    const controller = new AppEventController({
      runtime,
      handleAgentEvent,
      onTurnFinished: () => {},
      onTurnErrored: () => {},
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval: async () => "once",
      requestUserInput: async () => ({ answers: {} }),
    });

    await controller.handleServerNotification({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        threadStatus: "busy",
      },
    });

    expect(handleAgentEvent).toHaveBeenNthCalledWith(1, { type: "status_change", status: "busy" });
    expect(handleAgentEvent).toHaveBeenNthCalledWith(2, { type: "turn_start", turnId: "turn-1" });
  });

  test("forwards server error notification as agent error before rejecting pending turn", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    runtime.currentThreadId = "thread-1";
    runtime.pendingTurn = {
      resolve: () => {},
      reject: () => {},
    };
    const handleAgentEvent = mock(() => {});
    const onTurnErrored = mock(() => {});
    const controller = new AppEventController({
      runtime,
      handleAgentEvent,
      onTurnFinished: () => {},
      onTurnErrored,
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval: async () => "once",
      requestUserInput: async () => ({ answers: {} }),
    });

    await controller.handleServerNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        error: { message: "Estimated Token is below 50000", name: "Error" },
        fatal: false,
      },
    });

    expect(handleAgentEvent).toHaveBeenCalledWith({
      type: "error",
      error: { message: "Estimated Token is below 50000", name: "Error" },
      fatal: false,
    });
    expect(onTurnErrored).toHaveBeenCalledWith("Estimated Token is below 50000");
  });

  test("delegates approval server requests", async () => {
    const runtime = new AppRuntimeState("default", "medium");
    const requestApproval = mock(async () => "always" as const);
    const controller = new AppEventController({
      runtime,
      handleAgentEvent: () => {},
      onTurnFinished: () => {},
      onTurnErrored: () => {},
      onUserInputRequestResolved: () => {},
      onAccountLoginCompleted: () => {},
      requestApproval,
      requestUserInput: async () => ({ answers: {} }),
    });

    const response = await controller.handleServerRequest(1, {
      id: 1,
      method: "approval/request",
      params: {
        request: {
          toolName: "bash",
          permission: "execute",
          description: "run command",
        },
      },
    });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      method: "approval/request",
      result: { decision: "always" },
    });
  });
});
