// @summary Contracts for isolated runtime eval tasks, evidence, limits, and reports

import type { Message, Usage } from "@diligent/core/message-contract";
import type { ModelRef, SystemSection, ToolDefinition } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import type {
  DiligentServerNotification,
  DiligentServerRequest,
  DiligentServerRequestResponse,
  ThreadCompactStartResponse,
  ThreadReadResponse,
} from "@diligent/protocol";
import type {
  BundledToolProvider,
  CreateAppServerConfigOptions,
  Mode,
  ProviderName,
  RuntimeConfig,
} from "@diligent/runtime";
import type {
  EvalDiagnostic,
  EvalEventSnapshot,
  EvalExecutionError,
  EvalFailure,
  EvalLimits,
  EvalLogSnapshot,
  EvalProfile,
  EvalSemanticResult,
} from "./task";

export interface RuntimeEvalLimits extends EvalLimits {
  maxChangedFiles: number;
  maxChangedBytes: number;
  maxUserInputRequests: number;
  maxChildAgents: number;
  verifierTimeoutMs: number;
}

export interface RuntimeProtocolActionTrigger {
  source: "runtime_event" | "notification";
  eventType?: string;
  toolName?: string;
  isError?: boolean;
  method?: string;
  occurrence?: number;
  allowSubsequentMatches?: boolean;
}

export interface RuntimeTurnProtocolAction {
  id: string;
  timeoutMs: number;
  trigger: RuntimeProtocolActionTrigger;
  request: { method: string; params: Record<string, unknown> };
}

export type RuntimeEvalStep =
  | { kind: "turn"; message: string; mode?: Mode; actions?: readonly RuntimeTurnProtocolAction[] }
  | { kind: "compact" }
  | { kind: "restart_and_resume" };

export type RuntimeToolCapability = "read" | "write" | "execute" | "skill" | "knowledge" | "user_input" | "collab";

export interface RuntimeEvalToolPolicy {
  allowedTools?: readonly string[];
  allowedCapabilities: readonly RuntimeToolCapability[];
  allowedCommands: readonly string[];
}

export interface RuntimeToolTrace {
  sequence: number;
  toolCallId: string;
  name: string;
  capability: RuntimeToolCapability;
  threadId?: string;
  childThreadId?: string;
  input: unknown;
  outcome: "success" | "runtime_error" | "policy_rejection";
  output?: unknown;
  error?: string;
}

export interface RuntimeWorkspaceEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  sha256?: string;
  executable?: boolean;
}

export interface RuntimeWorldSnapshot {
  entries: RuntimeWorkspaceEntry[];
}

export type RuntimeStateCategory = "infrastructure" | "sessions" | "image_sidecars" | "knowledge" | "skills" | "other";

export interface RuntimeStatePolicy {
  allowedMutations: readonly RuntimeStateCategory[];
  requiredMutations?: readonly RuntimeStateCategory[];
}

export interface RuntimeStateEntry extends RuntimeWorkspaceEntry {
  category: RuntimeStateCategory;
}

export interface RuntimeStateChange {
  path: string;
  category: RuntimeStateCategory;
  change: "added" | "modified" | "removed";
}

export interface RuntimeStateEvidence {
  initial: RuntimeStateEntry[];
  final: RuntimeStateEntry[];
  diff: RuntimeStateChange[];
}

