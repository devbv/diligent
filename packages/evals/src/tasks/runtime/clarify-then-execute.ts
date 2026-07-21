// @summary Runtime eval for natural target clarification followed by scoped execution

import type { DiligentServerRequestResponse } from "@diligent/protocol";
import type { RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

export interface ClarifyThenExecuteWorld extends RuntimeFixtureWorld {
  answer: "staging" | "production";
  desired: string;
  targetPath: string;
  otherPath: string;
  expectedHash: string;
  otherHash: string;
}

const PATHS = {
  staging: "deploy/staging.channel",
  production: "deploy/production.channel",
} as const;

export const clarifyThenExecuteTask: RuntimeEvalTask<ClarifyThenExecuteWorld> = {
  id: "clarify-then-execute",
  description: "Clarify an undecidable deployment target before mutating only the selected configuration.",
  fixtureVersion: "clarify-then-execute-v3",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 8,
    maxToolCalls: 8,
    timeoutMs: 240_000,
    maxUserInputRequests: 1,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["request_user_input", "read", "write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["user_input", "read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const answer = Number.parseInt(seed.slice(0, 4), 36) % 2 === 0 ? "staging" : "production";
    const desired = seededToken(seed, "CHANNEL");
    const targetPath = PATHS[answer];
    const otherPath = answer === "staging" ? PATHS.production : PATHS.staging;
    const initial = {
      [PATHS.staging]: "channel=stable\n",
      [PATHS.production]: "channel=stable\n",
    };
    await writeFixture(root, initial);
    return {
      root,
      seed,
      answer,
      desired,
      targetPath,
      otherPath,
      expected: `channel=${desired}\n`,
      expectedHash: sha256Text(`channel=${desired}\n`),
      otherHash: sha256Text(initial[otherPath]),
      protectedPaths: [otherPath],
      allowedChanges: [targetPath],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      mode: "plan",
      message:
        `Change the deployment channel to ${world.desired}. The project has independent staging and production ` +
        `channel files at ${PATHS.staging} and ${PATHS.production}, but the request does not identify the target ` +
        "environment. Resolve that choice with the user before any mutation and prepare a scoped implementation plan. " +
        "The environment choice alone is sufficient. After it is answered, do not ask a confirmation or follow-up " +
        "question; finish the scoped plan without mutating.",
    },
    {
      kind: "turn",
      mode: "execute",
      message:
        "Implement the environment selected in the preceding clarification without asking another question. Update " +
        "only its channel file to the " +
        `requested ${world.desired} value and leave the other environment unchanged.`,
    },
  ],
  respondToServerRequest(world, request): DiligentServerRequestResponse {
    if (request.method === "approval/request") return { method: request.method, result: { decision: "once" } };
    const questions = request.params.request.questions;
    return {
      method: request.method,
      result: { answers: Object.fromEntries(questions.map((question) => [question.id, world.answer])) },
    };
  },
  verify: (world, signal) =>
    verifyExactFiles(world, { [world.targetPath]: world.expected, [world.otherPath]: "channel=stable\n" }, signal),
  snapshotWorld: async (world) => ({
    selected: await exactFile(world.root, world.targetPath),
    unselected: await exactFile(world.root, world.otherPath),
  }),
  evaluate(input) {
    const questions = input.toolCalls.filter(
      (call) => call.name === "request_user_input" && call.outcome === "success",
    );
    if (questions.length !== 1 || input.userInputRequests.length !== 1)
      return fail("request_count", "The ambiguous target required one clarification.", "behavior");
    if (!hasNaturalTargetQuestion(questions[0]!.input))
      return fail("wrong_question", "The clarification did not distinguish staging from production.", "behavior");
    const writes = input.toolCalls.filter((call) => call.capability === "write" && call.outcome === "success");
    if (writes.some((call) => call.sequence < questions[0]!.sequence))
      return fail(
        "mutation_before_answer",
        "The workspace was mutated before the target was clarified.",
        "runtime_policy",
      );
    if (writes.length === 0)
      return fail("no_write", "No deployment configuration was updated after clarification.", "behavior");
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Deployment verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "The selected and unselected deployment files were not correct.", "semantic_goal");
    const selected = input.workspace.final.entries.find((entry) => entry.path === input.world.targetPath);
    const unselected = input.workspace.final.entries.find((entry) => entry.path === input.world.otherPath);
    if (selected?.sha256 !== input.world.expectedHash)
      return fail("wrong_target", "The clarified deployment target was not updated correctly.", "semantic_goal");
    return unselected?.sha256 === input.world.otherHash
      ? { passed: true }
      : fail("other_changed", "The unselected deployment target changed.", "runtime_policy");
  },
};

function hasNaturalTargetQuestion(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length !== 1) return false;
  const question = value.questions[0];
  if (!isRecord(question) || typeof question.question !== "string" || !Array.isArray(question.options)) return false;
  const rendered = JSON.stringify(question).toLowerCase();
  return rendered.includes("staging") && rendered.includes("production");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `clarify_execute.${code}`, message, dimension };
}
