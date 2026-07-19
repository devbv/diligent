// @summary Runtime eval for manual compaction, restart, and exact context continuation

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPACTION_MIN_INPUT_TOKENS } from "@diligent/core/compaction-contract";
import type { RuntimeEvalTask, RuntimeVerifierResult } from "../../runtime-task";
import type { EvalProfile } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
} from "./helpers";

export interface ManualCompactionResumeWorld extends RuntimeFixtureWorld {
  alpha: string;
  beta: string;
  expectedHash: string;
}

export const manualCompactionResumeTask: RuntimeEvalTask<ManualCompactionResumeWorld> = {
  id: "manual-compaction-resume",
  description: "Compact a session, restart the server, and continue from the compacted facts.",
  fixtureVersion: "manual-compaction-resume-v1",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 12, maxToolCalls: 8, timeoutMs: 360_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const alpha = seededToken(seed, "ALPHA");
    const beta = seededToken(seed, "BETA");
    const expected = `${JSON.stringify({ alpha, beta })}\n`;
    return {
      root,
      seed,
      alpha,
      beta,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [],
      allowedChanges: ["CONTEXT.json"],
    };
  },
  createRuntimeConfig: createCompactionRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: [
        `Remember these two exact project facts for work after context compaction: alpha=${world.alpha}; beta=${world.beta}.`,
        "The following deterministic filler makes this session eligible for manual compaction; it carries no additional facts:",
        eligibleCompactionPadding(),
        "Reply only ACK.",
      ].join("\n"),
    },
    { kind: "compact" },
    { kind: "restart_and_resume" },
    {
      kind: "turn",
      message:
        "Create CONTEXT.json as one valid JSON object with exactly the keys alpha and beta containing the two exact facts from before compaction, followed by exactly one newline. JSON whitespace and key order are not constrained. Do not repeat the values in your response.",
    },
  ],
  verify: verifyContextJson,
  snapshotWorld: async (world) => ({
    alpha: world.alpha,
    beta: world.beta,
    result: await exactFile(world.root, "CONTEXT.json"),
  }),
  evaluate(input) {
    if (!input.toolCalls.some((call) => call.capability === "write" && !call.error))
      return {
        passed: false,
        code: "manual_compaction.no_write",
        message: "No continuation write succeeded.",
        dimension: "behavior",
      };
    const result = input.workspace.final.entries.find((entry) => entry.path === "CONTEXT.json");
    if (input.verifier?.timedOut)
      return {
        passed: false,
        code: "manual_compaction.wrong_context",
        message: "The independent semantic JSON verifier timed out.",
        dimension: "harness_terminal",
      };
    if (result?.kind === "file" && input.verifier?.exitCode === 0) return { passed: true };
    const formatFailure = input.verifier?.stderr.startsWith("format_contract:") ?? false;
    return {
      passed: false,
      code: "manual_compaction.wrong_context",
      message: "CONTEXT.json did not contain the exact pre-compaction facts and declared envelope.",
      dimension: formatFailure ? "format_contract" : "semantic_goal",
    };
  },
};

function eligibleCompactionPadding(): string {
  const unit = "eligible-manual-compaction-padding ";
  return unit.repeat(Math.ceil((COMPACTION_MIN_INPUT_TOKENS * 4) / unit.length) + 1);
}

async function verifyContextJson(world: ManualCompactionResumeWorld): Promise<RuntimeVerifierResult> {
  const started = performance.now();
  let valid = false;
  let stdout = "";
  let stderr = "";
  try {
    const text = await readFile(join(world.root, "CONTEXT.json"), "utf8");
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    const parsed: unknown = JSON.parse(body);
    const semanticValid =
      isRecord(parsed) &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(",") === "alpha,beta" &&
      parsed.alpha === world.alpha &&
      parsed.beta === world.beta;
    const formatValid = text.endsWith("\n") && !text.endsWith("\n\n") && body.trimEnd() === body;
    valid = semanticValid && formatValid;
    stdout = valid ? "semantic JSON matched" : "semantic JSON mismatch";
    if (!valid)
      stderr = semanticValid
        ? "format_contract: CONTEXT.json violated the declared final-newline envelope."
        : "semantic_goal: CONTEXT.json did not preserve the exact compacted facts.";
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
  }
  return {
    argv: ["semantic-json", "CONTEXT.json"],
    exitCode: valid ? 0 : 1,
    elapsedMs: Math.round(performance.now() - started),
    stdout,
    stderr,
    timedOut: false,
  };
}

async function createCompactionRuntimeConfig(world: ManualCompactionResumeWorld, profile: EvalProfile) {
  const config = await createFixtureRuntimeConfig(world, profile);
  return {
    ...config,
    compaction: { enabled: true, reservePercent: 16, timeoutMs: 180_000 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
