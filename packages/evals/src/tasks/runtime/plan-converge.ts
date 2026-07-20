// @summary Runtime eval for plan-mode discovery, one bounded question, and decision-complete convergence

import type { DiligentServerRequestResponse } from "@diligent/protocol";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

export interface PlanConvergeWorld extends RuntimeFixtureWorld {
  apiFact: string;
  uiFact: string;
  preference: string;
}

const API_PATH = "facts/api.txt";
const UI_PATH = "facts/ui.txt";
const QUESTION_ID = "rollout_preference";

export const planConvergeTask: RuntimeEvalTask<PlanConvergeWorld> = {
  id: "plan-converge",
  description: "Discover two fixture facts, ask for one unavailable preference, and converge on one final plan.",
  fixtureVersion: "plan-converge-v3",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 6,
    maxToolCalls: 5,
    maxUserInputRequests: 1,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "request_user_input"],
    allowedCapabilities: ["read", "user_input"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const apiFact = seededToken(seed, "API_FACT");
    const uiFact = seededToken(seed, "UI_FACT");
    const preference = seededToken(seed, "PREFERENCE");
    await writeFixture(root, {
      ".git/.keep": "fixture boundary\n",
      [API_PATH]: `${apiFact}\n`,
      [UI_PATH]: `${uiFact}\n`,
    });
    return {
      root,
      seed,
      apiFact,
      uiFact,
      preference,
      expected: "",
      protectedPaths: [".git/.keep", API_PATH, UI_PATH],
      allowedChanges: [],
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      mode: "plan",
      message:
        "Prepare a decision-complete rollout plan. First read facts/api.txt and facts/ui.txt. The rollout preference is genuinely unavailable from the workspace, so ask exactly one bounded question for it using the stable id rollout_preference. After the answer, finish with exactly one <proposed_plan> block and make no changes.",
    },
  ],
  respondToServerRequest(world, request): DiligentServerRequestResponse {
    if (request.method === "approval/request") return { method: request.method, result: { decision: "once" } };
    return { method: request.method, result: { answers: { [QUESTION_ID]: world.preference } } };
  },
  verify: (world, signal) =>
    verifyExactFiles(world, { [API_PATH]: `${world.apiFact}\n`, [UI_PATH]: `${world.uiFact}\n` }, signal),
  snapshotWorld: async (world) => ({ apiFact: world.apiFact, uiFact: world.uiFact, preference: world.preference }),
  evaluate(input) {
    const traceError = validateTraceShape(input);
    if (traceError) return fail("trace_shape", traceError.message, traceError.dimension);
    const request = input.toolCalls.find((call) => call.name === "request_user_input" && call.outcome === "success")!;
    const askedQuestion = boundedQuestion(request.input);
    if (!askedQuestion)
      return fail(
        "question",
        "The successful request must contain one bounded rollout_preference question.",
        "behavior",
      );
    const text = lastAssistantText(input);
    if (count(text, "<proposed_plan>") !== 1 || count(text, "</proposed_plan>") !== 1)
      return fail("plan_block", "The final response must contain exactly one proposed_plan block.", "format_contract");
    for (const value of [input.world.apiFact, input.world.uiFact, input.world.preference]) {
      if (!text.includes(value))
        return fail("plan_facts", "The final plan must contain every hidden fact and preference.", "semantic_goal");
    }
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Fixture verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0) return fail("verifier", "Fixture verification failed.", "runtime_policy");
    const recoveries = input.toolCalls.filter((call) => call.name === "read" && call.outcome !== "success").length;
    const successfulReads = input.toolCalls.filter((call) => call.name === "read" && call.outcome === "success").length;
    const diagnostics = [];
    if (recoveries > 0)
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "plan_converge.read_recovery",
        message: `Observed ${recoveries} bounded read recovery attempt(s).`,
      });
    if (successfulReads > 2)
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "plan_converge.additional_safe_read",
        message: `Observed ${successfulReads - 2} additional safe read(s).`,
      });
    return diagnostics.length > 0 ? { passed: true, diagnostics } : { passed: true };
  },
};

