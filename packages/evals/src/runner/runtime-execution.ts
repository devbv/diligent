// @summary Executes one isolated runtime eval through DiligentAppServer and in-process RPC

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Usage } from "@diligent/core/message-contract";
import type { StreamFunction } from "@diligent/core/provider-contract";
import { type LogRecord, resetDefaultLogSinkForTests, setDefaultLogSink } from "@diligent/logging";
import type { DiligentServerNotification, DiligentServerRequest } from "@diligent/protocol";
import { createAppServerConfig, DiligentAppServer, ensureDiligentDir } from "@diligent/runtime";
import type {
  AnyRuntimeEvalTask,
  RuntimeEvalExecution,
  RuntimeEvalExecutionResult,
  RuntimeEvalTurnRecord,
  RuntimeSessionSnapshot,
  RuntimeVerifierResult,
  RuntimeWorldSnapshot,
} from "../runtime-task";
import type { EvalFailure, EvalProfile } from "../task";
import { ZERO_USAGE } from "../task";
import { checkRuntimeInvariants } from "./runtime-invariants";
import { createRuntimeProtocolClient, type RuntimeProtocolClient } from "./runtime-protocol-client";
import { transformRuntimeTools } from "./runtime-tool-policy";
import { captureWorkspace, normalizePlatformAlias, removeTemporaryRoot, workspaceDiff } from "./runtime-workspace";

