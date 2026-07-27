// @summary Executes one isolated runtime eval through DiligentAppServer and in-process RPC

import { lstat, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Message, Usage } from "@diligent/core/message-contract";
import type { ProviderManager, StreamFunction } from "@diligent/core/provider-contract";
import { type LogRecord, resetDefaultLogSinkForTests, setDefaultLogSink } from "@diligent/logging";
import type { DiligentServerNotification, DiligentServerRequest, ThreadReadResponse } from "@diligent/protocol";
import { createAppServerConfig, DiligentAppServer, ensureDiligentDir } from "@diligent/runtime";
import type {
  AnyRuntimeEvalTask,
  RuntimeEvalExecution,
  RuntimeEvalExecutionResult,
  RuntimeEvalTurnRecord,
  RuntimeProtocolActionTrace,
  RuntimeSessionSnapshot,
  RuntimeThreadReadSnapshot,
  RuntimeTurnProtocolAction,
  RuntimeVerifierResult,
  RuntimeWorldSnapshot,
} from "../runtime-task";
import { deriveEvalStatus, type EvalDiagnostic, type EvalFailure, type EvalProfile, ZERO_USAGE } from "../task";
import { createBudgetGraceDiagnostics, EVAL_BUDGET_GRACE, resolveEvalHardLimits } from "./budget-policy";
import { RuntimeDeadline, RuntimeDeadlineError, raceBounded } from "./runtime-deadline";
import { checkRuntimeInvariants } from "./runtime-invariants";
import { createRuntimeEvalOutputStore, type RuntimeEvalOutputStore } from "./runtime-output-store";
import { createRuntimeProtocolClient, type RuntimeProtocolClient } from "./runtime-protocol-client";
import { captureRuntimeProviderCall } from "./runtime-provider-evidence";
import { captureRuntimeState, checkRuntimeStatePolicy, projectSnapshotWithoutRuntimeState } from "./runtime-state";
import { normalizeEvidencePath, transformRuntimeTools } from "./runtime-tool-policy";
import {
  canonicalizeTemporaryRoot,
  captureWorkspace,
  normalizePlatformAlias,
  removeTemporaryRoot,
  resolveWorkspacePath,
  workspaceDiff,
} from "./runtime-workspace";

const SAFE_IMAGE_SIDECAR_BLOB_REF = /^blob:[0-9a-f]{64}$/;
const OMITTED_REGISTERED_OUTPUT_CONTENT = "[registered tool output content omitted]";

