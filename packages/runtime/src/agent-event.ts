// @summary AgentEvent union — CoreAgentEvent extended with runtime-emitted events
import type { CoreAgentEvent } from "@diligent/core/agent";
import type { Usage } from "@diligent/core/message-contract";
import type { CollabAgentRef, CollabAgentStatus, CollabAgentStatusEntry, ToolRenderPayload } from "@diligent/protocol";

type RuntimeToolStartEvent = Extract<CoreAgentEvent, { type: "tool_start" }> & { render?: ToolRenderPayload };
type RuntimeToolEndEvent = Extract<CoreAgentEvent, { type: "tool_end" }> & { render?: ToolRenderPayload };

type ChildAgentCoreEvent = Extract<
  CoreAgentEvent,
  {
    type:
      | "turn_start"
      | "message_start"
      | "message_discarded"
      | "message_delta"
      | "message_end"
      | "tool_start"
      | "tool_update"
      | "tool_end";
  }
>;
type ChildAgentBaseEvent =
  | Exclude<ChildAgentCoreEvent, { type: "tool_start" | "tool_end" }>
  | RuntimeToolStartEvent
  | RuntimeToolEndEvent;

/** Runtime collaboration overlay for events relayed from a child agent. */
export type ChildAgentEvent<T extends ChildAgentBaseEvent = ChildAgentBaseEvent> = T extends unknown
  ? T & { childThreadId: string; nickname?: string } & (T extends { type: "turn_start" }
        ? { turnNumber: number }
        : object)
  : never;

export type RuntimeAgentEvent =
  | RuntimeToolStartEvent
  | RuntimeToolEndEvent
  | ChildAgentEvent
  | { type: "status_change"; status: "idle" | "busy" }
  | { type: "usage"; usage: Usage; cost: number }
  | { type: "knowledge_saved"; knowledgeId: string; content: string }
  | {
      type: "context_notice";
      source: string;
      presentation: import("@diligent/protocol").ContextPresentation;
    }
  | { type: "collab_spawn_begin"; callId: string; prompt: string; agentType: string }
  | {
      type: "collab_spawn_end";
      callId: string;
      childThreadId: string;
      nickname?: string;
      agentType?: string;
      description?: string;
      prompt: string;
      status: CollabAgentStatus;
      message?: string;
    }
  | { type: "collab_wait_begin"; callId: string; agents: CollabAgentRef[] }
  | { type: "collab_wait_end"; callId: string; agentStatuses: CollabAgentStatusEntry[]; timedOut: boolean }
  | { type: "collab_close_begin"; callId: string; childThreadId: string; nickname?: string }
  | {
      type: "collab_close_end";
      callId: string;
      childThreadId: string;
      nickname?: string;
      status: CollabAgentStatus;
      message?: string;
    }
  | {
      type: "collab_interaction_begin";
      callId: string;
      receiverThreadId: string;
      receiverNickname?: string;
      prompt: string;
    }
  | {
      type: "collab_interaction_end";
      callId: string;
      receiverThreadId: string;
      receiverNickname?: string;
      prompt: string;
      status: CollabAgentStatus;
    };

export type AgentEvent =
  | Exclude<CoreAgentEvent, { type: "usage" | "tool_start" | "tool_end" | "context_injected" }>
  | RuntimeAgentEvent;