export interface RuntimeVerifierResult {
  argv: string[];
  exitCode: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RuntimeTurnTermination = "completed" | "interrupted" | "failed";
export interface RuntimeEvalTurnRecord {
  index: number;
  threadId: string;
  clientPrompt: string;
  startedAt: string;
  elapsedMs: number;
  termination: RuntimeTurnTermination;
  coreEvents: EvalEventSnapshot[];
  runtimeEvents: unknown[];
  notifications: DiligentServerNotification[];
  messages: Message[];
  usage: Usage;
}

export interface RuntimeEvalCompactionRecord {
  threadId: string;
  response: ThreadCompactStartResponse;
  notifications: DiligentServerNotification[];
}

export interface RuntimeAdvertisedToolsSnapshot {
  sequence: number;
  turnIndex: number;
  cwd: string;
  mode: Mode;
  provider: ProviderName;
  tools: string[];
}

export interface RuntimeThreadReadSnapshot {
  phase: "after_turn" | "after_resume";
  turnIndex?: number;
  response: ThreadReadResponse;
}

export interface RuntimeBoundedEvidenceCollection<T> {
  totalCount: number;
  includedCount: number;
  omittedCount: number;
  items: T[];
}

export interface RuntimeProviderEvidenceBounds {
  maxSourceItems: number;
  maxNestedItems: number;
  maxObjectProperties: number;
  maxStringChars: number;
  maxDepth: number;
  truncatedStrings: number;
  omittedNestedItems: number;
  omittedObjectProperties: number;
}

export interface RuntimeProviderCallEvidence {
  sequence: number;
  model: ModelRef;
  sessionId?: string;
  systemPrompt: RuntimeBoundedEvidenceCollection<SystemSection>;
  messages: RuntimeBoundedEvidenceCollection<unknown>;
  tools: RuntimeBoundedEvidenceCollection<ToolDefinition>;
  compactionSummary?: unknown;
  streamOptions: {
    maxTokens?: number;
    temperature?: number;
    sessionId?: string;
    effort?: string;
  };
  bounds: RuntimeProviderEvidenceBounds;
}

export interface RuntimeToolOutputFileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export type RuntimeProtocolActionStatus =
  | "awaiting_trigger"
  | "requested"
  | "completed"
  | "missing_trigger"
  | "repeated_trigger"
  | "request_failed";

export interface RuntimeProtocolActionTrace {
  id: string;
  turnIndex: number;
  status: RuntimeProtocolActionStatus;
  timeoutMs: number;
  trigger: RuntimeProtocolActionTrigger;
  triggerCount: number;
  triggeredAtMs?: number;
  triggerEvidence?: unknown;
  request: { method: string; params: Record<string, unknown> };
  requestedAtMs?: number;
  response?: unknown;
  respondedAtMs?: number;
  error?: string;
}

export type RuntimeEvalTerminationReason =
  | "completed"
  | "timeout"
  | "turn_limit"
  | "tool_call_limit"
  | "user_input_limit"
  | "child_agent_limit"
  | "workspace_limit"
  | "provider_error"
  | "runtime_error"
  | "runner_error";

export interface RuntimeSessionSnapshot {
  threadId: string;
  path?: string;
  lines: unknown[];
}

export interface RuntimeEvalExecution<TWorld> {
  taskId: string;
  profile: EvalProfile;
  seed: string;
  startedAt: string;
  elapsedMs: number;
  termination: RuntimeEvalTerminationReason;
  turns: RuntimeEvalTurnRecord[];
  compactions: RuntimeEvalCompactionRecord[];
  threadCwd: string;
  advertisedTools: RuntimeAdvertisedToolsSnapshot[];
  threadReads: RuntimeThreadReadSnapshot[];
  protocolActions: RuntimeProtocolActionTrace[];
  providerCalls: RuntimeProviderCallEvidence[];
  toolCalls: RuntimeToolTrace[];
  toolOutputFiles: RuntimeToolOutputFileEvidence[];
  approvals: unknown[];
  userInputRequests: unknown[];
  logs: EvalLogSnapshot[];
  session: RuntimeSessionSnapshot;
  childSessions: RuntimeSessionSnapshot[];
  workspace: { initial: RuntimeWorldSnapshot; final: RuntimeWorldSnapshot };
  runtimeState: RuntimeStateEvidence;
  verifier?: RuntimeVerifierResult;
  world: TWorld;
  error?: EvalExecutionError;
}

export interface RuntimeEvalTask<TWorld> {
  id: string;
  description: string;
  fixtureVersion: string;
  pluginDiscovery?: NonNullable<CreateAppServerConfigOptions["pluginDiscovery"]>;
  limits: RuntimeEvalLimits;
  toolPolicy: RuntimeEvalToolPolicy;
  statePolicy?: RuntimeStatePolicy;
  setup(seed: string, root: string, signal?: AbortSignal): Promise<TWorld>;
  resolveThreadCwd?(world: TWorld, fixtureRoot: string): string | Promise<string>;
  createRuntimeConfig(world: TWorld, profile: EvalProfile): Promise<RuntimeConfig>;
  createBundledToolProviders?(world: TWorld): readonly BundledToolProvider[] | Promise<readonly BundledToolProvider[]>;
  createSteps(world: TWorld): RuntimeEvalStep[];
  prepareStep?(world: TWorld, step: RuntimeEvalStep, index: number): void | Promise<void>;
  respondToServerRequest?(
    world: TWorld,
    request: DiligentServerRequest,
  ): DiligentServerRequestResponse | Promise<DiligentServerRequestResponse>;
  verify?(world: TWorld, signal: AbortSignal): Promise<RuntimeVerifierResult>;
  snapshotWorld(world: TWorld): Promise<unknown>;
  evaluate(input: RuntimeEvalExecution<TWorld>): EvalSemanticResult;
  cleanup?(world: TWorld): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: runtime task registry intentionally erases fixture world type
export type AnyRuntimeEvalTask = RuntimeEvalTask<any>;

export interface RuntimeEvalExecutionResult {
  passed: boolean;
  failure?: EvalFailure;
  failures: EvalFailure[];
  diagnostics?: EvalDiagnostic[];
  execution: RuntimeEvalExecution<unknown>;
  worldSnapshot: unknown;
}

export interface RuntimeEvalExecutionReport
  extends Omit<RuntimeEvalExecution<unknown>, "world" | "compactions" | "childSessions"> {
  taskSeed: string;
  fixtureVersion: string;
  limits: RuntimeEvalLimits;
  passed: boolean;
  failure?: EvalFailure;
  failures: EvalFailure[];
  diagnostics?: EvalDiagnostic[];
  compactions?: RuntimeEvalCompactionRecord[];
  childSessions?: RuntimeSessionSnapshot[];
  world: unknown;
}

export interface RuntimeEvalSuiteReport {
  schemaVersion: 1;
  suite: "runtime";
  suiteVersion: "runtime-v0";
  repository: string;
  commitSha: string;
  ref: string;
  runId: string;
  runAttempt: string;
  bunVersion: string;
  os: string;
  architecture: string;
  startedAt: string;
  endedAt: string;
  rootSeed: string;
  profiles: EvalProfile[];
  taskIds: string[];
  passed: boolean;
  executions: RuntimeEvalExecutionReport[];
}

export type RuntimeToolTransformer = (tools: Tool[]) => Tool[];
