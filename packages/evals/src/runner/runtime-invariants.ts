// @summary Deterministic protocol, lifecycle, session, workspace, and budget invariants for runtime evals

import { DiligentServerNotificationSchema } from "@diligent/protocol";
import { EXECUTE_MODE_DISALLOWED_TOOLS, PLAN_MODE_DISALLOWED_TOOLS } from "@diligent/runtime";
import type { RuntimeEvalExecution, RuntimeEvalLimits, RuntimeStatePolicy } from "../runtime-task";
import type { EvalFailure } from "../task";
import { checkStructuralInvariants } from "./invariants";
import { checkRuntimeStatePolicy, projectSnapshotWithoutRuntimeState } from "./runtime-state";
import { workspaceDiff } from "./runtime-workspace";

export function checkRuntimeInvariants(
  execution: RuntimeEvalExecution<unknown>,
  limits: RuntimeEvalLimits,
  statePolicy: RuntimeStatePolicy = { allowedMutations: ["infrastructure", "sessions"] },
): EvalFailure[] {
  const failures: EvalFailure[] = [];
  failures.push(...checkAdvertisedToolSnapshots(execution));
  failures.push(...checkThreadReadSnapshots(execution));
  for (const turn of execution.turns) {
    const parentCoreEvents = turn.coreEvents.filter(
      (item) => !(item.event as { childThreadId?: string }).childThreadId,
    );
    failures.push(
      ...checkStructuralInvariants(
        {
          taskId: execution.taskId,
          profile: execution.profile,
          seed: execution.seed,
          startedAt: turn.startedAt,
          elapsedMs: turn.elapsedMs,
          termination: turn.termination === "completed" ? "completed" : "core_error",
          messages: turn.messages,
          events: parentCoreEvents,
          logs: [],
          usage: turn.usage,
          turnCount: parentCoreEvents.filter((item) => item.event.type === "turn_start").length,
          toolCallCount: parentCoreEvents.filter((item) => item.event.type === "tool_start").length,
          world: null,
        },
        { allowMultipleAgentLifecycles: true },
      ),
    );
    for (const notification of turn.notifications) {
      if (!DiligentServerNotificationSchema.safeParse(notification).success)
        failures.push(failure("invalid_notification", "A runtime notification did not match the protocol schema."));
    }
    const starts = turn.notifications.filter((item) => item.method === "turn/started").length;
    const terminals = turn.notifications.filter(
      (item) => item.method === "turn/completed" || item.method === "turn/interrupted",
    ).length;
    if (starts !== 1 || terminals !== 1)
      failures.push(failure("turn_lifecycle", `Expected one start and terminal, received ${starts}/${terminals}.`));
    if (turn.termination !== "completed")
      failures.push(failure("turn_interrupted", "An interrupted runtime turn cannot pass."));
  }
  for (const compaction of execution.compactions) {
    for (const notification of compaction.notifications) {
      if (!DiligentServerNotificationSchema.safeParse(notification).success)
        failures.push(failure("invalid_notification", "A compaction notification did not match the protocol schema."));
    }
    const starts = compaction.notifications.filter((item) => item.method === "thread/compaction/started").length;
    const terminals = compaction.notifications.filter((item) => item.method === "thread/compacted").length;
    if (starts !== 1 || terminals !== 1)
      failures.push(
        failure("compaction_lifecycle", `Expected one compaction start and terminal, received ${starts}/${terminals}.`),
      );
    if (!compaction.response.compacted)
      failures.push(failure("compaction_result", "Manual compaction did not report a compacted result."));
  }
  const runtimeEvents = execution.turns.flatMap((turn) => turn.runtimeEvents) as Array<{
    type?: string;
    childThreadId?: string;
    status?: string;
  }>;
  const childIds = new Set(
    runtimeEvents
      .filter((event) => event.type === "collab_spawn_end" && event.childThreadId)
      .map((event) => event.childThreadId!),
  );
  if (childIds.size > limits.maxChildAgents)
    failures.push(budget("child_agents", `Spawned ${childIds.size} child agents.`));
  for (const childId of childIds) {
    const completed = runtimeEvents.some(
      (event) => event.type === "collab_spawn_end" && event.childThreadId === childId && event.status === "completed",
    );
    if (!completed)
      failures.push(failure("child_not_completed", `Child agent ${childId} did not reach completed status.`));
    const session = execution.childSessions.find((candidate) => candidate.threadId === childId);
    const header = session?.lines[0] as { id?: string; parentSession?: string } | undefined;
    if (!header || header.id !== childId || header.parentSession !== execution.session.threadId)
      failures.push(failure("child_session", `Child agent ${childId} did not persist a linked session.`));
  }
  const untrackedChildSessions = execution.childSessions.filter((session) => !childIds.has(session.threadId));
  if (untrackedChildSessions.length > 0)
    failures.push(failure("child_session", "A child session had no matching collaboration lifecycle event."));
  if (execution.workspace.final.entries.some((entry) => entry.kind === "symlink"))
    failures.push(failure("workspace_symlink", "A symlink appeared in the runtime workspace."));
  const threadRelative =
    execution.threadCwd === "$WORKSPACE"
      ? ""
      : execution.threadCwd.startsWith("$WORKSPACE/")
        ? `${execution.threadCwd.slice("$WORKSPACE/".length)}/`
        : undefined;
  const runtimeStateRoots = [".diligent", ...(threadRelative === undefined ? [] : [`${threadRelative}.diligent`])];
  const projectOnly = (snapshot: typeof execution.workspace.initial) =>
    projectSnapshotWithoutRuntimeState(snapshot, runtimeStateRoots);
  const diff = workspaceDiff(projectOnly(execution.workspace.initial), projectOnly(execution.workspace.final));
  if (diff.changedFiles.length > limits.maxChangedFiles)
    failures.push(budget("changed_files", `Changed ${diff.changedFiles.length} project files.`));
  if (diff.changedBytes > limits.maxChangedBytes)
    failures.push(budget("changed_bytes", `Changed project bytes total ${diff.changedBytes}.`));
  const world = execution.world as { protectedPaths?: string[]; allowedChanges?: string[] };
  const allowedChanges = new Set(world.allowedChanges ?? []);
  const unexpected = diff.changedFiles.filter((path) => !allowedChanges.has(path));
  if (unexpected.length > 0)
    failures.push(failure("unexpected_mutation", `Unexpected project mutations: ${unexpected.join(", ")}.`));
  const protectedPaths = new Set(world.protectedPaths ?? []);
  if (diff.changedFiles.some((path) => protectedPaths.has(path)))
    failures.push(failure("protected_file_changed", "A protected fixture file changed."));
  failures.push(...checkRuntimeStatePolicy(execution.runtimeState, statePolicy, execution.termination === "completed"));
  if (execution.userInputRequests.length > limits.maxUserInputRequests)
    failures.push(failure("unexpected_user_input", "Unexpected user input request."));
  const header = execution.session.lines[0] as { id?: string } | undefined;
  if (!header || header.id !== execution.session.threadId)
    failures.push(failure("session_header", "Session header does not match the thread ID."));
  const entries = execution.session.lines.slice(1) as Array<{ id?: string; parentId?: string | null }>;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id))
      failures.push(failure("session_parent_chain", "Session entry IDs must be unique."));
    if (entry.parentId && !seen.has(entry.parentId))
      failures.push(failure("session_parent_chain", "Session parent must point to an earlier entry."));
    if (entry.id) seen.add(entry.id);
  }
  return dedupe(failures);
}

