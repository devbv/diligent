// @summary CLI entrypoint for complete or task-filtered core and runtime eval runs

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCliOptions } from "./cli-options";
import { createProfileStream, resolveProfileModel, resolveSelectedProfiles, validateCredentials } from "./profiles";
import { redactEvalText, writeEvalReport } from "./reporters/json";
import { runRuntimeEvalSuite } from "./runner/runtime-suite";
import { createGithubRootSeed, createRandomRootSeed } from "./runner/seed";
import { runEvalSuite } from "./runner/suite";
import type { RuntimeEvalExecutionResult } from "./runtime-task";
import type { AnyEvalTask, EvalExecutionResult, EvalProfile } from "./task";
import { CORE_EVAL_TASKS } from "./tasks/core";
import { RUNTIME_EVAL_TASKS } from "./tasks/runtime";

const SUITE_VERSION = "core-v0";

export async function main(args = process.argv.slice(2)): Promise<number> {
  const secrets = [process.env.OPENAI_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? ""].filter(Boolean);
  try {
    const options = parseCliOptions(args);
    if (options.help) {
      printHelp();
      return 0;
    }

    const profiles = resolveSelectedProfiles(options);
    const tasks = options.suite === "core" ? selectCoreTasks(options.task) : selectRuntimeTasks(options.task);
    validateCredentials(profiles);
    const metadata = resolveRunMetadata();
    const rootSeed =
      options.seed ??
      (metadata.runId !== "local"
        ? createGithubRootSeed(metadata.repository, metadata.runId, metadata.commitSha)
        : createRandomRootSeed());

    console.log(`[eval] ${options.suite} suite: ${tasks.length} task(s) x ${profiles.length} profile(s)`);
    const shared = {
      profiles,
      rootSeed,
      metadata,
      createStream: createProfileStream,
      onExecutionStart: (task: { id: string }, profile: EvalProfile) => {
        console.log(`[eval] start ${task.id} / ${profile.provider} / ${profile.model}`);
      },
    };
    const report =
      options.suite === "core"
        ? await runEvalSuite({
            ...shared,
            tasks: tasks as AnyEvalTask[],
            resolveModel: resolveProfileModel,
            onExecutionEnd: (result) => printExecutionResult(result, secrets),
          })
        : await runRuntimeEvalSuite({
            ...shared,
            tasks: tasks as typeof RUNTIME_EVAL_TASKS,
            onExecutionEnd: (result) => printRuntimeExecutionResult(result, secrets),
          });

    const reportPath = options.reportPath ?? defaultReportPath(options.suite);
    await writeEvalReport(reportPath, report, { secrets });
    console.log(`[eval] report ${reportPath}`);
    await writeGithubSummary(report, reportPath);
    return report.passed ? 0 : 1;
  } catch (error) {
    const message = redactEvalText(error instanceof Error ? error.message : String(error), secrets);
    console.error(`[eval] configuration or runner error: ${message}`);
    return 2;
  }
}

export function selectCoreTasks(taskId?: string): AnyEvalTask[] {
  if (!taskId) return [...CORE_EVAL_TASKS];
  const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown core eval task "${taskId}".`);
  return [task];
}

export function selectRuntimeTasks(taskId?: string) {
  if (!taskId) return [...RUNTIME_EVAL_TASKS];
  const task = RUNTIME_EVAL_TASKS.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown runtime eval task "${taskId}".`);
  return [task];
}

function resolveRunMetadata() {
  const commitSha = process.env.GITHUB_SHA?.trim() || localCommitSha();
  return {
    suiteVersion: SUITE_VERSION,
    repository: process.env.GITHUB_REPOSITORY?.trim() || "local/diligent",
    commitSha,
    ref: process.env.GITHUB_REF?.trim() || "local",
    runId: process.env.GITHUB_RUN_ID?.trim() || "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() || "1",
    bunVersion: Bun.version,
  };
}

function localCommitSha(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return "unknown";
  return new TextDecoder().decode(result.stdout).trim() || "unknown";
}

export function defaultReportPath(suite: "core" | "runtime", now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(":", "-");
  return join("artifacts", "evals", `${suite}-${timestamp}.json`);
}

function printExecutionResult(result: EvalExecutionResult<unknown>, secrets: readonly string[]): void {
  const identity = `${result.execution.taskId} / ${result.execution.profile.provider}`;
  if (result.passed) {
    console.log(
      `[eval] pass ${identity} (${result.execution.elapsedMs}ms, turns=${result.execution.turnCount}, tools=${result.execution.toolCallCount})`,
    );
    return;
  }
  const failure = result.failure;
  const detail = failure ? `${failure.code}: ${failure.message}` : result.execution.termination;
  console.error(`[eval] fail ${identity}: ${redactEvalText(detail, secrets)}`);
}

function printRuntimeExecutionResult(result: RuntimeEvalExecutionResult, secrets: readonly string[]): void {
  const identity = `${result.execution.taskId} / ${result.execution.profile.provider}`;
  if (result.passed) {
    console.log(
      `[eval] pass ${identity} (${result.execution.elapsedMs}ms, turns=${result.execution.turns.length}, tools=${result.execution.toolCalls.length})`,
    );
    return;
  }
  const detail = result.failure ? `${result.failure.code}: ${result.failure.message}` : result.execution.termination;
  console.error(`[eval] fail ${identity}: ${redactEvalText(detail, secrets)}`);
}

async function writeGithubSummary(
  report: Awaited<ReturnType<typeof runEvalSuite>> | Awaited<ReturnType<typeof runRuntimeEvalSuite>>,
  reportPath: string,
): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [
    `## ${"suite" in report && report.suite === "runtime" ? "Runtime" : "Core"} eval suite`,
    "",
    `- Status: ${report.passed ? "PASS" : "FAIL"}`,
    `- Commit: \`${report.commitSha}\``,
    `- Results: ${report.executions.filter((execution) => execution.passed).length}/${report.executions.length}`,
    `- Report: \`${reportPath}\``,
    "",
  ];
  await appendFile(path, lines.join("\n"), "utf8");
}

function printHelp(): void {
  console.log(`Usage:
  bun run eval core [--provider openai|anthropic] [--task <id>]
                      [--model <model-id>]
                      [--seed <seed>] [--report <path>]

  bun run eval runtime [--provider openai|anthropic] [--task <id>]
                         [--model <model-id>] [--seed <seed>] [--report <path>]

Omitting --task runs every task in the selected suite. Omitting --provider runs both providers.`);
}

if (import.meta.main) {
  process.exitCode = await main();
}
