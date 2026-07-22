// @summary Executes one isolated eval task with runner-owned budgets and deterministic evaluation

import { Agent, type CoreAgentEvent } from "@diligent/core/agent";
import type { Message, Usage } from "@diligent/core/message-contract";
import type { Model, StreamFunction } from "@diligent/core/provider-contract";
import { ProviderError, ProviderErrorType } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import { createLogger } from "@diligent/logging";
import {
  type EvalDiagnostic,
  type EvalExecution,
  type EvalExecutionError,
  type EvalExecutionResult,
  type EvalFailure,
  type EvalProfile,
  type EvalTask,
  type EvalTerminationReason,
  ZERO_USAGE,
} from "../task";
import { createBudgetGraceDiagnostics, EVAL_BUDGET_GRACE, resolveEvalHardLimits } from "./budget-policy";
import { checkStructuralInvariants } from "./invariants";

export interface RunEvalExecutionInput<TWorld> {
  task: EvalTask<TWorld>;
  profile: EvalProfile;
  model: Model;
  seed: string;
  streamFunction: StreamFunction;
}

export async function runEvalExecution<TWorld>(
  input: RunEvalExecutionInput<TWorld>,
): Promise<EvalExecutionResult<TWorld>> {
  const { task, profile, model, seed } = input;
  const hardLimits = resolveEvalHardLimits(task.limits);
  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const controller = new AbortController();
  const events: EvalExecution<TWorld>["events"] = [];
  const logs: EvalExecution<TWorld>["logs"] = [];
  const world = task.createWorld(seed);
  let termination: EvalTerminationReason | undefined;
  let primaryFailure: EvalFailure | undefined;
  let capturedError: EvalExecutionError | undefined;
  let turnCount = 0;
  let toolCallCount = 0;
  let returnedMessages: Message[] | undefined;
  let agentEndMessages: Message[] | undefined;
  const diagnostics: EvalDiagnostic[] = [];

  const terminate = (reason: EvalTerminationReason, failure: EvalFailure): void => {
    if (termination !== undefined) return;
    termination = reason;
    primaryFailure = failure;
    controller.abort();
  };

  const tools = wrapTools(task.createTools(world), () => termination);
  const logger = createLogger({
    scope: "eval:core",
    context: { fields: { taskId: task.id, provider: profile.provider, model: profile.model } },
    sink: (record) => {
      logs.push(cloneValue(record));
    },
  });
  const limitedStream = clampOutputTokens(input.streamFunction, task.limits.maxOutputTokens);
  const agent = new Agent(model, task.systemPrompt, tools, {
    effort: profile.effort,
    llmMsgStreamFn: limitedStream,
    logger,
    sessionId: `eval:${task.id}:${profile.provider}`,
  });

  const unsubscribe = agent.subscribe((event) => {
    events.push({ sequence: events.length + 1, relativeMs: elapsed(startedMonotonic), event: cloneValue(event) });
    if (event.type === "agent_end") agentEndMessages = cloneValue(event.messages);
    if (event.type === "turn_start") {
      turnCount += 1;
      if (turnCount > hardLimits.maxTurns) {
        terminate("turn_limit", {
          dimension: "harness_terminal",
          category: "budget_exceeded",
          code: "budget_exceeded.turn_limit",
          message:
            `Turn count exceeded hard limit ${hardLimits.maxTurns} ` +
            `(target ${task.limits.maxTurns} + ${EVAL_BUDGET_GRACE.turns} grace).`,
        });
      }
    }
    if (event.type === "tool_start") {
      toolCallCount += 1;
      if (toolCallCount > hardLimits.maxToolCalls) {
        terminate("tool_call_limit", {
          dimension: "harness_terminal",
          category: "budget_exceeded",
          code: "budget_exceeded.tool_call_limit",
          message:
            `Tool-call count exceeded hard limit ${hardLimits.maxToolCalls} ` +
            `(target ${task.limits.maxToolCalls} + ${EVAL_BUDGET_GRACE.toolCalls} grace).`,
        });
      }
    }
  });

  const timeout = setTimeout(() => {
    terminate("timeout", {
      dimension: "harness_terminal",
      category: "budget_exceeded",
      code: "budget_exceeded.timeout",
      message: `Task exceeded ${task.limits.timeoutMs}ms.`,
    });
  }, task.limits.timeoutMs);

  try {
    returnedMessages = await agent.prompt(task.createUserMessage(world), controller.signal);
    if (termination === undefined) termination = "completed";
  } catch (error) {
    capturedError = toEvalExecutionError(error);
    if (termination === undefined) {
      if (error instanceof ProviderError) {
        termination = "provider_error";
        primaryFailure = classifyProviderFailure(error);
      } else {
        termination = "core_error";
        primaryFailure = {
          dimension: "runtime_policy",
          category: "core_contract",
          code: "core_contract.uncaught_exception",
          message: capturedError.message,
        };
      }
    }
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }

  const messages = cloneValue(returnedMessages ?? agentEndMessages ?? agent.getMessages());
  const execution: EvalExecution<TWorld> = {
    taskId: task.id,
    profile,
    seed,
    startedAt: startedAt.toISOString(),
    elapsedMs: elapsed(startedMonotonic),
    termination: termination ?? "runner_error",
    messages,
    events,
    logs,
    usage: aggregateUsage(events.map((snapshot) => snapshot.event)),
    turnCount,
    toolCallCount,
    world,
    ...(capturedError && { error: capturedError }),
  };

  const failures: EvalFailure[] = [];
  if (primaryFailure) failures.push(primaryFailure);
  if (execution.termination === "completed") {
    diagnostics.push(...createBudgetGraceDiagnostics(task.limits, { turns: turnCount, toolCalls: toolCallCount }));
    failures.push(...checkStructuralInvariants(execution));
    if (failures.length === 0) {
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
                  message: `Evaluator failure ${semantic.code} omitted its required dimension.`,
                },
          );
        }
      } catch (error) {
        failures.push({
          dimension: "harness_terminal",
          category: "evaluator_error",
          code: "evaluator_error.exception",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  let worldSnapshot: unknown = null;
  try {
    worldSnapshot = cloneValue(task.snapshotWorld(world));
  } catch (error) {
    failures.push({
      dimension: "harness_terminal",
      category: "evaluator_error",
      code: "evaluator_error.world_snapshot",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (execution.termination === "runner_error" && failures.length === 0) {
    failures.push({
      dimension: "harness_terminal",
      category: "runner_error",
      code: "runner_error.unknown",
      message: "Runner ended without a result.",
    });
  }

  return {
    passed: failures.length === 0,
    failure: failures[0],
    failures,
    ...(diagnostics.length > 0 && { diagnostics }),
    execution,
    worldSnapshot,
  };
}

function wrapTools(tools: Tool[], getTermination: () => EvalTerminationReason | undefined): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(args, context) {
      const termination = getTermination();
      if (termination && termination !== "completed") {
        return {
          output: `Error: Eval execution stopped before tool "${tool.name}" could run.`,
          metadata: { error: true, evalTermination: termination },
        };
      }
      return tool.execute(args, context);
    },
  }));
}

function clampOutputTokens(streamFunction: StreamFunction, maxOutputTokens: number): StreamFunction {
  return (model, context, options) =>
    streamFunction(model, context, {
      ...options,
      maxTokens: Math.min(options.maxTokens ?? maxOutputTokens, maxOutputTokens),
    });
}

function aggregateUsage(events: CoreAgentEvent[]): Usage {
  return events.reduce<Usage>(
    (total, event) => {
      if (event.type !== "usage") return total;
      return {
        inputTokens: total.inputTokens + event.usage.inputTokens,
        outputTokens: total.outputTokens + event.usage.outputTokens,
        cacheReadTokens: total.cacheReadTokens + event.usage.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + event.usage.cacheWriteTokens,
      };
    },
    { ...ZERO_USAGE },
  );
}

function classifyProviderFailure(error: ProviderError): EvalFailure {
  if (error.errorType === ProviderErrorType.Auth) {
    return {
      dimension: "harness_terminal",
      category: "provider_auth",
      code: "provider_auth.rejected",
      message: error.message,
    };
  }
  if (
    error.errorType === ProviderErrorType.RateLimit ||
    error.errorType === ProviderErrorType.Network ||
    error.errorType === ProviderErrorType.ServerError
  ) {
    return {
      dimension: "harness_terminal",
      category: "provider_transient",
      code: `provider_transient.${error.errorType}`,
      message: error.message,
    };
  }
  return {
    dimension: "harness_terminal",
    category: "provider_terminal",
    code: `provider_terminal.${error.errorType}`,
    message: error.message,
  };
}

function toEvalExecutionError(error: unknown): EvalExecutionError {
  if (error instanceof ProviderError) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack && { stack: error.stack }),
      providerErrorType: error.errorType,
      ...(error.reason && { providerErrorReason: error.reason }),
      isRetryable: error.isRetryable,
      ...(error.statusCode !== undefined && { statusCode: error.statusCode }),
    };
  }
  if (error instanceof Error)
    return { name: error.name, message: error.message, ...(error.stack && { stack: error.stack }) };
  return { name: "Error", message: String(error) };
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
