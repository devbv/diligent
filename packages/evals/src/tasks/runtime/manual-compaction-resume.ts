// @summary Runtime eval for manual compaction, restart, and exact context continuation

import type { RuntimeEvalTask } from "../../runtime-task";
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
  fixtureVersion: "manual-compaction-resume-v0",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 12, maxToolCalls: 8, timeoutMs: 360_000 },
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
      message: `Remember these two exact project facts for work after context compaction: alpha=${world.alpha}; beta=${world.beta}. Reply only ACK.`,
    },
    { kind: "compact" },
    { kind: "restart_and_resume" },
    {
      kind: "turn",
      message:
        "Create CONTEXT.json as one compact JSON object with keys alpha and beta containing the two exact facts from before compaction, followed by one newline. Do not repeat the values in your response.",
    },
  ],
  snapshotWorld: async (world) => ({
    alpha: world.alpha,
    beta: world.beta,
    result: await exactFile(world.root, "CONTEXT.json"),
  }),
  evaluate(input) {
    if (input.turns.length !== 2)
      return { passed: false, code: "manual_compaction.turn_count", message: "Expected two completed turns." };
    if (input.compactions.length !== 1)
      return {
        passed: false,
        code: "manual_compaction.count",
        message: "Expected exactly one manual compaction.",
      };
    const compactionEntry = input.session.lines.find((line) => isRecord(line) && line.type === "compaction") as
      | Record<string, unknown>
      | undefined;
    if (!compactionEntry || typeof compactionEntry.summary !== "string" || compactionEntry.summary.length === 0)
      return {
        passed: false,
        code: "manual_compaction.persistence",
        message: "The persisted compaction summary was missing.",
      };
    if (!input.toolCalls.some((call) => call.capability === "write" && !call.error))
      return { passed: false, code: "manual_compaction.no_write", message: "No continuation write succeeded." };
    const result = input.workspace.final.entries.find((entry) => entry.path === "CONTEXT.json");
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : {
          passed: false,
          code: "manual_compaction.wrong_context",
          message: "CONTEXT.json did not contain the exact pre-compaction facts.",
        };
  },
};

async function createCompactionRuntimeConfig(world: ManualCompactionResumeWorld, profile: EvalProfile) {
  const config = await createFixtureRuntimeConfig(world, profile);
  return {
    ...config,
    compaction: { enabled: true, reservePercent: 16, keepRecentTokens: 1, timeoutMs: 180_000 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