export async function runRuntimeEvalExecution(input: {
  task: AnyRuntimeEvalTask;
  profile: EvalProfile;
  seed: string;
  streamFunction: StreamFunction;
  configureProviderManager?: (profile: EvalProfile, manager: ProviderManager) => void;
}): Promise<RuntimeEvalExecutionResult> {
  const { task, profile, seed } = input;
  const hardLimits = resolveEvalHardLimits(task.limits);
  const deadline = new RuntimeDeadline(task.limits.timeoutMs);
  const started = deadline.started;
  let root = "";
  let outputRoot: string | undefined;
  let outputStore: RuntimeEvalOutputStore | undefined;
  const startedAt = new Date();
  const traces: RuntimeEvalExecution<unknown>["toolCalls"] = [];
  const turns: RuntimeEvalTurnRecord[] = [];
  const compactions: RuntimeEvalExecution<unknown>["compactions"] = [];
  const advertisedTools: RuntimeEvalExecution<unknown>["advertisedTools"] = [];
  const threadReads: RuntimeThreadReadSnapshot[] = [];
  const protocolActions: RuntimeProtocolActionTrace[] = [];
  const providerCalls: RuntimeEvalExecution<unknown>["providerCalls"] = [];
  const serverRequests: DiligentServerRequest[] = [];
  const logs: LogRecord[] = [];
  const failures: EvalFailure[] = [];
  const diagnostics: EvalDiagnostic[] = [];
  let world: unknown;
  let initial: RuntimeWorldSnapshot = { entries: [] };
  let final: RuntimeWorldSnapshot = initial;
  let verifier: RuntimeVerifierResult | undefined;
  let threadId = "";
  let threadCwd = root;
  let client: RuntimeProtocolClient | undefined;
  let activeActions: ActiveProtocolAction[] = [];
  let activeTurnIndex = 0;
  let termination: RuntimeEvalExecution<unknown>["termination"] = "runner_error";
  let budgetTerminated = false;
  let budgetReason:
    | "turn_limit"
    | "tool_call_limit"
    | "user_input_limit"
    | "child_agent_limit"
    | "changed_files"
    | "changed_bytes"
    | undefined;
  let providerTurns = 0;
  let logSinkInstalled = false;
  let resultForCleanup: RuntimeEvalExecutionResult | undefined;
  let currentTurnNotificationIndex: number | undefined;
  let currentTurnStarted = 0;
  let currentClientPrompt = "";
  let stateRoots = [".diligent"];
  try {
    root = await deadline.run("fixture root creation", mkdtemp(join(tmpdir(), `diligent-runtime-eval-${task.id}-`)));
    if (process.platform === "win32")
      root = await deadline.run("fixture root canonicalization", canonicalizeTemporaryRoot(root));
    outputRoot = await deadline.run(
      "output root creation",
      mkdtemp(join(tmpdir(), `diligent-runtime-eval-output-${task.id}-`)),
    );
    const evalOutputStore = createRuntimeEvalOutputStore(outputRoot);
    outputStore = evalOutputStore;
    world = await deadline.run("setup", task.setup(seed, root, deadline.signal));
    initial = await deadline.run("initial fixture capture", captureWorkspace(root));
    if (initial.entries.some((entry) => entry.kind === "symlink"))
      throw new Error("configuration.invalid_fixture: symlinks are forbidden.");
    try {
      threadCwd = task.resolveThreadCwd
        ? resolveWorkspacePath(
            root,
            await deadline.run("thread cwd resolution", Promise.resolve(task.resolveThreadCwd(world, root))),
          )
        : root;
    } catch (error) {
      throw new Error(`configuration.invalid_thread_cwd: ${error instanceof Error ? error.message : String(error)}`);
    }
    const threadCwdStat = await deadline.run(
      "thread cwd validation",
      lstat(threadCwd).catch(() => undefined),
    );
    if (!threadCwdStat?.isDirectory())
      throw new Error("configuration.invalid_thread_cwd: thread cwd must be an existing fixture directory.");
    const threadRelativePath = relative(root, threadCwd).split(sep).filter(Boolean).join("/");
    stateRoots = [".diligent", ...(threadRelativePath ? [`${threadRelativePath}/.diligent`] : [])];
    const bundledToolProviders = [
      ...(await deadline.run(
        "bundled provider setup",
        Promise.resolve(task.createBundledToolProviders?.(world) ?? []),
      )),
    ];
    setDefaultLogSink((record) => {
      logs.push(structuredClone(record));
    });
    logSinkInstalled = true;
    let config = await deadline.run("runtime config setup", task.createRuntimeConfig(world, profile));
    input.configureProviderManager?.(profile, config.providerManager);
    const makeServer = () => {
      config.streamFunction = clampOutputTokens(
        input.streamFunction,
        task.limits.maxOutputTokens,
        () => {
          providerTurns += 1;
          if (providerTurns <= hardLimits.maxTurns) return;
          budgetTerminated = true;
          budgetReason = "turn_limit";
          throw new Error(
            `Provider-turn hard limit exceeded (${hardLimits.maxTurns}; target ${task.limits.maxTurns} + ${EVAL_BUDGET_GRACE.turns} grace).`,
          );
        },
        (model, context, options) => {
          providerCalls.push(
            captureRuntimeProviderCall({
              sequence: providerCalls.length + 1,
              model,
              context,
              options,
              normalize: (value) => normalizeWorkspaceEvidence(value, root, outputRoot),
            }),
          );
        },
      );
      return new DiligentAppServer(
        createAppServerConfig({
          cwd: root,
          runtimeConfig: config,
          pluginDiscovery: task.pluginDiscovery ?? "explicit",
          bundledToolProviders,
          toolOutputStore: evalOutputStore.store,
          transformTools: (tools, context) => {
            advertisedTools.push({
              sequence: advertisedTools.length + 1,
              turnIndex: activeTurnIndex,
              cwd: context.cwd,
              mode: context.mode,
              provider: context.provider,
              tools: tools.map((tool) => tool.name),
            });
            return transformRuntimeTools({
              tools,
              root,
              outputRoot,
              registeredReadPaths: evalOutputStore.registeredPaths,
              policy: task.toolPolicy,
              traces,
              maxToolCalls: hardLimits.maxToolCalls,
              maxUserInputRequests: task.limits.maxUserInputRequests,
              maxChildAgents: task.limits.maxChildAgents,
              isTerminated: () => budgetTerminated,
              onBudgetExceeded: (reason) => {
                budgetTerminated = true;
                budgetReason = reason;
              },
              afterMutation: async () => {
                const current = await captureWorkspace(root);
                if (current.entries.some((entry) => entry.kind === "symlink")) {
                  budgetTerminated = true;
                  return;
                }
                const project = (snapshot: RuntimeWorldSnapshot) =>
                  projectSnapshotWithoutRuntimeState(snapshot, stateRoots);
                const diff = workspaceDiff(project(initial), project(current));
                if (diff.changedFiles.length > task.limits.maxChangedFiles) {
                  budgetTerminated = true;
                  budgetReason = "changed_files";
                } else if (diff.changedBytes > task.limits.maxChangedBytes) {
                  budgetTerminated = true;
                  budgetReason = "changed_bytes";
                }
              },
            });
          },
        }),
      );
    };
    const makeClient = (server: DiligentAppServer) =>
      createRuntimeProtocolClient(server, {
        respondToServerRequest: task.respondToServerRequest
          ? (request) => task.respondToServerRequest!(world, request)
          : undefined,
        onNotification: (notification) => {
          for (const action of activeActions) handleProtocolActionNotification(action, notification);
        },
      });
    let server = makeServer();
    client = makeClient(server);
    await deadline.run("client initialization", client.initialize());
    for (const [stepIndex, step] of task.createSteps(world).entries()) {
      if (task.prepareStep)
        await deadline.run(`task step ${stepIndex} preparation`, () =>
          Promise.resolve(task.prepareStep!(world, step, stepIndex)),
        );
      if (step.kind === "restart_and_resume") {
        serverRequests.push(...client.serverRequests);
        client.close();
        config = await deadline.run("restart runtime config setup", task.createRuntimeConfig(world, profile));
        input.configureProviderManager?.(profile, config.providerManager);
        server = makeServer();
        client = makeClient(server);
        await deadline.run("restart client initialization", client.initialize());
        const resumed = (await deadline.run("thread resume", client.request("thread/resume", { threadId }))) as {
          found?: boolean;
        };
        if (!resumed.found) throw new Error(`runtime_contract.resume_failed: ${threadId}`);
        await deadline.run("thread subscribe", client.request("thread/subscribe", { threadId }));
        threadReads.push({
          phase: "after_resume",
          response: (await deadline.run(
            "resumed thread evidence",
            client.request("thread/read", { threadId }),
          )) as ThreadReadResponse,
        });
        continue;
      }
      if (step.kind === "compact") {
        if (!threadId) throw new Error("runtime_contract.compact_without_thread: compact requires an active thread.");
        const notificationIndex = client.notifications.length;
        const response = (await deadline.run(
          "thread compaction",
          client.request("thread/compact/start", { threadId }),
        )) as {
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
        const startedThread = (await deadline.run(
          "thread start",
          client.request("thread/start", {
            cwd: threadCwd,
            mode: step.mode ?? "default",
            model: { provider: profile.provider, modelId: profile.model },
            effort: profile.effort,
          }),
        )) as { threadId: string };
        threadId = startedThread.threadId;
        await deadline.run("thread subscribe", client.request("thread/subscribe", { threadId }));
      } else if (step.mode)
        await deadline.run("mode update", client.request("mode/set", { threadId, mode: step.mode }));
      const notificationIndex = client.notifications.length;
      const turnStarted = performance.now();
      currentTurnNotificationIndex = notificationIndex;
      currentTurnStarted = turnStarted;
      currentClientPrompt = step.message;
      activeTurnIndex = turns.length;
      activeActions = activateProtocolActions(
        step.actions ?? [],
        activeTurnIndex,
        task.limits.timeoutMs,
        protocolActions,
        {
          getClient: () => client,
          getThreadId: () => threadId,
          executionStarted: started,
        },
      );
      await deadline.run("turn start", client.request("turn/start", { threadId, message: step.message }));
      const notifications = await deadline.run(
        "turn completion",
        client.waitForTerminal(notificationIndex, Math.max(1, Math.ceil(deadline.remainingMs()))),
      );
      await deadline.run(
        "protocol actions",
        Promise.all(activeActions.flatMap((action) => (action.pending ? [action.pending] : []))),
      );
      for (const action of activeActions) {
        clearTimeout(action.timer);
        finalizeProtocolAction(action, failures);
      }
      activeActions = [];
      currentTurnNotificationIndex = undefined;
      const coreEvents = notifications
        .filter((item) => item.method === "agent/event")
        .map((item, index) => ({
          sequence: index + 1,
          relativeMs: Math.round(performance.now() - turnStarted),
          event: (item.params as unknown as { event: RuntimeEvalTurnRecord["coreEvents"][number]["event"] }).event,
        }));
      const end = coreEvents.findLast((item) => (item.event as { type?: string }).type === "agent_end");
      const messages = ((end?.event as { messages?: Message[] } | undefined)?.messages ?? []) as Message[];
      const fatalProviderFailure = coreEvents.some(
        (item) =>
          (item.event as { type?: string; fatal?: boolean }).type === "error" &&
          (item.event as { fatal?: boolean }).fatal,
      );
      turns.push({
        index: turns.length,
        threadId,
        clientPrompt: step.message,
        startedAt: new Date(Date.now() - (performance.now() - turnStarted)).toISOString(),
        elapsedMs: Math.round(performance.now() - turnStarted),
        termination: notifications.some((item) => item.method === "turn/interrupted")
          ? "interrupted"
          : fatalProviderFailure
            ? "failed"
            : "completed",
        coreEvents,
        runtimeEvents: notifications
          .filter((item) => item.method === "agent/event")
          .map((item) => structuredClone((item.params as { event: unknown }).event)),
        notifications,
        messages,
        usage: aggregateUsage(coreEvents.map((item) => item.event as { type?: string; usage?: Usage })),
      });
      if (turns.at(-1)?.termination === "completed" && notifications.some((item) => item.method === "turn/completed")) {
        threadReads.push({
          phase: "after_turn",
          turnIndex: turns.length - 1,
          response: (await deadline.run(
            "post-turn evidence",
            client.request("thread/read", { threadId }),
          )) as ThreadReadResponse,
        });
      }
      if (fatalProviderFailure) {
        termination = "provider_error";
        break;
      }
      if (budgetTerminated) {
        termination =
          budgetReason === "turn_limit" ||
          budgetReason === "tool_call_limit" ||
          budgetReason === "user_input_limit" ||
          budgetReason === "child_agent_limit"
            ? budgetReason
            : budgetReason
              ? "workspace_limit"
              : "runtime_error";
        break;
      }
    }
    if (termination === "runner_error") termination = "completed";
    if (task.verify && termination === "completed") {
      verifier = await deadline.run(
        "verifier",
        () => task.verify!(world, deadline.signal),
        task.limits.verifierTimeoutMs,
      );
    }
    const sessionPath = join(
      (await deadline.run("session path capture", ensureDiligentDir(threadCwd))).sessions,
      `${threadId}.jsonl`,
    );
    const sessionLines = await deadline.run("session evidence", readSessionLines(sessionPath));
    const childSessions = await deadline.run("child session evidence", captureChildSessions(threadCwd, threadId));
    final = await deadline.run("final workspace capture", captureWorkspace(root));
    const normalizedTurns = normalizeWorkspaceEvidence(turns, root, outputRoot);
    annotateToolTraceActors(traces, normalizedTurns, threadId);
    const execution = normalizeWorkspaceEvidence<RuntimeEvalExecution<unknown>>(
      {
        taskId: task.id,
        profile,
        seed,
        startedAt: startedAt.toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        termination,
        turns: normalizedTurns,
        compactions: normalizeWorkspaceEvidence(compactions, root, outputRoot),
        threadCwd: normalizeWorkspaceEvidence(threadCwd, root, outputRoot),
        advertisedTools: normalizeWorkspaceEvidence(advertisedTools, root, outputRoot),
        threadReads: normalizeWorkspaceEvidence(threadReads, root, outputRoot),
        protocolActions: normalizeWorkspaceEvidence(protocolActions, root, outputRoot),
        providerCalls,
        toolCalls: traces,
        toolOutputFiles: normalizeWorkspaceEvidence(evalOutputStore.files, root, outputRoot),
        approvals: normalizeWorkspaceEvidence(
          [...serverRequests, ...client.serverRequests].filter((request) => request.method === "approval/request"),
          root,
          outputRoot,
        ),
        userInputRequests: normalizeWorkspaceEvidence(
          [...serverRequests, ...client.serverRequests].filter((request) => request.method === "userInput/request"),
          root,
          outputRoot,
        ),
        logs: normalizeWorkspaceEvidence(logs, root, outputRoot),
        session: {
          threadId,
          path: "$WORKSPACE/.diligent/sessions/$SESSION.jsonl",
          lines: normalizeWorkspaceEvidence(sessionLines, root, outputRoot),
        },
        childSessions: normalizeWorkspaceEvidence(childSessions, root, outputRoot),
        workspace: { initial, final },
        runtimeState: captureRuntimeState(initial, final, stateRoots),
        verifier: verifier ? normalizeWorkspaceEvidence(verifier, root, outputRoot) : undefined,
        world: normalizeWorkspaceEvidence(world, root, outputRoot),
      },
      root,
      outputRoot,
    );
    if (termination === "provider_error") failures.push(classifyRuntimeTerminalFailure(execution));
    if (budgetReason) {
      failures.push({
        dimension: "harness_terminal",
        category: "budget_exceeded",
        code: `budget_exceeded.${budgetReason}`,
        message:
          budgetReason === "turn_limit"
            ? `Provider-turn count exceeded hard limit ${hardLimits.maxTurns} (target ${task.limits.maxTurns} + ${EVAL_BUDGET_GRACE.turns} grace).`
            : budgetReason === "tool_call_limit"
              ? `Tool-call count exceeded hard limit ${hardLimits.maxToolCalls} (target ${task.limits.maxToolCalls} + ${EVAL_BUDGET_GRACE.toolCalls} grace).`
              : budgetReason === "user_input_limit"
                ? `User-input request count exceeded ${task.limits.maxUserInputRequests}.`
                : budgetReason === "child_agent_limit"
                  ? `Child-agent count exceeded ${task.limits.maxChildAgents}.`
                  : budgetReason === "changed_files"
                    ? `Changed-file count exceeded ${task.limits.maxChangedFiles}.`
                    : `Changed-byte count exceeded ${task.limits.maxChangedBytes}.`,
      });
    }
    failures.push(
      ...checkRuntimeInvariants(
        execution,
        task.limits,
        task.statePolicy ?? { allowedMutations: ["infrastructure", "sessions"] },
      ),
    );
    if (termination === "completed") {
      diagnostics.push(
        ...createBudgetGraceDiagnostics(task.limits, {
          turns: providerCalls.length,
          toolCalls: traces.length,
        }),
      );
      try {
        const semantic = task.evaluate(execution);
        diagnostics.push(...(semantic.diagnostics ?? []));
        if (!semantic.passed) {
          const dimension = (semantic as { dimension?: unknown }).dimension;
          failures.push(
            typeof dimension === "string"
              ? {
                  dimension: semantic.dimension,
                  category: "task_semantic",
                  code: semantic.code.startsWith("task_semantic.") ? semantic.code : `task_semantic.${semantic.code}`,
                  message: semantic.message,
                }
              : {
                  dimension: "harness_terminal",
                  category: "evaluator_error",
                  code: "evaluator_error.missing_dimension",
                  message: normalizeWorkspaceEvidence(
                    `Evaluator failure ${semantic.code} omitted its required dimension.`,
                    root,
                    outputRoot,
                  ),
                },
          );
        }
      } catch (error) {
        failures.push({
          dimension: "harness_terminal",
          category: "evaluator_error",
          code: "evaluator_error.exception",
          message: normalizeWorkspaceEvidence(error instanceof Error ? error.message : String(error), root, outputRoot),
        });
      }
    }
    const worldSnapshot = await deadline.run("world snapshot", () => task.snapshotWorld(world));
    const status = deriveEvalStatus(failures, diagnostics);
    resultForCleanup = {
      passed: status === "pass" || status === "degraded",
      status,
      failure: failures[0],
      failures,
      ...(diagnostics.length > 0 && { diagnostics }),
      execution,
      worldSnapshot,
    };
    return resultForCleanup;
  } catch (error) {
    const collectionErrors: unknown[] = [];
    if (currentTurnNotificationIndex !== undefined && client) {
      const notifications = client.notifications.slice(currentTurnNotificationIndex);
      if (notifications.length > 0) {
        const coreEvents = notifications
          .filter((item) => item.method === "agent/event")
          .map((item, index) => ({
            sequence: index + 1,
            relativeMs: Math.round(performance.now() - currentTurnStarted),
            event: (item.params as unknown as { event: RuntimeEvalTurnRecord["coreEvents"][number]["event"] }).event,
          }));
        const end = coreEvents.findLast((item) => (item.event as { type?: string }).type === "agent_end");
        turns.push({
          index: turns.length,
          threadId,
          clientPrompt: currentClientPrompt,
          startedAt: new Date(Date.now() - (performance.now() - currentTurnStarted)).toISOString(),
          elapsedMs: Math.round(performance.now() - currentTurnStarted),
          termination: notifications.some((item) => item.method === "turn/interrupted") ? "interrupted" : "failed",
          coreEvents,
          runtimeEvents: notifications
            .filter((item) => item.method === "agent/event")
            .map((item) => structuredClone((item.params as { event: unknown }).event)),
          notifications,
          messages: ((end?.event as { messages?: Message[] } | undefined)?.messages ?? []) as Message[],
          usage: aggregateUsage(coreEvents.map((item) => item.event as { type?: string; usage?: Usage })),
        });
      }
    }
    final = root
      ? await raceBounded(captureWorkspace(root), 250).catch((collectionError) => {
          collectionErrors.push(collectionError);
          return initial;
        })
      : initial;
    let sessionLines: unknown[] = [];
    let childSessions: RuntimeSessionSnapshot[] = [];
    if (threadId && threadCwd) {
      try {
        const paths = await raceBounded(ensureDiligentDir(threadCwd), 250);
        sessionLines = await raceBounded(readSessionLines(join(paths.sessions, `${threadId}.jsonl`)), 250);
        childSessions = await raceBounded(captureChildSessions(threadCwd, threadId), 250);
      } catch (collectionError) {
        collectionErrors.push(collectionError);
      }
    }
    const message = normalizeWorkspaceEvidence(
      error instanceof Error ? error.message : String(error),
      root,
      outputRoot,
    );
    const rootTimeout = error instanceof RuntimeDeadlineError && error.kind === "root";
    const failure: EvalFailure = rootTimeout
      ? {
          dimension: "harness_terminal",
          category: "budget_exceeded",
          code: "budget_exceeded.timeout",
          message: `Runtime task exceeded ${task.limits.timeoutMs}ms.`,
        }
      : {
          dimension: "harness_terminal",
          category: message.includes("configuration.") ? "configuration" : "runner_error",
          code:
            error instanceof RuntimeDeadlineError && error.kind === "phase"
              ? `runner_error.${error.phase.replaceAll(" ", "_")}_timeout`
              : message.split(":")[0] || "runner_error.exception",
          message,
        };
    const allRequests = [...serverRequests, ...(client?.serverRequests ?? [])];
    const normalizedTurns = normalizeWorkspaceEvidence(turns, root, outputRoot);
    annotateToolTraceActors(traces, normalizedTurns, threadId);
    const execution = normalizeWorkspaceEvidence<RuntimeEvalExecution<unknown>>(
      {
        taskId: task.id,
        profile,
        seed,
        startedAt: startedAt.toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        termination: rootTimeout ? "timeout" : "runner_error",
        turns: normalizedTurns,
        compactions: normalizeWorkspaceEvidence(compactions, root, outputRoot),
        threadCwd: normalizeWorkspaceEvidence(threadCwd, root, outputRoot),
        advertisedTools: normalizeWorkspaceEvidence(advertisedTools, root, outputRoot),
        threadReads: normalizeWorkspaceEvidence(threadReads, root, outputRoot),
        protocolActions: normalizeWorkspaceEvidence(protocolActions, root, outputRoot),
        providerCalls: normalizeWorkspaceEvidence(providerCalls, root, outputRoot),
        toolCalls: normalizeWorkspaceEvidence(traces, root, outputRoot),
        toolOutputFiles: normalizeWorkspaceEvidence(outputStore?.files ?? [], root, outputRoot),
        approvals: normalizeWorkspaceEvidence(
          allRequests.filter((request) => request.method === "approval/request"),
          root,
          outputRoot,
        ),
        userInputRequests: normalizeWorkspaceEvidence(
          allRequests.filter((request) => request.method === "userInput/request"),
          root,
          outputRoot,
        ),
        logs: normalizeWorkspaceEvidence(logs, root, outputRoot),
        session: {
          threadId,
          ...(threadId && { path: "$WORKSPACE/.diligent/sessions/$SESSION.jsonl" }),
          lines: normalizeWorkspaceEvidence(sessionLines, root, outputRoot),
        },
        childSessions: normalizeWorkspaceEvidence(childSessions, root, outputRoot),
        workspace: { initial, final },
        runtimeState: captureRuntimeState(initial, final, stateRoots),
        verifier: verifier ? normalizeWorkspaceEvidence(verifier, root, outputRoot) : undefined,
        world: normalizeWorkspaceEvidence(world, root, outputRoot),
        error: { name: error instanceof Error ? error.name : "Error", message },
      },
      root,
      outputRoot,
    );
    const failureList = [failure, ...failures];
    failureList.push(
      ...checkRuntimeStatePolicy(
        execution.runtimeState,
        task.statePolicy ?? { allowedMutations: ["infrastructure", "sessions"] },
        false,
      ),
    );
    if (collectionErrors.length > 0) {
      failureList.push({
        dimension: "harness_terminal",
        category: "runner_error",
        code: "runner_error.evidence_collection_failed",
        message: normalizeWorkspaceEvidence(
          collectionErrors.map((item) => (item instanceof Error ? item.message : String(item))).join("; "),
          root,
          outputRoot,
        ),
      });
    }
    let worldSnapshot: unknown = null;
    if (world !== undefined && !(error instanceof RuntimeDeadlineError)) {
      worldSnapshot = await raceBounded(task.snapshotWorld(world), 250).catch((collectionError) => {
        const collectionFailure: EvalFailure = {
          dimension: "harness_terminal",
          category: "runner_error",
          code: "runner_error.evidence_collection_failed",
          message: normalizeWorkspaceEvidence(
            collectionError instanceof Error ? collectionError.message : String(collectionError),
            root,
            outputRoot,
          ),
        };
        failureList.push(collectionFailure);
        return null;
      });
    }
    resultForCleanup = {
      passed: false,
      status: deriveEvalStatus(failureList, diagnostics),
      failure,
      failures: failureList,
      ...(diagnostics.length > 0 && { diagnostics }),
      execution,
      worldSnapshot,
    };
    return resultForCleanup;
  } finally {
    deadline.close();
    try {
      for (const action of activeActions) {
        action.cancelled = true;
        clearTimeout(action.timer);
        clearTimeout(action.requestTimer);
      }
      try {
        client?.close();
      } catch (error) {
        recordCleanupFailure(resultForCleanup, error, root, outputRoot);
      }
      if (world !== undefined) {
        try {
          await raceBounded(Promise.resolve(task.cleanup?.(world)), 2_000);
        } catch (error) {
          recordCleanupFailure(resultForCleanup, error, root, outputRoot);
        }
      }
      if (outputRoot) {
        try {
          await raceBounded(removeTemporaryRoot(outputRoot), 2_000);
        } catch (error) {
          recordCleanupFailure(resultForCleanup, error, root, outputRoot);
        }
      }
      try {
        if (root) await raceBounded(removeTemporaryRoot(root), 2_000);
      } catch (error) {
        recordCleanupFailure(resultForCleanup, error, root, outputRoot);
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

function recordCleanupFailure(
  result: RuntimeEvalExecutionResult | undefined,
  error: unknown,
  root: string,
  outputRoot?: string,
): void {
  if (!result) return;
  const failure: EvalFailure = {
    dimension: "harness_terminal",
    category: "runner_error",
    code: "runner_error.cleanup_failed",
    message: normalizeWorkspaceEvidence(error instanceof Error ? error.message : String(error), root, outputRoot),
  };
  result.failures.push(failure);
  result.failure ??= failure;
  result.passed = false;
  result.status = deriveEvalStatus(result.failures, result.diagnostics);
}

function classifyRuntimeTerminalFailure(execution: RuntimeEvalExecution<unknown>): EvalFailure {
  const fatal = execution.turns
    .flatMap((turn) => turn.coreEvents)
    .findLast((snapshot) => snapshot.event.type === "error" && snapshot.event.fatal);
  const error = fatal?.event.type === "error" ? fatal.event.error : undefined;
  if (error?.providerErrorType === "auth") {
    return {
      dimension: "harness_terminal",
      category: "provider_auth",
      code: "provider_auth.rejected",
      message: error.message,
    };
  }
  if (error?.providerErrorType && error.isRetryable) {
    return {
      dimension: "harness_terminal",
      category: "provider_transient",
      code: `provider_transient.${error.providerErrorType}`,
      message: error.message,
    };
  }
  if (error?.providerErrorType) {
    return {
      dimension: "harness_terminal",
      category: "provider_terminal",
      code: `provider_terminal.${error.providerErrorType}`,
      message: error.message,
    };
  }
  return {
    dimension: "harness_terminal",
    category: "runner_error",
    code: "runner_error.runtime_turn_failed",
    message: error?.message ?? "Runtime turn failed without serialized error evidence.",
  };
}

function normalizeWorkspaceEvidence<T>(value: T, root: string, outputRoot?: string): T {
  if (typeof value === "string") {
    const aliasedRoot = root && process.platform === "darwin" ? `/private${normalizePlatformAlias(root)}` : root;
    const aliasedOutputRoot =
      outputRoot && process.platform === "darwin" ? `/private${normalizePlatformAlias(outputRoot)}` : outputRoot;
    let normalized: string = value;
    for (const candidate of [aliasedOutputRoot, outputRoot]) {
      if (candidate) normalized = normalized.split(candidate).join("$TOOL_OUTPUT");
    }
    for (const candidate of [aliasedRoot, root]) {
      if (candidate) normalized = normalized.split(candidate).join("$WORKSPACE");
    }
    return normalizeEvidencePath(normalized) as T;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeWorkspaceEvidence(item, root, outputRoot)) as T;
  if (value === null || typeof value !== "object") return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "data" && isRecord(value) && value.type === "base64"
        ? isSafeImageSidecarBlobRef(item)
          ? item
          : "[base64 omitted]"
        : normalizeWorkspaceEvidence(item, root, outputRoot),
    ]),
  );
  if (!Array.isArray(normalized.blocks)) return normalized as T;
  const registeredFileBlocks = normalized.blocks.filter(isRegisteredOutputFileBlock);
  if (registeredFileBlocks.length === 0) return normalized as T;
  normalized.blocks = normalized.blocks.map((block) =>
    isRegisteredOutputFileBlock(block) ? { ...block, content: OMITTED_REGISTERED_OUTPUT_CONTENT } : block,
  );
  normalized.inputSummary = registeredFileBlocks[0]!.filePath;
  return normalized as T;
}

function isRegisteredOutputFileBlock(value: unknown): value is Record<string, unknown> & { filePath: string } {
  return (
    isRecord(value) &&
    value.type === "file" &&
    typeof value.filePath === "string" &&
    value.filePath.startsWith("$TOOL_OUTPUT/")
  );
}

function isSafeImageSidecarBlobRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_IMAGE_SIDECAR_BLOB_REF.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

interface ActiveProtocolAction {
  definition: RuntimeTurnProtocolAction;
  trace: RuntimeProtocolActionTrace;
  occurrence: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  requestTimer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  cancelled: boolean;
  getClient: () => RuntimeProtocolClient | undefined;
  getThreadId: () => string;
  executionStarted: number;
}

function activateProtocolActions(
  definitions: readonly RuntimeTurnProtocolAction[],
  turnIndex: number,
  taskTimeoutMs: number,
  traces: RuntimeProtocolActionTrace[],
  deps: Pick<ActiveProtocolAction, "getClient" | "getThreadId" | "executionStarted">,
): ActiveProtocolAction[] {
  const ids = new Set<string>();
  return definitions.map((definition) => {
    if (!definition.id || ids.has(definition.id))
      throw new Error(`configuration.invalid_protocol_action: duplicate or empty action id ${definition.id}.`);
    ids.add(definition.id);
    if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0 || definition.timeoutMs > taskTimeoutMs)
      throw new Error(`configuration.invalid_protocol_action: invalid timeout for ${definition.id}.`);
    const occurrence = definition.trigger.occurrence ?? 1;
    if (!Number.isInteger(occurrence) || occurrence <= 0)
      throw new Error(`configuration.invalid_protocol_action: invalid occurrence for ${definition.id}.`);
    if (definition.trigger.source === "runtime_event" && !definition.trigger.eventType)
      throw new Error(`configuration.invalid_protocol_action: ${definition.id} requires an eventType.`);
    if (definition.trigger.source === "notification" && !definition.trigger.method)
      throw new Error(`configuration.invalid_protocol_action: ${definition.id} requires a method.`);

    const trace: RuntimeProtocolActionTrace = {
      id: definition.id,
      turnIndex,
      status: "awaiting_trigger",
      timeoutMs: definition.timeoutMs,
      trigger: structuredClone(definition.trigger),
      triggerCount: 0,
      request: structuredClone(definition.request),
    };
    traces.push(trace);
    const action: ActiveProtocolAction = {
      definition,
      trace,
      occurrence,
      deadline: performance.now() + definition.timeoutMs,
      timer: undefined as never,
      cancelled: false,
      ...deps,
    };
    action.timer = setTimeout(() => {
      if (trace.status === "awaiting_trigger") trace.status = "missing_trigger";
    }, definition.timeoutMs);
    return action;
  });
}

function handleProtocolActionNotification(
  action: ActiveProtocolAction,
  notification: DiligentServerNotification,
): void {
  const evidence = matchProtocolActionTrigger(action.definition, notification);
  if (evidence === undefined) return;
  action.trace.triggerCount += 1;
  if (action.trace.triggerCount > action.occurrence) {
    if (!action.definition.trigger.allowSubsequentMatches) action.trace.status = "repeated_trigger";
    return;
  }
  if (action.trace.triggerCount !== action.occurrence) return;
  if (performance.now() > action.deadline) {
    action.trace.status = "missing_trigger";
    return;
  }

  action.trace.triggeredAtMs = Math.round(performance.now() - action.executionStarted);
  action.trace.triggerEvidence = structuredClone(evidence);
  action.pending = sendProtocolAction(action);
}

function matchProtocolActionTrigger(
  definition: RuntimeTurnProtocolAction,
  notification: DiligentServerNotification,
): unknown | undefined {
  const trigger = definition.trigger;
  if (trigger.source === "notification") return notification.method === trigger.method ? notification : undefined;
  if (notification.method !== "agent/event") return undefined;
  const event = (notification.params as { event?: { type?: string; toolName?: string; isError?: boolean } }).event;
  if (!event || event.type !== trigger.eventType) return undefined;
  if (trigger.toolName !== undefined && event.toolName !== trigger.toolName) return undefined;
  if (trigger.isError !== undefined && event.isError !== trigger.isError) return undefined;
  return event;
}

async function sendProtocolAction(action: ActiveProtocolAction): Promise<void> {
  const client = action.getClient();
  if (!client) {
    action.trace.status = "request_failed";
    action.trace.error = "Runtime protocol client is closed.";
    return;
  }
  clearTimeout(action.timer);
  const params = { ...action.definition.request.params, threadId: action.getThreadId() };
  action.trace.request = { method: action.definition.request.method, params: structuredClone(params) };
  action.trace.requestedAtMs = Math.round(performance.now() - action.executionStarted);
  action.trace.status = "requested";
  try {
    const remainingMs = Math.max(1, Math.round(action.deadline - performance.now()));
    const response = await withProtocolActionTimeout(
      client.request(action.definition.request.method, params),
      remainingMs,
      action,
    );
    if (action.cancelled) return;
    action.trace.response = response;
    action.trace.respondedAtMs = Math.round(performance.now() - action.executionStarted);
    if (action.trace.status === "requested") action.trace.status = "completed";
  } catch (error) {
    if (action.cancelled) return;
    action.trace.status = "request_failed";
    action.trace.error = error instanceof Error ? error.message : String(error);
  }
}

async function withProtocolActionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  action: ActiveProtocolAction,
): Promise<T> {
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        action.requestTimer = setTimeout(
          () => reject(new Error(`Runtime protocol action ${action.definition.id} exceeded ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(action.requestTimer);
    action.requestTimer = undefined;
  }
}

function finalizeProtocolAction(action: ActiveProtocolAction, failures: EvalFailure[]): void {
  const { trace } = action;
  if (trace.triggerCount < action.occurrence && trace.status !== "request_failed") trace.status = "missing_trigger";
  if (trace.triggerCount > action.occurrence && !action.definition.trigger.allowSubsequentMatches)
    trace.status = "repeated_trigger";
  if (trace.status === "missing_trigger") {
    failures.push({
      dimension: "runtime_policy",
      category: "runtime_contract",
      code: "runtime_contract.protocol_action_missing_trigger",
      message: `Protocol action ${trace.id} did not receive its declared trigger within ${trace.timeoutMs}ms.`,
    });
  } else if (trace.status === "repeated_trigger") {
    failures.push({
      dimension: "runtime_policy",
      category: "runtime_contract",
      code: "runtime_contract.protocol_action_repeated_trigger",
      message: `Protocol action ${trace.id} matched ${trace.triggerCount} times; expected exactly ${action.occurrence}.`,
    });
  } else if (trace.status === "request_failed") {
    failures.push({
      dimension: "runtime_policy",
      category: "runtime_contract",
      code: "runtime_contract.protocol_action_request_failed",
      message: `Protocol action ${trace.id} failed: ${trace.error ?? "unknown error"}`,
    });
  }
}

function clampOutputTokens(
  stream: StreamFunction,
  maximum: number,
  beforeTurn: () => void,
  beforeStream: (...args: Parameters<StreamFunction>) => void,
): StreamFunction {
  return (model, context, options) => {
    beforeTurn();
    const effectiveOptions = { ...options, maxTokens: Math.min(options.maxTokens ?? maximum, maximum) };
    beforeStream(model, context, effectiveOptions);
    return stream(model, context, effectiveOptions);
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
