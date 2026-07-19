// @summary AgentStatus, AgentEntry, CollabToolDeps, and CollabEvent types for non-blocking multi-agent collab

import type { Message } from "@diligent/core/message-contract";
import type { ModelClass } from "@diligent/core/model-registry";
import type { ModelRef, ThinkingEffort } from "@diligent/core/provider-contract";
import type { Tool, ToolOutputFileStore } from "@diligent/core/tool-contract";
import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import type { AgentEvent, ChildAgentEvent } from "../agent-event";
import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import type { DiligentPaths } from "../infrastructure";
import type { SessionManager } from "../session/manager";
import type { AgentLoopHookFactory } from "../tools/bundled-provider";
import type { UserInputRequest, UserInputResponse } from "../tools/user-input-types";

export interface ChildStopInfo {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  model: ModelRef;
  provider?: string;
  effort: ThinkingEffort;
  userId?: string;
  context: Message[];
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
  resumePolicy?: CollabResumePolicy;
}

/** Security-relevant child policy that must not broaden when a persisted child is resumed. */
export interface CollabResumePolicy {
  agentType: string;
  modelClass: ModelClass;
  allowedTools?: string[];
  allowNestedAgents: boolean;
}

/** Events emitted by the collab layer — collab boundary events + child tool/turn events with childThreadId. */
export type CollabAgentEvent = Extract<AgentEvent, { type: `collab_${string}` }> | ChildAgentEvent;

export interface CollabToolDeps {
  cwd: string;
  paths: DiligentPaths;
  model: ModelRef;
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
  streamFn?: import("@diligent/core/provider-contract").StreamFunction;
  /** Parent-selected full-output store, retained by every nested collaboration registry. */
  toolOutputStore?: ToolOutputFileStore;
  /** User ID to propagate into child stop hook inputs. */
  userId?: string;
  /** Runs the same external Stop lifecycle used for parent turns. */
  onChildStop?: (info: ChildStopInfo) => Promise<void>;
  /** Product hook factories are retained through nesting; each child receives fresh hook instances. */
  agentLoopHookFactories?: readonly AgentLoopHookFactory[];
}
