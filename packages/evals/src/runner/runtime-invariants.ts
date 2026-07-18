// @summary Deterministic protocol, lifecycle, session, workspace, and budget invariants for runtime evals

import { DiligentServerNotificationSchema } from "@diligent/protocol";
import type { RuntimeEvalExecution, RuntimeEvalLimits } from "../runtime-task";
import type { EvalFailure } from "../task";
import { checkStructuralInvariants } from "./invariants";
import { workspaceDiff } from "./runtime-workspace";

export function checkRuntimeInvariants(
  execution: RuntimeEvalExecution<unknown>,
  limits: RuntimeEvalLimits,
): EvalFailure[] {
  const failures: EvalFailure[] = [];
  for (const turn of execution.turns) {
    const parentCoreEvents = turn.coreEvents.filter(
      (item) => !(item.event as { childThreadId?: string }).childThreadId,
    );
    failures.push(
      ...checkStructuralInvariants({
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
      }),
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
  const projectOnly = (snapshot: typeof execution.workspace.initial) => ({
    entries: snapshot.entries.filter((entry) => !entry.path.startsWith(".diligent/")),
  });
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

function failure(code: string, message: string): EvalFailure {
  return { category: "runtime_contract", code: `runtime_contract.${code}`, message };
}
function budget(code: string, message: string): EvalFailure {
  return { category: "budget_exceeded", code: `budget_exceeded.${code}`, message };
}
function dedupe(failures: EvalFailure[]): EvalFailure[] {
  return [...new Map(failures.map((item) => [item.code, item])).values()];
}
