// @summary Shared AgentEvent state reducer for ConversationLiveState across all Diligent clients

import type { ConversationLiveState } from "./conversation-state";
import type { AgentEvent } from "./data-model";

/**
 * Applies a batch of AgentEvents to a ConversationLiveState (or any subtype of it),
 * returning the next state. Only live-streaming fields are updated here; persisted
 * conversation items and client-specific fields (e.g. connection status) are the
 * caller's responsibility.
 *
 * The generic parameter T preserves the concrete subtype so callers do not need a cast:
 *   const next = applyAgentEvents(viewState, events); // typeof next === typeof viewState
 *
 * This is the prototype step described in the 2026-04-08 tech-lead review (Group 2, Action #3).
 * Start with the 15 event types currently handled in the VS Code extension, then incrementally
 * add collab and provider-native events as needed.
 */
export function applyAgentEvents<T extends ConversationLiveState>(state: T, events: AgentEvent[]): T {
  let nextState: ConversationLiveState = { ...state };

  for (const event of events) {
    switch (event.type) {
      case "status_change":
        nextState = {
          ...nextState,
          threadStatus: event.status,
          overlayStatus: event.status === "busy" ? (nextState.overlayStatus ?? "Working…") : null,
        };
        break;
      case "turn_start":
        nextState = { ...nextState, overlayStatus: "Thinking…" };
        break;
      case "message_start":
        nextState = { ...nextState, liveText: "", liveThinking: "", overlayStatus: "Thinking…" };
        break;
      case "message_discarded":
        nextState = {
          ...nextState,
          liveText: "",
          liveThinking: "",
          overlayStatus: `Reconnecting… ${event.nextAttempt}/${event.maxAttempts}`,
        };
        break;
      case "message_delta":
        if (event.delta.type === "text_delta") {
          nextState = {
            ...nextState,
            liveText: `${nextState.liveText}${event.delta.delta}`,
            overlayStatus: null,
          };
        } else if (event.delta.type === "thinking_delta") {
          nextState = {
            ...nextState,
            liveThinking: `${nextState.liveThinking}${event.delta.delta}`,
            overlayStatus: "Thinking…",
          };
        }
        break;
      case "message_end":
        nextState = {
          ...nextState,
          liveText: "",
          liveThinking: "",
          overlayStatus: nextState.liveToolName ? nextState.overlayStatus : null,
        };
        break;
      case "tool_start":
        nextState = {
          ...nextState,
          liveToolName: event.toolName,
          liveToolInput:
            event.render?.inputSummary?.trim() ||
            (typeof event.input === "string" ? event.input : JSON.stringify(event.input, null, 2)),
          liveToolOutput: "",
          overlayStatus: `${event.render?.inputSummary?.trim() || event.toolName}…`,
        };
        break;
      case "tool_update":
        nextState = {
          ...nextState,
          liveToolName: event.toolName,
          liveToolOutput: `${nextState.liveToolOutput}${event.partialResult}`,
          overlayStatus: `${nextState.liveToolInput || event.toolName}…`,
        };
        break;
      case "tool_end":
        nextState = {
          ...nextState,
          liveToolName: null,
          liveToolInput: null,
          liveToolOutput: "",
          overlayStatus: null,
        };
        break;
      case "compaction_start":
        nextState = { ...nextState, overlayStatus: "Compacting…" };
        break;
      case "compaction_end":
        nextState = { ...nextState, overlayStatus: null };
        break;
      case "error":
        nextState = {
          ...nextState,
          overlayStatus: null,
          liveText: "",
          liveThinking: "",
          liveToolName: null,
          liveToolInput: null,
          liveToolOutput: "",
        };
        break;
      case "collab_spawn_begin":
        nextState = { ...nextState, overlayStatus: "Spawning agent…" };
        break;
      case "collab_spawn_end":
        nextState = { ...nextState, overlayStatus: null };
        break;
      case "collab_wait_begin":
        nextState = { ...nextState, overlayStatus: "Waiting for agents…" };
        break;
      case "collab_wait_end":
        nextState = { ...nextState, overlayStatus: null };
        break;
      case "collab_close_begin":
        nextState = { ...nextState, overlayStatus: "Closing agent…" };
        break;
      case "collab_close_end":
        nextState = { ...nextState, overlayStatus: null };
        break;
      case "collab_interaction_begin":
        nextState = { ...nextState, overlayStatus: "Sending to agent…" };
        break;
      case "collab_interaction_end":
        nextState = { ...nextState, overlayStatus: null };
        break;
    }
  }

  return nextState as T;
}