export async function runRuntimeEvalExecution(input: {
  task: AnyRuntimeEvalTask;
  profile: EvalProfile;
  seed: string;
  streamFunction: StreamFunction;
}): Promise<RuntimeEvalExecutionResult> {
  const { task, profile, seed } = input;
  const root = await mkdtemp(join(tmpdir(), `diligent-runtime-eval-${task.id}-`));
  const startedAt = new Date();
  const started = performance.now();
  const traces: RuntimeEvalExecution<unknown>["toolCalls"] = [];
  const turns: RuntimeEvalTurnRecord[] = [];
  const compactions: RuntimeEvalExecution<unknown>["compactions"] = [];
  const serverRequests: DiligentServerRequest[] = [];
  const logs: LogRecord[] = [];
  const failures: EvalFailure[] = [];
  let world: unknown;
  let initial: RuntimeWorldSnapshot = { entries: [] };
  let final: RuntimeWorldSnapshot = initial;
  let verifier: RuntimeVerifierResult | undefined;
  let threadId = "";
  let client: RuntimeProtocolClient | undefined;
  let termination: RuntimeEvalExecution<unknown>["termination"] = "runner_error";
  let budgetTerminated = false;
  let budgetReason: "turn_limit" | "tool_call_limit" | "changed_files" | "changed_bytes" | undefined;
  let providerTurns = 0;
  let logSinkInstalled = false;
  let resultForCleanup: RuntimeEvalExecutionResult | undefined;
  try {
    world = await task.setup(seed, root);
    initial = await captureWorkspace(root);
    if (initial.entries.some((entry) => entry.kind === "symlink"))
      throw new Error("configuration.invalid_fixture: symlinks are forbidden.");
    setDefaultLogSink((record) => {
      logs.push(structuredClone(record));
    });
    logSinkInstalled = true;
    let config = await task.createRuntimeConfig(world, profile);
    const makeServer = () => {
      config.streamFunction = clampOutputTokens(input.streamFunction, task.limits.maxOutputTokens, () => {
        providerTurns += 1;
        if (providerTurns <= task.limits.maxTurns) return;
        budgetTerminated = true;
        budgetReason = "turn_limit";
        throw new Error(`Provider-turn budget exceeded (${task.limits.maxTurns}).`);
      });
      return new DiligentAppServer(
        createAppServerConfig({
          cwd: root,
          runtimeConfig: config,
          transformTools: (tools) =>
            transformRuntimeTools({
              tools,
              root,
              policy: task.toolPolicy,
              traces,
              maxToolCalls: task.limits.maxToolCalls,
              isTerminated: () => budgetTerminated,
              onBudgetExceeded: () => {
                budgetTerminated = true;
                budgetReason = "tool_call_limit";
              },
              afterMutation: async () => {
                const current = await captureWorkspace(root);
                if (current.entries.some((entry) => entry.kind === "symlink")) {
                  budgetTerminated = true;
                  return;
                }
                const project = (snapshot: RuntimeWorldSnapshot) => ({
                  entries: snapshot.entries.filter((entry) => !entry.path.startsWith(".diligent/")),
                });
                const diff = workspaceDiff(project(initial), project(current));
                if (diff.changedFiles.length > task.limits.maxChangedFiles) {
                  budgetTerminated = true;
                  budgetReason = "changed_files";
                } else if (diff.changedBytes > task.limits.maxChangedBytes) {
                  budgetTerminated = true;
                  budgetReason = "changed_bytes";
                }
              },
            }),
        }),
      );
    };
    const makeClient = (server: DiligentAppServer) =>
      createRuntimeProtocolClient(server, {
        respondToServerRequest: task.respondToServerRequest
          ? (request) => task.respondToServerRequest!(world, request)
          : undefined,
      });
    let server = makeServer();
    client = makeClient(server);
    await client.initialize();
    for (const step of task.createSteps(world)) {
      if (step.kind === "restart_and_resume") {
        serverRequests.push(...client.serverRequests);
        client.close();
        config = await task.createRuntimeConfig(world, profile);
        server = makeServer();
        client = makeClient(server);
        await client.initialize();
        const resumed = (await client.request("thread/resume", { threadId })) as { found?: boolean };
        if (!resumed.found) throw new Error(`runtime_contract.resume_failed: ${threadId}`);
        await client.request("thread/subscribe", { threadId });
        continue;
      }
      if (step.kind === "compact") {
        if (!threadId) throw new Error("runtime_contract.compact_without_thread: compact requires an active thread.");
        const notificationIndex = client.notifications.length;
        const response = (await client.request("thread/compact/start", { threadId })) as {
          compacted: boolean;
          entryCount: number;
          tokensBefore: number;
          tokensAfter: number;
          summary: string;
        };
        compactions.push({
          threadId,
          response,
          notifications: client.notifications.slice(notificationIndex),
        });
        continue;
      }
      if (!threadId) {
        const startedThread = (await client.request("thread/start", {
          cwd: root,
          mode: step.mode ?? "default",
          model: { provider: profile.provider, modelId: profile.model },
          effort: profile.effort,
        })) as { threadId: string };
        threadId = startedThread.threadId;
        await client.request("thread/subscribe", { threadId });
      } else if (step.mode) await client.request("mode/set", { threadId, mode: step.mode });
      const notificationIndex = client.notifications.length;
      const turnStarted = performance.now();
      await client.request("turn/start", { threadId, message: step.message });
      const remainingMs = Math.max(1, task.limits.timeoutMs - Math.round(performance.now() - started));
      let notifications: DiligentServerNotification[];
      try {
        notifications = await client.waitForTerminal(notificationIndex, remainingMs);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Runtime turn exceeded")) throw error;
        termination = "timeout";
        budgetTerminated = true;
        failures.push({
          category: "budget_exceeded",
          code: "budget_exceeded.timeout",
          message: `Runtime task exceeded ${task.limits.timeoutMs}ms.`,
        });
        await client.request("turn/interrupt", { threadId }).catch(() => undefined);
        notifications = await client
          .waitForTerminal(notificationIndex, 5_000)
          .catch(() => client?.notifications.slice(notificationIndex) ?? []);
      }
      const coreEvents = notifications
        .filter((item) => item.method === "agent/event")
        .map((item, index) => ({
          sequence: index + 1,
          relativeMs: Math.round(performance.now() - turnStarted),
          event: (item.params as unknown as { event: RuntimeEvalTurnRecord["coreEvents"][number]["event"] }).event,
        }));
      const end = coreEvents.findLast((item) => (item.event as { type?: string }).type === "agent_end");
      const messages = ((end?.event as { messages?: Message[] } | undefined)?.messages ?? []) as Message[];
      turns.push({
        index: turns.length,
        threadId,
        startedAt: new Date(Date.now() - (performance.now() - turnStarted)).toISOString(),
        elapsedMs: Math.round(performance.now() - turnStarted),
        termination: notifications.some((item) => item.method === "turn/interrupted") ? "interrupted" : "completed",
        coreEvents,
        runtimeEvents: notifications
          .filter((item) => item.method === "agent/event")
          .map((item) => structuredClone((item.params as { event: unknown }).event)),
        notifications,
        messages,
        usage: aggregateUsage(coreEvents.map((item) => item.event as { type?: string; usage?: Usage })),
      });
      if (budgetTerminated) {
        if (termination !== "timeout") {
          termination =
            budgetReason === "turn_limit" || budgetReason === "tool_call_limit"
              ? budgetReason
              : budgetReason
                ? "workspace_limit"
                : "runtime_error";
        }
        break;
      }
    }
    if (termination === "runner_error") termination = "completed";
    final = await captureWorkspace(root);
    if (task.verify) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), task.limits.verifierTimeoutMs);
      try {
        verifier = await task.verify(world, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }
    const sessionPath = join((await ensureDiligentDir(root)).sessions, `${threadId}.jsonl`);
    const sessionLines = await readSessionLines(sessionPath);
    const childSessions = await captureChildSessions(root, threadId);
    const normalizedTurns = normalizeWorkspaceEvidence(turns, root);
    annotateToolTraceActors(traces, normalizedTurns, threadId);
    const execution: RuntimeEvalExecution<unknown> = {
      taskId: task.id,
      profile,
      seed,
      startedAt: startedAt.toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      termination,
      turns: normalizedTurns,
      compactions: normalizeWorkspaceEvidence(compactions, root),
      toolCalls: traces,
      approvals: [...serverRequests, ...client.serverRequests].filter(
        (request) => request.method === "approval/request",
      ),
      userInputRequests: [...serverRequests, ...client.serverRequests].filter(
        (request) => request.method === "userInput/request",
      ),
      logs: normalizeWorkspaceEvidence(logs, root),
      session: {
        threadId,
        path: "$WORKSPACE/.diligent/sessions/$SESSION.jsonl",
        lines: normalizeWorkspaceEvidence(sessionLines, root),
      },
      childSessions: normalizeWorkspaceEvidence(childSessions, root),
      workspace: { initial, final },
      verifier: verifier ? normalizeWorkspaceEvidence(verifier, root) : undefined,
      world,
    };
    if (budgetReason) {
      failures.push({
        category: "budget_exceeded",
        code: `budget_exceeded.${budgetReason}`,
        message:
          budgetReason === "turn_limit"
            ? `Provider-turn count exceeded ${task.limits.maxTurns}.`
            : budgetReason === "tool_call_limit"
              ? `Tool-call count exceeded ${task.limits.maxToolCalls}.`
              : budgetReason === "changed_files"
                ? `Changed-file count exceeded ${task.limits.maxChangedFiles}.`
                : `Changed-byte count exceeded ${task.limits.maxChangedBytes}.`,
      });
    }
    failures.push(...checkRuntimeInvariants(execution, task.limits));
    if (failures.length === 0 && termination === "completed") {
      const semantic = task.evaluate(execution);
      if (!semantic.passed)
        failures.push({
          category: "task_semantic",
          code: semantic.code.startsWith("task_semantic.") ? semantic.code : `task_semantic.${semantic.code}`,
          message: semantic.message,
        });
    }
    const worldSnapshot = await task.snapshotWorld(world);
    resultForCleanup = { passed: failures.length === 0, failure: failures[0], failures, execution, worldSnapshot };
    return resultForCleanup;
  } catch (error) {
    final = await captureWorkspace(root).catch(() => initial);
    const message = normalizeWorkspaceEvidence(error instanceof Error ? error.message : String(error), root);
    const failure: EvalFailure = {
      category: message.includes("configuration.") ? "configuration" : "runner_error",
      code: message.split(":")[0] || "runner_error.exception",
      message,
    };
    const execution: RuntimeEvalExecution<unknown> = {
      taskId: task.id,
      profile,
      seed,
      startedAt: startedAt.toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      termination: "runner_error",
      turns: normalizeWorkspaceEvidence(turns, root),
      compactions: normalizeWorkspaceEvidence(compactions, root),
      toolCalls: traces,
      approvals: [],
      userInputRequests: [],
      logs: normalizeWorkspaceEvidence(logs, root),
      session: { threadId, lines: [] },
      childSessions: [],
      workspace: { initial, final },
      world,
    };
    resultForCleanup = { passed: false, failure, failures: [failure], execution, worldSnapshot: null };
    return resultForCleanup;
  } finally {
    try {
      client?.close();
      if (world !== undefined) {
        try {
          await task.cleanup?.(world);
        } catch (error) {
          recordCleanupFailure(resultForCleanup, error, root);
        }
      }
      try {
        await removeTemporaryRoot(root);
      } catch (error) {
        recordCleanupFailure(resultForCleanup, error, root);
      }
    } finally {
      if (logSinkInstalled) resetDefaultLogSinkForTests();
    }
  }
}

