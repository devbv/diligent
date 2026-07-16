// @summary AgentStatus, AgentEntry, CollabToolDeps, and CollabEvent types for non-blocking multi-agent collab

import type { ThinkingEffort } from "@diligent/core/llm/types";
import type { Tool } from "@diligent/core/tool/types";
import type { Message } from "@diligent/core/types";
import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import type { AgentEvent } from "../agent-event";
import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import type { DiligentPaths } from "../infrastructure";
import type { SessionManager } from "../session/manager";
import type { AgentLoopHookFactory } from "../tools/bundled-provider";
import type { UserInputRequest, UserInputResponse } from "../tools/user-input-types";

export interface ChildStopInfo {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  model: string;
  provider?: string;
  effort: ThinkingEffort;
  userId?: string;
  context: Message[];
  isRerun: boolean;
}

export type AgentStatus =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "completed"; output: string | null }
  | { kind: "errored"; error: string }
  | { kind: "shutdown" };

export function isFinal(s: AgentStatus): boolean {
  return s.kind !== "pending" && s.kind !== "running";
}

export interface AgentEntry {
  threadId: string;
  nickname: string;
  agentType: string;
  description: string;
  sessionManager: SessionManager;
  promise: Promise<AgentStatus>; // always resolves, never rejects
  status: AgentStatus;
  abortController: AbortController;
  createdAt: number;
}

/** Events emitted by the collab layer — collab boundary events + child tool/turn events with childThreadId. */
export type CollabAgentEvent =
  | Extract<AgentEvent, { type: `collab_${string}` }>
  | (Extract<AgentEvent, { type: "turn_start" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "message_start" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "message_discarded" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "message_delta" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "message_end" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "tool_start" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "tool_update" }> & { childThreadId: string })
  | (Extract<AgentEvent, { type: "tool_end" }> & { childThreadId: string });

export interface CollabToolDeps {
  cwd: string;
  paths: DiligentPaths;
  modelId: string;
  effort: ThinkingEffort;
  agentDefinitions: ResolvedAgentDefinition[];
  parentTools: Tool[];
  maxAgents?: number; // default 8
  /**
   * Maximum nesting depth for child agents. Decremented on each spawn.
   * Spawn is refused when depth reaches 0. Default: 3.
   */
  depth?: number;
  getParentSessionId?: () => string | undefined;
  sessionManagerFactory?: (config: import("../session/manager").SessionManagerConfig) => SessionManager;
  /** Called when collab boundary events fire (spawn/wait/close begin+end). */
  onCollabEvent?: (event: CollabAgentEvent) => void;
  /** Routes sub-agent user input requests up to the parent session's ask handler. */
  ask?: (request: UserInputRequest) => Promise<UserInputResponse>;
  /** Routes sub-agent approval requests up to the parent session's approval handler. */
  approve?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /** Stream function for child agents — when omitted, falls back to the global stream resolver. */
  streamFn?: import("@diligent/core/llm/types").StreamFunction;
  /**
   * Called when a child agent's turn completes normally.
   * Return `{ continueWith }` to re-run the child (e.g. when a Stop hook blocks).
   */
  /** User ID to propagate into child stop hook inputs. */
  userId?: string;
  onChildStop?: (info: ChildStopInfo) => Promise<{ continueWith?: Message } | undefined>;
  /** Product hook factories are retained through nesting; each child receives fresh hook instances. */
  agentLoopHookFactories?: readonly AgentLoopHookFactory[];
}
