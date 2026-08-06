// @summary Protocol notification to AgentEvent adapter shared by protocol clients

import type { AgentEvent, AssistantMessage, DiligentServerNotification, ToolRenderPayload } from "./index";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "./index";

function createEmptyAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: { provider: "anthropic", modelId: "unknown" },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function mergeToolRenderPayload(
  started: ToolRenderPayload | undefined,
  completed: ToolRenderPayload | undefined,
): ToolRenderPayload | undefined {
  if (!started) return completed;
  if (!completed) return started;
  return {
    ...completed,
    inputSummary: completed.inputSummary ?? started.inputSummary,
  };
}

export class ProtocolNotificationAdapter {
  private agentMessageByItemId = new Map<string, AssistantMessage>();
  private toolCallByItemId = new Map<
    string,
    { toolCallId: string; toolName: string; input: unknown; render?: ToolRenderPayload }
  >();

  toAgentEvents(notification: DiligentServerNotification): AgentEvent[] {
    switch (notification.method) {
      case DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED:
        return [{ type: "status_change", status: notification.params.status }];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED:
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
      case DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_STARTED:
        return this.handleItemStarted(notification);
      case DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_DELTA:
        return this.handleItemDelta(notification);
      case DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_COMPLETED:
        return this.handleItemCompleted(notification);
      case DILIGENT_SERVER_NOTIFICATION_METHODS.KNOWLEDGE_SAVED:
        return [
          {
            type: "knowledge_saved",
            knowledgeId: notification.params.knowledgeId,
            content: notification.params.content,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR:
        return [{ type: "error", error: notification.params.error, fatal: notification.params.fatal }];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.USAGE_UPDATED:
        return [{ type: "usage", usage: notification.params.usage, cost: notification.params.cost }];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.STEERING_INJECTED:
        return [
          {
            type: "steering_injected",
            messageCount: notification.params.messageCount,
            messages: notification.params.messages,
            steerIds: notification.params.steerIds,
            messageIds: notification.params.messageIds,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTION_STARTED:
        return [
          {
            type: "compaction_start",
            estimatedTokens: notification.params.estimatedTokens,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTED:
        return [
          {
            type: "compaction_end",
            tokensBefore: notification.params.tokensBefore,
            tokensAfter: notification.params.tokensAfter,
            summary: notification.params.summary,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_SPAWN_BEGIN:
        return [
          {
            type: "collab_spawn_begin",
            callId: notification.params.callId,
            prompt: notification.params.prompt,
            agentType: notification.params.agentType,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_SPAWN_END:
        return [
          {
            type: "collab_spawn_end",
            callId: notification.params.callId,
            childThreadId: notification.params.childThreadId,
            nickname: notification.params.nickname,
            agentType: notification.params.agentType,
            description: notification.params.description,
            prompt: notification.params.prompt,
            status: notification.params.status,
            message: notification.params.message,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_WAIT_BEGIN:
        return [{ type: "collab_wait_begin", callId: notification.params.callId, agents: notification.params.agents }];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_WAIT_END:
        return [
          {
            type: "collab_wait_end",
            callId: notification.params.callId,
            agentStatuses: notification.params.agentStatuses,
            timedOut: notification.params.timedOut,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_CLOSE_BEGIN:
        return [
          {
            type: "collab_close_begin",
            callId: notification.params.callId,
            childThreadId: notification.params.childThreadId,
            nickname: notification.params.nickname,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_CLOSE_END:
        return [
          {
            type: "collab_close_end",
            callId: notification.params.callId,
            childThreadId: notification.params.childThreadId,
            nickname: notification.params.nickname,
            status: notification.params.status,
            message: notification.params.message,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_INTERACTION_BEGIN:
        return [
          {
            type: "collab_interaction_begin",
            callId: notification.params.callId,
            receiverThreadId: notification.params.receiverThreadId,
            receiverNickname: notification.params.receiverNickname,
            prompt: notification.params.prompt,
          },
        ];
      case DILIGENT_SERVER_NOTIFICATION_METHODS.COLLAB_INTERACTION_END:
        return [
          {
            type: "collab_interaction_end",
            callId: notification.params.callId,
            receiverThreadId: notification.params.receiverThreadId,
            receiverNickname: notification.params.receiverNickname,
            prompt: notification.params.prompt,
            status: notification.params.status,
          },
        ];
      default:
        return [];
    }
  }

  reset(): void {
    this.agentMessageByItemId.clear();
    this.toolCallByItemId.clear();
  }

  private handleItemStarted(
    notification: Extract<
      DiligentServerNotification,
      { method: typeof DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_STARTED }
    >,
  ): AgentEvent[] {
    const { item, childThreadId, nickname } = notification.params;

    if (item.type === "agentMessage") {
      this.agentMessageByItemId.set(item.itemId, item.message);
      return [
        {
          type: "message_start",
          itemId: item.itemId,
          message: item.message,
          ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
          ...(childThreadId ? { childThreadId, nickname } : {}),
        },
      ];
    }

    if (item.type === "toolCall") {
      this.toolCallByItemId.set(item.itemId, {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: item.input,
        render: item.render,
      });
      return [
        {
          type: "tool_start",
          itemId: item.itemId,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: item.input,
          render: item.render,
          ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
          ...(typeof item.startedAt === "number" ? { startedAt: item.startedAt } : {}),
          ...(childThreadId ? { childThreadId, nickname } : {}),
        },
      ];
    }

    return [];
  }

  private handleItemDelta(
    notification: Extract<
      DiligentServerNotification,
      { method: typeof DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_DELTA }
    >,
  ): AgentEvent[] {
    const { itemId, delta, childThreadId, nickname } = notification.params;

    if (delta.type === "messageText" || delta.type === "messageThinking") {
      const message = this.agentMessageByItemId.get(itemId) ?? createEmptyAssistantMessage();
      return [
        {
          type: "message_delta",
          itemId,
          message,
          delta: {
            type: delta.type === "messageText" ? "text_delta" : "thinking_delta",
            delta: delta.delta,
          },
          ...(childThreadId ? { childThreadId, nickname } : {}),
        },
      ];
    }

    if (delta.type === "toolOutput") {
      const tool = this.toolCallByItemId.get(itemId);
      if (!tool) return [];
      return [
        {
          type: "tool_update",
          itemId,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          partialResult: delta.delta,
          ...(childThreadId ? { childThreadId, nickname } : {}),
        },
      ];
    }

    return [];
  }

  private handleItemCompleted(
    notification: Extract<
      DiligentServerNotification,
      { method: typeof DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_COMPLETED }
    >,
  ): AgentEvent[] {
    const { item, childThreadId, nickname } = notification.params;

    if (item.type === "agentMessage") {
      const message = this.agentMessageByItemId.get(item.itemId) ?? item.message;
      this.agentMessageByItemId.delete(item.itemId);
      return [
        {
          type: "message_end",
          itemId: item.itemId,
          message,
          ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
          ...(typeof item.reasoningDurationMs === "number" ? { reasoningDurationMs: item.reasoningDurationMs } : {}),
          ...(typeof item.turnDurationMs === "number" ? { turnDurationMs: item.turnDurationMs } : {}),
          ...(childThreadId ? { childThreadId, nickname } : {}),
        },
      ];
    }

    if (item.type === "toolCall") {
      const started = this.toolCallByItemId.get(item.itemId);
      this.toolCallByItemId.delete(item.itemId);
      return [
        {
          type: "tool_end",
          itemId: item.itemId,
          toolCallId: started?.toolCallId ?? item.toolCallId,
          toolName: started?.toolName ?? item.toolName,
          output: item.output ?? "",
          ...(item.outputImages ? { outputImages: item.outputImages } : {}),
          isError: item.isError ?? false,
          render: mergeToolRenderPayload(started?.render, item.render),
          ...(item.metadata ? { metadata: item.metadata } : {}),
          ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
          ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
          ...(childThreadId ? { childThreadId, nickname } : {}),
        },
      ];
    }

    return [];
  }
}