function validateTraceShape(
  input: RuntimeEvalExecution<PlanConvergeWorld>,
): { message: string; dimension: EvalDimension } | undefined {
  const traces = [...input.toolCalls].sort((left, right) => left.sequence - right.sequence);
  const parentThreadId = input.turns[0]!.threadId;
  if (traces.some((trace) => trace.threadId !== parentThreadId || trace.childThreadId !== undefined))
    return {
      message: "Every trace must be attributed only to the parent thread.",
      dimension: "runtime_policy",
    };
  if (traces.some((trace) => trace.name !== "read" && trace.name !== "request_user_input"))
    return { message: "Plan convergence used an undeclared tool.", dimension: "runtime_policy" };
  const reads = traces.filter((trace) => trace.name === "read");
  if (reads.some((trace) => !isDeclaredRead(trace)))
    return { message: "A read targeted an undeclared path.", dimension: "runtime_policy" };
  const questions = traces.filter((trace) => trace.name === "request_user_input");
  if (questions.length !== 1 || questions[0]!.capability !== "user_input" || questions[0]!.outcome !== "success")
    return { message: "Expected one successful clarification after discovery.", dimension: "behavior" };
  const question = questions[0]!;
  const apiRead = reads.find((trace) => isExactSuccessfulRead(trace, API_PATH, input.world.apiFact));
  if (!apiRead)
    return {
      message: "The API fact must be read successfully from its exact absolute path.",
      dimension: "runtime_policy",
    };
  const uiRead = reads.find((trace) => isExactSuccessfulRead(trace, UI_PATH, input.world.uiFact));
  if (!uiRead)
    return {
      message: "The UI fact must be read successfully from its exact absolute path.",
      dimension: "runtime_policy",
    };
  if (question.sequence <= Math.max(apiRead.sequence, uiRead.sequence))
    return {
      message: "The rollout preference was requested before both fixture facts were discovered.",
      dimension: "behavior",
    };
  return undefined;
}

function isDeclaredRead(call: RuntimeToolTrace): boolean {
  if (call.capability !== "read" || !isRecord(call.input) || typeof call.input.file_path !== "string") return false;
  const filePath = call.input.file_path;
  const declared = [API_PATH, UI_PATH];
  return declared.some((path) => filePath === path || filePath === `$WORKSPACE/${path}`);
}

function isExactSuccessfulRead(call: RuntimeToolTrace, path: string, fact: string): boolean {
  return (
    call.name === "read" &&
    call.capability === "read" &&
    call.outcome === "success" &&
    isRecord(call.input) &&
    call.input.file_path === `$WORKSPACE/${path}` &&
    toolOutputText(call).includes(fact)
  );
}

function boundedQuestion(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.questions)) return undefined;
  if (value.questions.length !== 1 || !isRecord(value.questions[0])) return undefined;
  const question = value.questions[0];
  const keys = Object.keys(question);
  if (
    !keys.every((key) => ["allow_multiple", "header", "id", "options", "question"].includes(key)) ||
    question.id !== QUESTION_ID ||
    typeof question.header !== "string" ||
    question.header.length === 0 ||
    question.header.length > 12 ||
    typeof question.question !== "string" ||
    question.question.length === 0 ||
    (question.allow_multiple !== undefined && question.allow_multiple !== false) ||
    !Array.isArray(question.options) ||
    question.options.length < 1 ||
    question.options.length > 4
  )
    return undefined;
  if (
    question.options.some(
      (option) =>
        !isRecord(option) ||
        Object.keys(option).length !== 2 ||
        typeof option.label !== "string" ||
        option.label.length === 0 ||
        typeof option.description !== "string" ||
        option.description.length === 0,
    )
  )
    return undefined;
  return question;
}

function toolOutputText(call: RuntimeToolTrace): string {
  if (typeof call.output === "string") return call.output;
  return isRecord(call.output) && typeof call.output.output === "string" ? call.output.output : "";
}

function lastAssistantText(input: Parameters<typeof planConvergeTask.evaluate>[0]): string {
  const message = input.turns
    .at(-1)
    ?.messages.filter((item) => item.role === "assistant")
    .at(-1);
  return (
    message?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  );
}

function count(text: string, value: string): number {
  return text.split(value).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `plan_converge.${code}`, message, dimension };
}
