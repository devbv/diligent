// @summary Contracts for isolated runtime eval tasks, evidence, limits, and reports

import type { Message, Usage } from "@diligent/core/message-contract";
import type { Tool } from "@diligent/core/tool-contract";
import type { DiligentServerNotification } from "@diligent/protocol";
import type { Mode, RuntimeConfig } from "@diligent/runtime";
import type {
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

export type RuntimeEvalStep = { kind: "turn"; message: string; mode?: Mode } | { kind: "restart_and_resume" };

export type RuntimeToolCapability = "read" | "write" | "execute" | "skill" | "knowledge" | "user_input" | "collab";

export interface RuntimeEvalToolPolicy {
  allowedTools?: readonly string[];
  allowedCapabilities: readonly RuntimeToolCapability[];
  allowedCommands: readonly string[];
}

export interface RuntimeToolTrace {
  sequence: number;
  name: string;
  capability: RuntimeToolCapability;
  input: unknown;
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
  startedAt: string;
  elapsedMs: number;
  termination: RuntimeTurnTermination;
  coreEvents: EvalEventSnapshot[];
  runtimeEvents: unknown[];
  notifications: DiligentServerNotification[];
  messages: Message[];
  usage: Usage;
}

export type RuntimeEvalTerminationReason =
  | "completed"
  | "timeout"
  | "turn_limit"
  | "tool_call_limit"
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
  toolCalls: RuntimeToolTrace[];
  approvals: unknown[];
  userInputRequests: unknown[];
  logs: EvalLogSnapshot[];
  session: RuntimeSessionSnapshot;
  workspace: { initial: RuntimeWorldSnapshot; final: RuntimeWorldSnapshot };
  verifier?: RuntimeVerifierResult;
  world: TWorld;
  error?: EvalExecutionError;
}

export interface RuntimeEvalTask<TWorld> {
  id: string;
  description: string;
  fixtureVersion: string;
  limits: RuntimeEvalLimits;
  toolPolicy: RuntimeEvalToolPolicy;
  setup(seed: string, root: string): Promise<TWorld>;
  createRuntimeConfig(world: TWorld, profile: EvalProfile): Promise<RuntimeConfig>;
  createSteps(world: TWorld): RuntimeEvalStep[];
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
  execution: RuntimeEvalExecution<unknown>;
  worldSnapshot: unknown;
}

export interface RuntimeEvalExecutionReport extends Omit<RuntimeEvalExecution<unknown>, "world"> {
  taskSeed: string;
  fixtureVersion: string;
  limits: RuntimeEvalLimits;
  passed: boolean;
  failure?: EvalFailure;
  failures: EvalFailure[];
  world: unknown;
}

export interface RuntimeEvalSuiteReport {
  schemaVersion: 1;
  suite: "runtime";
  suiteVersion: "runtime-v0";
  canonical: boolean;
  canonicalReason: string;
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
