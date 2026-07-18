// @summary Shared contracts for eval tasks, executions, failures, and reports

import type { CoreAgentEvent } from "@diligent/core/agent";
import type { Message, Usage } from "@diligent/core/message-contract";
import type { SystemSection } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import type { LogRecord } from "@diligent/logging";

export type EvalProvider = "openai" | "anthropic";

export interface EvalProfile {
  provider: EvalProvider;
  model: string;
  effort: "medium";
}

export type EvalTerminationReason =
  | "completed"
  | "timeout"
  | "turn_limit"
  | "tool_call_limit"
  | "provider_error"
  | "core_error"
  | "runner_error";

export interface EvalLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type EvalFailureCategory =
  | "configuration"
  | "provider_auth"
  | "provider_transient"
  | "provider_terminal"
  | "core_contract"
  | "runtime_contract"
  | "task_semantic"
  | "budget_exceeded"
  | "evaluator_error"
  | "runner_error";

export interface EvalFailure {
  category: EvalFailureCategory;
  code: string;
  message: string;
}

export interface EvalEventSnapshot {
  sequence: number;
  relativeMs: number;
  event: CoreAgentEvent;
}

export type EvalLogSnapshot = LogRecord;

export interface EvalExecutionError {
  name: string;
  message: string;
  stack?: string;
  providerErrorType?: string;
  providerErrorReason?: string;
  isRetryable?: boolean;
  statusCode?: number;
}

export interface EvalExecution<TWorld> {
  taskId: string;
  profile: EvalProfile;
  seed: string;
  startedAt: string;
  elapsedMs: number;
  termination: EvalTerminationReason;
  messages: Message[];
  events: EvalEventSnapshot[];
  logs: EvalLogSnapshot[];
  usage: Usage;
  turnCount: number;
  toolCallCount: number;
  world: TWorld;
  error?: EvalExecutionError;
}

export type EvalSemanticResult =
  | { passed: true }
  | {
      passed: false;
      code: string;
      message: string;
    };

export interface EvalTask<TWorld> {
  id: string;
  description: string;
  systemPrompt: SystemSection[];
  limits: EvalLimits;
  createWorld(seed: string): TWorld;
  createTools(world: TWorld): Tool[];
  createUserMessage(world: TWorld): Message;
  snapshotWorld(world: TWorld): unknown;
  evaluate(input: EvalExecution<TWorld>): EvalSemanticResult;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous task registries erase their task-specific world type
export type AnyEvalTask = EvalTask<any>;

export interface EvalExecutionResult<TWorld> {
  passed: boolean;
  failure?: EvalFailure;
  failures: EvalFailure[];
  execution: EvalExecution<TWorld>;
  worldSnapshot: unknown;
}

export interface EvalExecutionReport {
  taskId: string;
  taskSeed: string;
  profile: EvalProfile;
  maxOutputTokens: number;
  passed: boolean;
  termination: EvalTerminationReason;
  failure?: EvalFailure;
  failures: EvalFailure[];
  elapsedMs: number;
  usage: Usage;
  turnCount: number;
  toolCallCount: number;
  events: EvalEventSnapshot[];
  logs: EvalLogSnapshot[];
  messages: Message[];
  world: unknown;
}

export interface EvalSuiteReport {
  schemaVersion: 1;
  suite?: "core";
  suiteVersion: string;
  canonical: boolean;
  canonicalReason: string;
  repository: string;
  commitSha: string;
  ref: string;
  runId: string;
  runAttempt: string;
  bunVersion: string;
  startedAt: string;
  endedAt: string;
  rootSeed: string;
  profiles: EvalProfile[];
  taskIds: string[];
  passed: boolean;
  executions: EvalExecutionReport[];
}

export const ZERO_USAGE: Readonly<Usage> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
