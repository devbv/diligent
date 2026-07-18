// @summary Runs the runtime task/profile matrix sequentially into one discriminated report

import { arch, platform } from "node:os";
import type { StreamFunction } from "@diligent/core/provider-contract";
import type {
  AnyRuntimeEvalTask,
  RuntimeEvalExecutionReport,
  RuntimeEvalExecutionResult,
  RuntimeEvalSuiteReport,
} from "../runtime-task";
import type { EvalProfile } from "../task";
import { runRuntimeEvalExecution } from "./runtime-execution";
import { deriveTaskSeed } from "./seed";
import type { EvalCanonicalManifest, EvalRunMetadata } from "./suite";

export async function runRuntimeEvalSuite(input: {
  tasks: readonly AnyRuntimeEvalTask[];
  profiles: readonly EvalProfile[];
  rootSeed: string;
  metadata: EvalRunMetadata;
  canonicalManifest?: EvalCanonicalManifest;
  createStream(profile: EvalProfile): StreamFunction;
  onExecutionStart?: (task: AnyRuntimeEvalTask, profile: EvalProfile) => void;
  onExecutionEnd?: (result: RuntimeEvalExecutionResult) => void;
}): Promise<RuntimeEvalSuiteReport> {
  validate(input.tasks, input.profiles, input.metadata.canonical, input.canonicalManifest);
  const startedAt = new Date();
  const executions: RuntimeEvalExecutionReport[] = [];
  for (const task of input.tasks) {
    const taskSeed = deriveTaskSeed(input.rootSeed, task.id);
    for (const profile of input.profiles) {
      input.onExecutionStart?.(task, profile);
      const result = await runRuntimeEvalExecution({
        task,
        profile,
        seed: taskSeed,
        streamFunction: input.createStream(profile),
      });
      executions.push({
        ...result.execution,
        taskSeed,
        fixtureVersion: task.fixtureVersion,
        limits: task.limits,
        passed: result.passed,
        ...(result.failure && { failure: result.failure }),
        failures: result.failures,
        world: result.worldSnapshot,
      });
      input.onExecutionEnd?.(result);
    }
  }
  return {
    schemaVersion: 1,
    suite: "runtime",
    suiteVersion: "runtime-v0",
    canonical: input.metadata.canonical,
    canonicalReason: input.metadata.canonicalReason,
    repository: input.metadata.repository,
    commitSha: input.metadata.commitSha,
    ref: input.metadata.ref,
    runId: input.metadata.runId,
    runAttempt: input.metadata.runAttempt,
    bunVersion: input.metadata.bunVersion,
    os: platform(),
    architecture: arch(),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    rootSeed: input.rootSeed,
    profiles: input.profiles.map((profile) => ({ ...profile })),
    taskIds: input.tasks.map((task) => task.id),
    passed: executions.every((execution) => execution.passed),
    executions,
  };
}

function validate(
  tasks: readonly AnyRuntimeEvalTask[],
  profiles: readonly EvalProfile[],
  canonical: boolean,
  manifest?: EvalCanonicalManifest,
): void {
  if (tasks.length === 0 || profiles.length === 0) throw new Error("Runtime eval selection cannot be empty.");
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("Duplicate runtime eval task ID.");
  if (!canonical) return;
  if (!manifest) throw new Error("Canonical runtime eval execution requires a canonical manifest.");
  const selectedTasks = tasks
    .map((task) => task.id)
    .sort()
    .join("|");
  const requiredTasks = [...manifest.taskIds].sort().join("|");
  const key = (profile: EvalProfile) => `${profile.provider}:${profile.model}:${profile.effort}`;
  if (
    selectedTasks !== requiredTasks ||
    profiles.map(key).sort().join("|") !== manifest.profiles.map(key).sort().join("|")
  )
    throw new Error("Canonical runtime eval runs require the exact canonical task and profile manifest.");
}