async function readSessionLines(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function captureChildSessions(root: string, parentThreadId: string): Promise<RuntimeSessionSnapshot[]> {
  const sessionsDir = (await ensureDiligentDir(root)).sessions;
  const snapshots: RuntimeSessionSnapshot[] = [];
  for (const file of await readdir(sessionsDir)) {
    if (!file.endsWith(".jsonl") || file === `${parentThreadId}.jsonl`) continue;
    const lines = await readSessionLines(join(sessionsDir, file));
    const header = lines[0] as { id?: string; parentSession?: string } | undefined;
    if (!header?.id || header.parentSession !== parentThreadId) continue;
    snapshots.push({
      threadId: header.id,
      path: "$WORKSPACE/.diligent/sessions/$CHILD_SESSION.jsonl",
      lines,
    });
  }
  return snapshots.sort((left, right) => left.threadId.localeCompare(right.threadId));
}

function annotateToolTraceActors(
  traces: RuntimeEvalExecution<unknown>["toolCalls"],
  turns: RuntimeEvalTurnRecord[],
  parentThreadId: string,
): void {
  const actors = new Map<string, { threadId: string; childThreadId?: string }>();
  for (const turn of turns) {
    for (const rawEvent of turn.runtimeEvents) {
      const event = rawEvent as { type?: string; toolCallId?: string; childThreadId?: string };
      if (event.type !== "tool_start" || !event.toolCallId) continue;
      actors.set(event.toolCallId, {
        threadId: event.childThreadId ?? parentThreadId,
        ...(event.childThreadId && { childThreadId: event.childThreadId }),
      });
    }
  }
  for (const trace of traces) Object.assign(trace, actors.get(trace.toolCallId) ?? { threadId: parentThreadId });
}

function recordCleanupFailure(result: RuntimeEvalExecutionResult | undefined, error: unknown, root: string): void {
  if (!result) return;
  const failure: EvalFailure = {
    category: "runner_error",
    code: "runner_error.cleanup_failed",
    message: normalizeWorkspaceEvidence(error instanceof Error ? error.message : String(error), root),
  };
  result.failures.push(failure);
  result.failure ??= failure;
  result.passed = false;
}

function normalizeWorkspaceEvidence<T>(value: T, root: string): T {
  if (typeof value === "string") {
    const aliasedRoot = process.platform === "darwin" ? `/private${normalizePlatformAlias(root)}` : root;
    return value.split(aliasedRoot).join("$WORKSPACE").split(root).join("$WORKSPACE") as T;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeWorkspaceEvidence(item, root)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "data" && isRecord(value) && value.type === "base64"
        ? "[base64 omitted]"
        : normalizeWorkspaceEvidence(item, root),
    ]),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function clampOutputTokens(stream: StreamFunction, maximum: number, beforeTurn: () => void): StreamFunction {
  return (model, context, options) => {
    beforeTurn();
    return stream(model, context, { ...options, maxTokens: Math.min(options.maxTokens ?? maximum, maximum) });
  };
}
function aggregateUsage(events: Array<{ type?: string; usage?: Usage }>): Usage {
  return events.reduce(
    (total, event) =>
      event.type === "usage" && event.usage
        ? {
            inputTokens: total.inputTokens + event.usage.inputTokens,
            outputTokens: total.outputTokens + event.usage.outputTokens,
            cacheReadTokens: total.cacheReadTokens + event.usage.cacheReadTokens,
            cacheWriteTokens: total.cacheWriteTokens + event.usage.cacheWriteTokens,
          }
        : total,
    { ...ZERO_USAGE },
  );
}
