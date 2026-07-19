// @summary Runtime eval for synchronous UserPromptSubmit context injection and exact model behavior

import type { BundledToolProvider, PluginHookFn } from "@diligent/runtime";
import type { RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

export interface HookContextFollowWorld extends RuntimeFixtureWorld {
  hookFact: string;
  injectedContext: string;
  clientPrompt: string;
  expectedHash: string;
}

const OUTPUT_PATH = "HOOK.txt";

export const hookContextFollowTask: RuntimeEvalTask<HookContextFollowWorld> = {
  id: "hook-context-follow",
  description: "Follow a seeded fact injected by a fixture-owned synchronous UserPromptSubmit hook.",
  fixtureVersion: "hook-context-follow-v2",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 4, maxToolCalls: 2, timeoutMs: 180_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const hookFact = seededToken(seed, "HOOK_FACT");
    const injectedContext = `HOOK_VALUE=${hookFact}`;
    const clientPrompt =
      "Use the additional context supplied for this submission to create HOOK.txt containing only its value and one trailing newline.";
    const expected = `${hookFact}\n`;
    await writeFixture(root, { ".git/.keep": "fixture boundary\n" });
    return {
      root,
      seed,
      hookFact,
      injectedContext,
      clientPrompt,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [".git/.keep"],
      allowedChanges: [OUTPUT_PATH],
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createBundledToolProviders(world): readonly BundledToolProvider[] {
    const hook: PluginHookFn = async () => ({ blocked: false, additionalContext: world.injectedContext });
    hook.mode = "sync";
    return [{ id: "eval-user-prompt-hook", createTools: () => [], onUserPromptSubmit: hook }];
  },
  createSteps: (world) => [{ kind: "turn", mode: "execute", message: world.clientPrompt }],
  verify: (world, signal) => verifyExactFiles(world, { [OUTPUT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({ result: await exactFile(world.root, OUTPUT_PATH) }),
  evaluate(input) {
    const successfulWrites = input.toolCalls.filter(
      (call) => call.capability === "write" && call.outcome === "success",
    );
    if (
      successfulWrites.length !== 1 ||
      input.toolCalls.some(
        (call) => call.capability !== "write" || (call.outcome !== "success" && call.outcome !== "runtime_error"),
      )
    )
      return fail(
        "tool_scope",
        "The model must stay within declared writes and produce exactly one successful write.",
        "runtime_policy",
      );
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent exact-file verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent exact-file verification failed.", "format_contract");
    const output = input.workspace.final.entries.find((entry) => entry.path === OUTPUT_PATH);
    return output?.sha256 === input.world.expectedHash
      ? { passed: true }
      : fail("output", "HOOK.txt did not contain the exact injected fact.", "format_contract");
  },
};

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `hook_context_follow.${code}`, message, dimension };
}