function checkAdvertisedToolSnapshots(execution: RuntimeEvalExecution<unknown>): EvalFailure[] {
  const failures: EvalFailure[] = [];
  for (const snapshot of execution.advertisedTools) {
    if (snapshot.cwd !== execution.threadCwd)
      failures.push(failure("advertised_tools_context", "Advertised tool cwd does not match the thread cwd."));
    if (snapshot.provider !== execution.profile.provider)
      failures.push(failure("advertised_tools_context", "Advertised tool provider does not match the eval profile."));
    const disallowed =
      snapshot.mode === "plan"
        ? PLAN_MODE_DISALLOWED_TOOLS
        : snapshot.mode === "execute"
          ? EXECUTE_MODE_DISALLOWED_TOOLS
          : new Set<string>();
    const unexpected = snapshot.tools.filter((tool) => disallowed.has(tool));
    if (unexpected.length > 0)
      failures.push(
        failure(
          "mode_tool_surface",
          `${snapshot.mode} mode advertised disallowed tools before task filtering: ${unexpected.join(", ")}.`,
        ),
      );
    if (new Set(snapshot.tools).size !== snapshot.tools.length)
      failures.push(failure("advertised_tools_duplicate", "An advertised tool snapshot contains duplicate names."));
  }
  if (execution.turns.length > 0 && execution.advertisedTools.length === 0)
    failures.push(failure("advertised_tools_missing", "No pre-policy advertised tool snapshot was recorded."));
  return failures;
}

