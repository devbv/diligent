// @summary Server notification and request controller for the CLI TUI runtime

import type {
  AgentEvent,
  DiligentServerNotification,
  DiligentServerRequest,
  DiligentServerRequestResponse,
  RequestId,
} from "@diligent/protocol";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, DILIGENT_SERVER_REQUEST_METHODS } from "@diligent/protocol";
import type { ApprovalRequest, ApprovalResponse, UserInputRequest, UserInputResponse } from "@diligent/runtime";
import type { AppRuntimeState } from "./app-runtime-state";

export interface AppEventControllerDeps {
  runtime: AppRuntimeState;
  handleAgentEvent: (event: AgentEvent) => void;
  onTurnFinished: () => void;
  onTurnErrored: (message: string) => void;
  onUserInputRequestResolved: () => void;
  onAccountLoginCompleted: (result: { success: boolean; error: string | null }) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  requestUserInput: (request: UserInputRequest) => Promise<UserInputResponse>;
}

export class AppEventController {
  constructor(private deps: AppEventControllerDeps) {}

  private emitStatusSnapshot(status: "idle" | "busy" | undefined): void {
    if (!status) return;
    this.deps.handleAgentEvent({ type: "status_change", status });
  }

  async handleServerNotification(notification: DiligentServerNotification): Promise<void> {
    const threadId = "threadId" in notification.params ? notification.params.threadId : undefined;
    if (threadId && this.deps.runtime.currentThreadId && threadId !== this.deps.runtime.currentThreadId) {
      return;
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT) {
      this.emitStatusSnapshot(notification.params.threadStatus);
      this.deps.handleAgentEvent(notification.params.event);

      if (notification.params.event.type === "error" && this.deps.runtime.pendingTurn) {
        this.deps.onTurnErrored(notification.params.event.error.message);
      }
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED) {
      this.deps.handleAgentEvent({ type: "status_change", status: notification.params.status });
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTION_STARTED) {
      this.deps.handleAgentEvent({
        type: "compaction_start",
        estimatedTokens: notification.params.estimatedTokens,
      });
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTED) {
      this.deps.handleAgentEvent({
        type: "compaction_end",
        tokensBefore: notification.params.tokensBefore,
        tokensAfter: notification.params.tokensAfter,
        summary: notification.params.summary,
      });
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED) {
      this.emitStatusSnapshot(notification.params.threadStatus);
      this.deps.handleAgentEvent({ type: "turn_start", turnId: notification.params.turnId });
    }

    if (
      notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED &&
      this.deps.runtime.currentThreadId &&
      notification.params.threadId === this.deps.runtime.currentThreadId
    ) {
      this.emitStatusSnapshot(notification.params.threadStatus);
      this.deps.onTurnFinished();
    }

    if (
      notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED &&
      this.deps.runtime.currentThreadId &&
      notification.params.threadId === this.deps.runtime.currentThreadId
    ) {
      this.emitStatusSnapshot(notification.params.threadStatus);
      this.deps.onTurnFinished();
    }

    if (
      notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR &&
      (!notification.params.threadId || notification.params.threadId === this.deps.runtime.currentThreadId)
    ) {
      this.deps.handleAgentEvent({
        type: "error",
        error: notification.params.error,
        fatal: notification.params.fatal,
      });
      if (this.deps.runtime.pendingTurn) {
        this.deps.onTurnErrored(notification.params.error.message);
      }
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED) {
      const requestId = notification.params.requestId;
      if (this.deps.runtime.pendingUserInputRequestIds.has(requestId)) {
        this.deps.runtime.activeUserInputResolved = true;
        this.deps.runtime.pendingUserInputRequestIds.delete(requestId);
        if (this.deps.runtime.activeUserInputRequestId === requestId) {
          this.deps.onUserInputRequestResolved();
        }
      }
    }

    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ACCOUNT_LOGIN_COMPLETED) {
      const { success, error } = notification.params;
      this.deps.onAccountLoginCompleted({ success, error: error ?? null });
    }
  }

  async handleServerRequest(
    requestId: RequestId,
    request: DiligentServerRequest,
  ): Promise<DiligentServerRequestResponse> {
    if (request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
      const decision = await this.deps.requestApproval(request.params.request);
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision },
      };
    }

    this.deps.runtime.pendingUserInputRequestIds.add(requestId);
    this.deps.runtime.activeUserInputRequestId = requestId;
    this.deps.runtime.activeUserInputResolved = false;
    try {
      const result = await this.deps.requestUserInput(request.params.request);
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
        result,
      };
    } finally {
      this.deps.runtime.pendingUserInputRequestIds.delete(requestId);
      if (this.deps.runtime.activeUserInputRequestId === requestId) {
        this.deps.runtime.activeUserInputRequestId = null;
      }
      this.deps.runtime.activeUserInputResolved = false;
    }
  }
}
