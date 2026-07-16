// @summary Protocol event reducer and view-state normalization for Web CLI thread rendering

import type {
  AgentEvent,
  ApprovalRequest,
  AssistantMessage,
  ContentBlock,
  ConversationLiveState,
  DiligentServerNotification,
  Mode,
  PendingSteer,
  SessionSummary,
  ThreadStatus,
  ToolRenderPayload,
  UserInputRequest,
} from "@diligent/protocol";
import { applyAgentEvents, DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import type { AgentContextItem } from "./agent-native-bridge";
import { parseContextFromText } from "./agent-native-bridge";
import {
  appendChildAssistantTimelineDelta,
  appendChildAssistantTimelineStart,
  finalizeChildAssistantTimeline,
  findCollabSpawnItem,
  isCollabEvent,
  reduceCollabEvent,
} from "./collab-reducer";
import { extractUserTextAndImages, updateItem, withItem, zeroUsage } from "./thread-utils";
import { isToolEvent, reduceToolEvent } from "./tool-reducer";
import { getUserFacingErrorMessage } from "./user-facing-errors";

export { hydrateFromThreadRead } from "./thread-hydration";

export interface PlanState {
  title: string;
  steps: Array<{ text: string; status: "pending" | "in_progress" | "done" | "cancelled" }>;
}

export interface ToastState {
  id: string;
  kind: "error" | "info";
  message: string;
  fatal?: boolean;
}

type ProviderErrorType = NonNullable<Extract<AgentEvent, { type: "error" }>["error"]["providerErrorType"]>;

export interface ActiveErrorState {
  id: string;
  message: string;
  name?: string;
  fatal: boolean;
  turnId?: string;
  timestamp: number;
  providerErrorType?: ProviderErrorType;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

/**
 * The studiorpc provider prepends a human-edit summary to the user message
 * (via the UserPromptSubmit hook) wrapped in this marker. Split it out of the
 * visible user text and surface it as a collapsible context item instead.
 */
const HUMAN_EDITS_PATTERN = /<HumanEdits>\n([\s\S]*?)\n<\/HumanEdits>\n*/;
export function parseHumanEditsFromText(text: string): { humanEdits?: string; remainingText: string } {
  const match = text.match(HUMAN_EDITS_PATTERN);
  if (!match) return { remainingText: text };
  return { humanEdits: match[1], remainingText: text.replace(HUMAN_EDITS_PATTERN, "") };
}

export type RenderItem =
  | {
      id: string;
      kind: "context";
      summary: string;
      /** Distinguishes the human-edits notice from the default compaction divider. */
      variant?: "human-edits";
      timestamp: number;
    }
  | {
      id: string;
      kind: "user";
      text: string;
      contextItems?: AgentContextItem[];
      images: Array<{ url: string; fileName?: string; mediaType?: string }>;
      timestamp: number;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      thinking: string;
      contentBlocks: ContentBlock[];
      thinkingDone: boolean;
      timestamp: number;
      reasoningDurationMs?: number;
      turnDurationMs?: number;
    }
  | {
      id: string;
      kind: "tool";
      toolName: string;
      inputText: string;
      outputText: string;
      isError: boolean;
      status: "streaming" | "done";
      timestamp: number;
      toolCallId: string;
      startedAt: number;
      durationMs?: number;
      /** P040: optional structured render payload for richer presentation */
      render?: ToolRenderPayload;
    }
  | {
      id: string;
      kind: "collab";
      eventType: "spawn" | "wait" | "close" | "interaction";
      childThreadId?: string;
      nickname?: string;
      agentType?: string;
      description?: string;
      prompt?: string;
      status?: string;
      message?: string;
      agents?: Array<{ threadId: string; nickname?: string; status?: string; message?: string }>;
      timedOut?: boolean;
      turnNumber?: number;
      childTools: Array<{
        toolCallId: string;
        toolName: string;
        status: "running" | "done";
        isError: boolean;
        inputText: string;
        outputText: string;
      }>;
      childMessages?: string[];
      childTimeline?: Array<
        | {
            kind: "assistant";
            itemId?: string;
            message: string;
          }
        | {
            kind: "tool";
            toolCallId: string;
            toolName: string;
            status: "running" | "done";
            isError: boolean;
            inputText: string;
            outputText: string;
          }
      >;
      timestamp: number;
    };

export interface ThreadState {
  activeThreadId: string | null;
  activeThreadCwd: string | null;
  mode: Mode;
  threadStatus: ThreadStatus;
  items: RenderItem[];
  threadList: SessionSummary[];
  seenKeys: Record<string, true>;
  itemSlots: Record<string, string>;
  pendingApproval: { requestId: number; request: ApprovalRequest } | null;
  pendingUserInput: { requestId: number; request: UserInputRequest; answers: Record<string, string | string[]> } | null;
  toast: ToastState | null;
  activeError: ActiveErrorState | null;
  usage: UsageState;
  currentContextTokens: number; // latest turn's total input tokens including cache (not cumulative)
  planState: PlanState | null;
  pendingSteers: PendingSteer[];
  activeTurnHadError: boolean;
  activeTurnId: string | null;
  activeTurnStartedAt: number | null;
  activeReasoningStartedAt: number | null;
  activeReasoningDurationMs: number;
  isCompacting: boolean;
  liveText: string;
  liveThinking: string;
  liveToolName: string | null;
  liveToolInput: string | null;
  liveToolOutput: string;
  overlayStatus: string | null;
}

// ─── Shared reducer live-field bridge ───────────────────────────────────────
// ThreadState cannot directly extend ConversationLiveState because their `items`
// fields differ (RenderItem[] vs ThreadItem[]). Instead, these live-streaming
// fields are kept in sync by delegating to applyAgentEvents() via an adapter.

export const initialThreadState: ThreadState = {
  activeThreadId: null,
  activeThreadCwd: null,
  mode: "default",
  threadStatus: "idle",
  items: [],
  threadList: [],
  seenKeys: {},
  itemSlots: {},
  pendingApproval: null,
  pendingUserInput: null,
  toast: null,
  activeError: null,
  usage: zeroUsage,
  currentContextTokens: 0,
  planState: null,
  pendingSteers: [],
  activeTurnHadError: false,
  activeTurnId: null,
  activeTurnStartedAt: null,
  activeReasoningStartedAt: null,
  activeReasoningDurationMs: 0,
  isCompacting: false,
  liveText: "",
  liveThinking: "",
  liveToolName: null,
  liveToolInput: null,
  liveToolOutput: "",
  overlayStatus: null,
};

let renderSeq = 0;

/** Build a ConversationLiveState adapter from the live-streaming fields in ThreadState. */
function extractLiveState(state: ThreadState): ConversationLiveState {
  return {
    threadId: state.activeThreadId,
    threadTitle: null,
    threadStatus: state.threadStatus,
    items: [],
    liveText: state.liveText,
    liveThinking: state.liveThinking,
    liveToolName: state.liveToolName,
    liveToolInput: state.liveToolInput,
    liveToolOutput: state.liveToolOutput,
    overlayStatus: state.overlayStatus,
    isLoading: false,
    lastError: null,
  };
}

/** Merge updated ConversationLiveState live fields back into ThreadState. */
function mergeLiveFields(state: ThreadState, live: ConversationLiveState): ThreadState {
  return {
    ...state,
    threadStatus: live.threadStatus as ThreadStatus,
    liveText: live.liveText,
    liveThinking: live.liveThinking,
    liveToolName: live.liveToolName,
    liveToolInput: live.liveToolInput,
    liveToolOutput: live.liveToolOutput,
    overlayStatus: live.overlayStatus,
  };
}

function extractAssistantTextFromMessage(message: AssistantMessage): { text: string; thinking: string } {
  type AssistantContentBlock = AssistantMessage["content"][number];
  const text = message.content
    .filter(
      (block: AssistantContentBlock): block is Extract<AssistantContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const thinking = message.content
    .filter(
      (block: AssistantContentBlock): block is Extract<AssistantContentBlock, { type: "thinking" }> =>
        block.type === "thinking",
    )
    .map((block) => block.thinking)
    .join("");
  return { text, thinking };
}

function reduceAgentEvent(state: ThreadState, event: AgentEvent, turnId?: string): ThreadState {
  // Delegate base ConversationLiveState live fields to the shared reducer first.
  // This keeps threadStatus, overlayStatus, liveText, liveThinking, and live tool
  // fields converged with protocol's applyAgentEvents() contract.
  const liveResult = applyAgentEvents(extractLiveState(state), [event]);
  const merged = mergeLiveFields(state, liveResult);

  // Tool events: apply live fields first, then handle Web-specific RenderItem logic.
  if (isToolEvent(event)) {
    return reduceToolEvent(merged, event);
  }

  // Collab events: apply live fields first, then handle Web-specific collab item logic.
  if (isCollabEvent(event)) {
    return reduceCollabEvent(merged, event);
  }

  switch (event.type) {
    case "message_start": {
      if ("childThreadId" in event && typeof event.childThreadId === "string") {
        return appendChildAssistantTimelineStart(merged, event.childThreadId, event.itemId);
      }
      const renderId = `item:${event.itemId}:${++renderSeq}`;
      if (merged.itemSlots[event.itemId]) return merged;
      return {
        ...merged,
        itemSlots: { ...merged.itemSlots, [event.itemId]: renderId },
        items: [
          ...merged.items,
          {
            id: renderId,
            kind: "assistant",
            text: "",
            thinking: "",
            contentBlocks: [],
            thinkingDone: false,
            timestamp:
              typeof (event as { timestamp?: number }).timestamp === "number"
                ? (event as { timestamp?: number }).timestamp!
                : event.message.timestamp,
          },
        ],
      };
    }

    case "message_discarded": {
      if ("childThreadId" in event && typeof event.childThreadId === "string") {
        return merged;
      }
      const renderId = merged.itemSlots[event.itemId];
      if (!renderId) return merged;
      const { [event.itemId]: _, ...remainingSlots } = merged.itemSlots;
      return {
        ...merged,
        itemSlots: remainingSlots,
        items: merged.items.filter((item) => item.id !== renderId),
        activeReasoningStartedAt: null,
        activeReasoningDurationMs: 0,
      };
    }

    case "message_delta": {
      if ("childThreadId" in event && typeof event.childThreadId === "string") {
        if (event.delta.type === "text_delta") {
          return appendChildAssistantTimelineDelta(merged, event.childThreadId, event.delta.delta);
        }
        return merged;
      }
      const renderId = merged.itemSlots[event.itemId];
      if (!renderId) return merged;
      const delta = event.delta;

      if (delta.type === "text_delta") {
        const nextState =
          merged.activeReasoningStartedAt !== null
            ? {
                ...merged,
                activeReasoningDurationMs:
                  merged.activeReasoningDurationMs + (Date.now() - merged.activeReasoningStartedAt),
                activeReasoningStartedAt: null,
              }
            : merged;
        return updateItem(nextState, renderId, (item) =>
          item.kind === "assistant" ? { ...item, text: item.text + delta.delta, thinkingDone: true } : item,
        );
      }

      if (delta.type === "thinking_delta") {
        const nextState =
          merged.activeReasoningStartedAt === null ? { ...merged, activeReasoningStartedAt: Date.now() } : merged;
        return updateItem(nextState, renderId, (item) =>
          item.kind === "assistant" ? { ...item, thinking: item.thinking + delta.delta } : item,
        );
      }

      if (delta.type === "content_block_delta") {
        return updateItem(merged, renderId, (item) =>
          item.kind === "assistant"
            ? {
                ...item,
                contentBlocks: [...item.contentBlocks, delta.block],
              }
            : item,
        );
      }

      return merged;
    }

    case "message_end": {
      if ("childThreadId" in event && typeof event.childThreadId === "string") {
        return finalizeChildAssistantTimeline(merged, event.childThreadId, event.message);
      }
      const renderId = merged.itemSlots[event.itemId];
      if (!renderId) return merged;
      const { [event.itemId]: _, ...remainingSlots } = merged.itemSlots;
      const { text: finalText, thinking: finalThinking } = extractAssistantTextFromMessage(event.message);
      const nextState =
        merged.activeReasoningStartedAt !== null
          ? {
              ...merged,
              activeReasoningDurationMs:
                merged.activeReasoningDurationMs + (Date.now() - merged.activeReasoningStartedAt),
              activeReasoningStartedAt: null,
            }
          : merged;
      const eventReasoningDuration = (event as { reasoningDurationMs?: number }).reasoningDurationMs;
      const measuredReasoningDuration =
        typeof eventReasoningDuration === "number"
          ? eventReasoningDuration
          : nextState.activeReasoningDurationMs > 0
            ? nextState.activeReasoningDurationMs
            : undefined;
      return {
        ...updateItem(nextState, renderId, (current) =>
          current.kind === "assistant"
            ? {
                ...current,
                thinkingDone: true,
                contentBlocks: event.message.content,
                timestamp:
                  typeof (event as { timestamp?: number }).timestamp === "number"
                    ? (event as { timestamp?: number }).timestamp!
                    : event.message.timestamp,
                text: current.text.length > 0 ? current.text : finalText,
                thinking: current.thinking.length > 0 ? current.thinking : finalThinking,
                ...(measuredReasoningDuration !== undefined ? { reasoningDurationMs: measuredReasoningDuration } : {}),
                ...(typeof (event as { turnDurationMs?: number }).turnDurationMs === "number"
                  ? { turnDurationMs: (event as { turnDurationMs?: number }).turnDurationMs }
                  : {}),
              }
            : current,
        ),
        itemSlots: remainingSlots,
      };
    }

    case "user_message": {
      const { text, images } = extractUserTextAndImages(event.message.content);
      // Hook-injected human edits precede the AttachedContext block; split them off first.
      const { humanEdits, remainingText: textWithoutHumanEdits } = parseHumanEditsFromText(text);
      const { contextItems, remainingText } = parseContextFromText(textWithoutHumanEdits);
      let nextState = merged;
      if (nextState.pendingSteers.length > 0) {
        const joinedSteers = nextState.pendingSteers.map((steer) => steer.content).join("\n");
        if (remainingText === joinedSteers || text === joinedSteers) {
          nextState = { ...nextState, pendingSteers: [] };
        }
      }
      if (humanEdits) {
        // The initiator normally never receives its own user_message echo; the
        // server sends it only when human edits were injected. Drop the
        // optimistic local echo so the canonical message takes its place.
        const localEchoIndex = nextState.items.findLastIndex(
          (item) => item.kind === "user" && item.id.startsWith("local-user-") && item.text === remainingText,
        );
        if (localEchoIndex !== -1) {
          const items = [...nextState.items];
          items.splice(localEchoIndex, 1);
          nextState = { ...nextState, items };
        }
      }
      nextState = withItem(nextState, `remote-user-${event.itemId}`, {
        id: `remote-user-${event.itemId}`,
        kind: "user",
        text: remainingText,
        contextItems,
        images,
        timestamp: event.message.timestamp,
      });
      if (humanEdits) {
        // The notice reads as the agent picking the edits up, so it sits
        // right below the prompt it belongs to.
        const humanEditsKey = `remote-user-${event.itemId}-human-edits`;
        nextState = withItem(nextState, humanEditsKey, {
          id: humanEditsKey,
          kind: "context",
          variant: "human-edits",
          summary: `\`\`\`\n${humanEdits}\n\`\`\``,
          timestamp: event.message.timestamp,
        });
      }
      return nextState;
    }

    case "status_change":
      return merged;

    case "usage":
      return {
        ...merged,
        usage: {
          inputTokens: merged.usage.inputTokens + event.usage.inputTokens,
          outputTokens: merged.usage.outputTokens + event.usage.outputTokens,
          cacheReadTokens: merged.usage.cacheReadTokens + event.usage.cacheReadTokens,
          cacheWriteTokens: merged.usage.cacheWriteTokens + event.usage.cacheWriteTokens,
          totalCost: merged.usage.totalCost + event.cost,
        },
        currentContextTokens: event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens,
      };

    case "error": {
      const now = Date.now();
      const message = getUserFacingErrorMessage(event.error);
      const eventTurnId = turnId ?? merged.activeTurnId ?? undefined;
      const settled = settleInFlightItems({
        ...merged,
        threadStatus: "idle",
        isCompacting: false,
        itemSlots: {},
        activeTurnId: null,
        activeTurnStartedAt: null,
        activeReasoningStartedAt: null,
        activeReasoningDurationMs: 0,
        activeTurnHadError: true,
        activeError: {
          id: `err-${now}`,
          message,
          name: event.error.name,
          fatal: event.fatal,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          timestamp: now,
          providerErrorType: event.error.providerErrorType,
        },
      });
      return settled;
    }

    case "knowledge_saved":
      return {
        ...merged,
        toast: {
          id: `info-${event.knowledgeId}`,
          kind: "info",
          message: "Knowledge updated",
        },
      };

    case "compaction_start":
      return { ...merged, isCompacting: true };

    case "compaction_end": {
      const contextKey = `event:compaction:${Date.now()}`;
      const nextState = { ...merged, isCompacting: false };
      return withItem(nextState, contextKey, {
        id: contextKey,
        kind: "context",
        summary: event.summary,
        timestamp: Date.now(),
      });
    }

    case "steering_injected": {
      const fallbackFromEvent = event.messages
        .filter((message) => message.role === "user")
        .map((message) => extractUserTextAndImages(message.content))
        .filter(({ text, images }) => text.length > 0 || images.length > 0);
      const steerIds = event.steerIds ?? [];
      const steerIdSet = new Set(steerIds);
      const drainedFromQueue =
        steerIds.length > 0
          ? merged.pendingSteers.filter((steer) => steerIdSet.has(steer.id))
          : merged.pendingSteers.slice(0, event.messageCount);
      const remaining =
        steerIds.length > 0
          ? merged.pendingSteers.filter((steer) => !steerIdSet.has(steer.id))
          : merged.pendingSteers.slice(event.messageCount);
      const drained =
        drainedFromQueue.length > 0
          ? drainedFromQueue.map((steer, index) => ({
              text: fallbackFromEvent[index]?.text || steer.content,
              images: fallbackFromEvent[index]?.images ?? [],
            }))
          : fallbackFromEvent.slice(0, event.messageCount);
      const newItems: RenderItem[] = drained.map(({ text, images }, i) => {
        const { contextItems, remainingText } = parseContextFromText(text);
        return {
          id: `steer-injected-${Date.now()}-${i}`,
          kind: "user" as const,
          text: remainingText,
          contextItems,
          images,
          timestamp: Date.now(),
        };
      });
      return {
        ...merged,
        pendingSteers: remaining,
        items: [...merged.items, ...newItems],
      };
    }

    case "turn_start": {
      // Child agent turn — update spawn item
      if (event.childThreadId) {
        const spawnItem = findCollabSpawnItem(merged, event.childThreadId);
        if (spawnItem) {
          return updateItem(merged, spawnItem.id, (item) =>
            item.kind === "collab" ? { ...item, turnNumber: event.turnNumber } : item,
          );
        }
      }
      return {
        ...merged,
        activeTurnHadError: false,
        activeTurnId: event.turnId,
        activeTurnStartedAt: Date.now(),
        activeReasoningStartedAt: null,
        activeReasoningDurationMs: 0,
      };
    }

    default:
      return merged;
  }
}

/** Settle all in-flight items after abort/interrupt:
 *  - assistant items with thinkingDone=false → set thinkingDone=true (stop the thinking spinner)
 *  - tool items with status="streaming" → set status="done" (stop the tool spinner)
 */
function settleInFlightItems(state: ThreadState): ThreadState {
  const hasInFlight = state.items.some(
    (i) => (i.kind === "assistant" && !i.thinkingDone) || (i.kind === "tool" && i.status === "streaming"),
  );
  if (!hasInFlight) return state;

  return {
    ...state,
    itemSlots: {},
    items: state.items.map((item) => {
      if (item.kind === "assistant" && !item.thinkingDone) {
        return { ...item, thinkingDone: true };
      }
      if (item.kind === "tool" && item.status === "streaming") {
        return { ...item, status: "done" as const };
      }
      return item;
    }),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toThreadStatus(value: unknown): ThreadStatus | undefined {
  return value === "idle" || value === "busy" ? value : undefined;
}

function shouldIgnoreNotificationForActiveThread(
  state: ThreadState,
  notification: DiligentServerNotification,
  params: Record<string, unknown> | null,
): boolean {
  if (
    notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED ||
    notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_RESUMED
  ) {
    return false;
  }
  if (!params || typeof params.threadId !== "string") return false;
  if (state.activeThreadId === null) return false;
  return params.threadId !== state.activeThreadId;
}

function applyAuthoritativeThreadStatus(state: ThreadState, params: Record<string, unknown> | null): ThreadState {
  const authoritativeStatus = toThreadStatus(params?.threadStatus);
  return authoritativeStatus ? { ...state, threadStatus: authoritativeStatus } : state;
}

function isThreadIdentityNotification(notification: DiligentServerNotification): boolean {
  return (
    notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED ||
    notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_RESUMED
  );
}

function getTurnTimingMetrics(state: ThreadState): { turnDurationMs?: number; reasoningDurationMs?: number } {
  const now = Date.now();
  const turnDurationMs = state.activeTurnStartedAt !== null ? Math.max(0, now - state.activeTurnStartedAt) : undefined;
  const elapsedReasoningMs =
    state.activeReasoningStartedAt !== null
      ? state.activeReasoningDurationMs + (now - state.activeReasoningStartedAt)
      : state.activeReasoningDurationMs;
  const reasoningDurationMs = elapsedReasoningMs > 0 ? elapsedReasoningMs : undefined;
  return { turnDurationMs, reasoningDurationMs };
}

function applyLatestAssistantDurations(
  state: ThreadState,
  turnDurationMs: number | undefined,
  reasoningDurationMs: number | undefined,
): ThreadState {
  let next = state;
  for (let i = next.items.length - 1; i >= 0; i--) {
    const item = next.items[i];
    if (item.kind !== "assistant") continue;
    next = updateItem(next, item.id, (current) =>
      current.kind === "assistant"
        ? {
            ...current,
            ...(turnDurationMs !== undefined ? { turnDurationMs } : {}),
            ...(reasoningDurationMs !== undefined ? { reasoningDurationMs } : {}),
          }
        : current,
    );
    break;
  }
  return next;
}

function handleTurnInterruptedNotification(state: ThreadState): ThreadState {
  const { turnDurationMs, reasoningDurationMs } = getTurnTimingMetrics(state);
  const settled = settleInFlightItems({
    ...state,
    threadStatus: "idle",
    isCompacting: false,
    itemSlots: {},
    activeTurnId: null,
    activeTurnStartedAt: null,
    activeReasoningStartedAt: null,
    activeReasoningDurationMs: 0,
    activeTurnHadError: false,
  });
  return applyLatestAssistantDurations(settled, turnDurationMs, reasoningDurationMs);
}

function handleTurnCompletedNotification(state: ThreadState, turnId: string): ThreadState {
  const { turnDurationMs, reasoningDurationMs } = getTurnTimingMetrics(state);
  const shouldClearActiveError = !state.activeTurnHadError && state.activeError?.turnId !== turnId;
  const settled = settleInFlightItems({
    ...state,
    itemSlots: {},
    activeTurnId: state.activeTurnId === turnId ? null : state.activeTurnId,
    activeTurnStartedAt: state.activeTurnId === turnId ? null : state.activeTurnStartedAt,
    activeReasoningStartedAt: null,
    activeReasoningDurationMs: 0,
    activeTurnHadError: false,
    activeError: shouldClearActiveError ? null : state.activeError,
  });
  return applyLatestAssistantDurations(settled, turnDurationMs, reasoningDurationMs);
}

function upsertLiveCompactionItem(state: ThreadState, summary: string, timestamp: number): ThreadState {
  const existing = state.items.findLast((item) => item.kind === "context");
  if (existing?.kind === "context") {
    return updateItem(state, existing.id, (item) => (item.kind === "context" ? { ...item, summary, timestamp } : item));
  }
  return withItem(state, `event:compaction:${timestamp}`, {
    id: `event:compaction:${timestamp}`,
    kind: "context",
    summary,
    timestamp,
  });
}

export function reduceServerNotification(
  state: ThreadState,
  notification: DiligentServerNotification,
  events: AgentEvent[],
): ThreadState {
  const params = asObject(notification.params);
  if (shouldIgnoreNotificationForActiveThread(state, notification, params)) {
    return state;
  }

  const stateWithAuthoritativeStatus = applyAuthoritativeThreadStatus(state, params);
  if (isThreadIdentityNotification(notification)) {
    // THREAD_STARTED/RESUMED can arrive before thread/read hydration. Keep
    // activeThreadId and items atomic so MessageList never flashes an empty or
    // previous transcript; explicit hydrate actions perform visible switches.
    return stateWithAuthoritativeStatus;
  }

  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED) {
    return handleTurnInterruptedNotification(stateWithAuthoritativeStatus);
  }

  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTION_STARTED) {
    return { ...stateWithAuthoritativeStatus, isCompacting: true };
  }

  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTED) {
    return upsertLiveCompactionItem(
      { ...stateWithAuthoritativeStatus, isCompacting: false },
      notification.params.summary,
      Date.now(),
    );
  }

  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
    const { turnId } = notification.params;
    return handleTurnCompletedNotification(stateWithAuthoritativeStatus, turnId);
  }

  // Delegate all item lifecycle, status, usage, error, knowledge, loop, steering to AgentEvent reducer
  let current = stateWithAuthoritativeStatus;
  const turnId = typeof params?.turnId === "string" ? params.turnId : undefined;
  for (const event of events) {
    current = reduceAgentEvent(current, event, turnId);
  }
  return current;
}