function checkThreadReadSnapshots(execution: RuntimeEvalExecution<unknown>): EvalFailure[] {
  const failures: EvalFailure[] = [];
  for (const turn of execution.turns) {
    if (
      turn.termination === "completed" &&
      !execution.threadReads.some((snapshot) => snapshot.phase === "after_turn" && snapshot.turnIndex === turn.index)
    )
      failures.push(failure("thread_read_missing", `Completed turn ${turn.index} has no thread/read snapshot.`));
  }
  for (const snapshot of execution.threadReads) {
    if (snapshot.response.cwd !== execution.threadCwd)
      failures.push(failure("thread_read_context", "thread/read cwd does not match the effective thread cwd."));
    if (snapshot.response.isRunning)
      failures.push(failure("thread_read_running", "A post-turn or post-resume thread/read snapshot remained busy."));
    if (snapshot.response.currentModel?.provider !== execution.profile.provider)
      failures.push(failure("thread_read_context", "thread/read provider does not match the eval profile."));
  }

  const latest = execution.threadReads.at(-1)?.response;
  if (!latest || execution.session.lines.length === 0) return failures;
  if (latest.entryCount !== execution.session.lines.length - 1)
    failures.push(
      failure(
        "thread_read_entry_count",
        `thread/read reported ${latest.entryCount} entries for ${execution.session.lines.length - 1} persisted entries.`,
      ),
    );

  const items = latest.items as Array<{ type?: string; itemId?: string; toolCallId?: string }>;
  const hasItem = (type: string, itemId: string) => items.some((item) => item.type === type && item.itemId === itemId);
  for (const rawLine of execution.session.lines.slice(1)) {
    const line = rawLine as {
      type?: string;
      id?: string;
      visibility?: string;
      presentation?: unknown;
      message?: { role?: string; toolCallId?: string };
    };
    if (!line.id) continue;
    if (line.type === "compaction" && !hasItem("compaction", line.id))
      failures.push(failure("thread_read_parity", `thread/read omitted persisted compaction ${line.id}.`));
    if (line.type !== "message") continue;
    if (line.visibility === "internal") {
      if (line.presentation && !hasItem("contextMessage", line.id))
        failures.push(failure("thread_read_parity", `thread/read omitted presented internal entry ${line.id}.`));
      continue;
    }
    if (line.message?.role === "user" && !hasItem("userMessage", line.id))
      failures.push(failure("thread_read_parity", `thread/read omitted persisted user message ${line.id}.`));
    if (line.message?.role === "assistant" && !hasItem("agentMessage", line.id))
      failures.push(failure("thread_read_parity", `thread/read omitted persisted assistant message ${line.id}.`));
    if (
      line.message?.role === "tool_result" &&
      !items.some((item) => item.type === "toolCall" && item.toolCallId === line.message?.toolCallId)
    )
      failures.push(
        failure("thread_read_parity", `thread/read omitted persisted tool result ${line.message.toolCallId}.`),
      );
  }
  return failures;
}

function failure(code: string, message: string): EvalFailure {
  return { dimension: "runtime_policy", category: "runtime_contract", code: `runtime_contract.${code}`, message };
}
function budget(code: string, message: string): EvalFailure {
  return { dimension: "harness_terminal", category: "budget_exceeded", code: `budget_exceeded.${code}`, message };
}
function dedupe(failures: EvalFailure[]): EvalFailure[] {
  return [...new Map(failures.map((item) => [item.code, item])).values()];
}
