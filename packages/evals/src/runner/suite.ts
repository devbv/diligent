// @summary Runs selected eval task/profile combinations sequentially into one report

import type { Model, StreamFunction } from "@diligent/core/provider-contract";
import {
  type AnyEvalTask,
  aggregateEvalStatuses,
  type EvalExecutionReport,
  type EvalExecutionResult,
  type EvalProfile,
  type EvalSuiteReport,
} from "../task";
import { runEvalExecution } from "./execution";
import { deriveTaskSeed } from "./seed";

export interface EvalRunMetadata {
  suiteVersion: string;
  repository: string;
  commitSha: string;
  ref: string;
  runId: string;
  runAttempt: string;
  bunVersion: string;
}

export interface RunEvalSuiteInput {
  tasks: readonly AnyEvalTask[];
  profiles: readonly EvalProfile[];
  rootSeed: string;
  metadata: EvalRunMetadata;
  resolveModel(profile: EvalProfile): Model;
  createStream(profile: EvalProfile): StreamFunction;
  onExecutionStart?: (task: AnyEvalTask, profile: EvalProfile) => void;
  onExecutionEnd?: (result: EvalExecutionResult<unknown>) => void;
  execute?: (input: Parameters<typeof runEvalExecution>[0]) => Promise<EvalExecutionResult<unknown>>;
}

export async function runEvalSuite(input: RunEvalSuiteInput): Promise<EvalSuiteReport> {
  validateSelection(input.tasks, input.profiles);
  const startedAt = new Date();
  const executions: EvalExecutionReport[] = [];

  for (const task of input.tasks) {
    const taskSeed = deriveTaskSeed(input.rootSeed, task.id);
    for (const profile of input.profiles) {
      input.onExecutionStart?.(task, profile);
      const execute = input.execute ?? runEvalExecution;
      const result = await execute({
        task,
        profile,
        model: input.resolveModel(profile),
        seed: taskSeed,
        streamFunction: input.createStream(profile),
      });
      executions.push(toExecutionReport(result, task.limits.maxOutputTokens));
      input.onExecutionEnd?.(result);
    }
  }

  return {
    schemaVersion: 1,
    suiteVersion: input.metadata.suiteVersion,
    repository: input.metadata.repository,
    commitSha: input.metadata.commitSha,
    ref: input.metadata.ref,
    runId: input.metadata.runId,
    runAttempt: input.metadata.runAttempt,
    bunVersion: input.metadata.bunVersion,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    rootSeed: input.rootSeed,
    profiles: input.profiles.map((profile) => ({ ...profile })),
    taskIds: input.tasks.map((task) => task.id),
    passed: executions.every((execution) => execution.passed),
    status: aggregateEvalStatuses(executions.map((execution) => execution.status)),
    executions,
  };
}

function toExecutionReport(result: EvalExecutionResult<unknown>, maxOutputTokens: number): EvalExecutionReport {
  return {
    taskId: result.execution.taskId,
    taskSeed: result.execution.seed,
    profile: { ...result.execution.profile },
    maxOutputTokens,
    passed: result.passed,
    status: result.status,
    termination: result.execution.termination,
    ...(result.failure && { failure: { ...result.failure } }),
    failures: result.failures.map((failure) => ({ ...failure })),
    ...(result.diagnostics?.length && { diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
    elapsedMs: result.execution.elapsedMs,
    usage: { ...result.execution.usage },
    turnCount: result.execution.turnCount,
    toolCallCount: result.execution.toolCallCount,
    events: result.execution.events,
    logs: result.execution.logs,
    messages: result.execution.messages,
    world: result.worldSnapshot,
  };
}

function validateSelection(tasks: readonly AnyEvalTask[], profiles: readonly EvalProfile[]): void {
  if (tasks.length === 0) throw new Error("No eval tasks were selected.");
  if (profiles.length === 0) throw new Error("No eval profiles were selected.");
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("Duplicate eval task ID.");
  const profileKeys = profiles.map(profileKey);
  if (new Set(profileKeys).size !== profileKeys.length) throw new Error("Duplicate eval profile.");
}

function profileKey(profile: EvalProfile): string {
  return `${profile.provider}:${profile.model}:${profile.effort}`;
}
