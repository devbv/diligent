// @summary Runtime eval for preserving a fresh second-turn request across automatic compaction

import type { RuntimeConfig } from "@diligent/runtime";
import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
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

const TARGET_PATH = "FRESH.txt";
const CONTROL_PATH = "control.txt";
const LARGE_PRIOR_CONTEXT = `Prior context for compaction only. ${"archive detail ".repeat(24_000)}`;

export interface FreshPromptAfterCompactionWorld extends RuntimeFixtureWorld {
  freshValue: string;
  expectedHash: string;
  controlHash: string;
}

export const freshPromptAfterCompactionTask: RuntimeEvalTask<FreshPromptAfterCompactionWorld> = {
  id: "fresh-prompt-after-compaction",
  description: "Apply an opaque second-turn request that arrives exactly when prior context is compacted.",
  fixtureVersion: "fresh-prompt-after-compaction-v1",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 6,
    maxToolCalls: 2,
    maxChangedFiles: 1,
    maxChangedBytes: 4_096,
    timeoutMs: 300_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["apply_patch", "edit", "write"],
    allowedCapabilities: ["write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const freshValue = seededToken(seed, "FRESH_REQUIREMENT");
    const expected = `${freshValue}\n`;
    const control = "protected control\n";
    await writeFixture(root, { [CONTROL_PATH]: control });
    return {
      root,
      seed,
      freshValue,
      expected,
      expectedHash: sha256Text(expected),
      controlHash: sha256Text(control),
      protectedPaths: [CONTROL_PATH],
      allowedChanges: [TARGET_PATH],
    };
  },
  createRuntimeConfig: createCompactingConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      mode: "default",
      message: `${LARGE_PRIOR_CONTEXT}\nAcknowledge this archival context with only ACK. Do not create or change files.`,
    },
    {
      kind: "turn",
      mode: "default",
      message:
        `Create ${TARGET_PATH} containing only ${world.freshValue} and one trailing newline. ` +
        "This new requirement supersedes any prior archival context.",
    },
  ],
  verify: (world, signal) => verifyExactFiles(world, { [TARGET_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({ artifact: await exactFile(world.root, TARGET_PATH) }),
  evaluate(input) {
    const firstTurnToolIds = new Set(
      input.turns[0]?.coreEvents.flatMap(({ event }) => (event.type === "tool_start" ? [event.toolCallId] : [])) ?? [],
    );
    if (input.toolCalls.some((call) => firstTurnToolIds.has(call.toolCallId) && call.capability === "write"))
      return fail("early_mutation", "The archival turn mutated the workspace.", "runtime_policy");
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Fresh-request verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("artifact", "The fresh post-compaction requirement was not applied.", "semantic_goal");
    const artifact = input.workspace.final.entries.find((entry) => entry.path === TARGET_PATH);
    const control = input.workspace.final.entries.find((entry) => entry.path === CONTROL_PATH);
    if (artifact?.sha256 !== input.world.expectedHash)
      return fail("artifact_bytes", "The fresh requirement was not preserved exactly.", "format_contract");
    if (control?.sha256 !== input.world.controlHash)
      return fail("protected_state", "Protected state changed.", "runtime_policy");
    const secondTurnCompactions = input.turns[1] ? countCompactionEnds(input.turns[1].notifications) : 0;
    return secondTurnCompactions === 0
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "fresh_prompt.compaction_not_observed",
              message:
                "No second-turn compaction notification was captured; deterministic coverage owns lifecycle plumbing.",
            },
          ],
        }
      : { passed: true };
  },
};

async function createCompactingConfig(
  world: FreshPromptAfterCompactionWorld,
  profile: EvalProfile,
): Promise<RuntimeConfig> {
  const config = await createFixtureRuntimeConfig(world, profile);
  return { ...config, compaction: { enabled: true, reservePercent: 99.95, timeoutMs: 60_000 } };
}

function countCompactionEnds(notifications: RuntimeEvalExecution<unknown>["turns"][number]["notifications"]): number {
  return notifications.filter((notification) => {
    if (notification.method !== "agent/event" || !isRecord(notification.params)) return false;
    return isRecord(notification.params.event) && notification.params.event.type === "compaction_end";
  }).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `fresh_prompt.${code}`, message, dimension };
}
