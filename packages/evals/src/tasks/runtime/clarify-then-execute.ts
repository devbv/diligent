// @summary Runtime eval for scripted user clarification followed by exact execution

import type { DiligentServerRequestResponse } from "@diligent/protocol";
import type { RuntimeEvalTask } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
} from "./helpers";

export interface ClarifyThenExecuteWorld extends RuntimeFixtureWorld {
  answer: string;
  expectedHash: string;
}

export const clarifyThenExecuteTask: RuntimeEvalTask<ClarifyThenExecuteWorld> = {
  id: "clarify-then-execute",
  description: "Request an unavailable value from the client and use it after switching to default mode.",
  fixtureVersion: "clarify-then-execute-v0",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 12,
    maxToolCalls: 8,
    timeoutMs: 240_000,
    maxUserInputRequests: 1,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["request_user_input", "write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["user_input", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const answer = seededToken(seed, "TARGET");
    const expected = `${answer}\n`;
    return {
      root,
      seed,
      answer,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [],
      allowedChanges: ["TARGET.txt"],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      mode: "plan",
      message:
        "The required release target is unavailable in the workspace and this request. You must call request_user_input exactly once with one question using id release_target, header Target, and at least one option. Wait for the custom answer, make no files, and then reply only RECEIVED.",
    },
    {
      kind: "turn",
      mode: "default",
      message:
        "Create TARGET.txt containing only the release target supplied by the user in the previous turn and one trailing newline. Do not repeat it in your response.",
    },
  ],
  respondToServerRequest(world, request): DiligentServerRequestResponse {
    if (request.method === "approval/request") return { method: request.method, result: { decision: "once" } };
    return {
      method: request.method,
      result: { answers: { release_target: world.answer } },
    };
  },
  snapshotWorld: async (world) => ({ answer: world.answer, result: await exactFile(world.root, "TARGET.txt") }),
  evaluate(input) {
    if (input.userInputRequests.length !== 1)
      return {
        passed: false,
        code: "clarify_execute.request_count",
        message: "Expected exactly one user-input request.",
        dimension: "behavior",
      };
    const request = input.userInputRequests[0];
    const questions =
      isRecord(request) && isRecord(request.params) && isRecord(request.params.request)
        ? request.params.request.questions
        : undefined;
    if (
      !Array.isArray(questions) ||
      questions.length !== 1 ||
      !isRecord(questions[0]) ||
      questions[0].id !== "release_target"
    )
      return {
        passed: false,
        code: "clarify_execute.wrong_question",
        message: "The scripted release_target question was not asked exactly once.",
        dimension: "behavior",
      };
    const firstTurnTools = input.turns[0]!.coreEvents.filter((item) => item.event.type === "tool_start").map(
      (item) => (item.event as { toolName: string }).toolName,
    );
    if (firstTurnTools.length !== 1 || firstTurnTools[0] !== "request_user_input")
      return {
        passed: false,
        code: "clarify_execute.plan_tools",
        message: "The plan turn must only request user input.",
        dimension: firstTurnTools.length === 1 ? "runtime_policy" : "behavior",
      };
    const result = input.workspace.final.entries.find((entry) => entry.path === "TARGET.txt");
    if (result?.sha256 === sha256Text(input.world.answer))
      return {
        passed: false,
        code: "clarify_execute.wrong_target",
        message: "TARGET.txt omitted the prompt-declared trailing newline.",
        dimension: "format_contract",
      };
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : {
          passed: false,
          code: "clarify_execute.wrong_target",
          message: "TARGET.txt did not contain the exact scripted user answer.",
          dimension: "semantic_goal",
        };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
