// @summary Runtime eval for deleting one durable preference while completing an independent workspace task

import { join } from "node:path";
import { type KnowledgeEntry, readKnowledge } from "@diligent/runtime";
import type {
  RuntimeEvalExecution,
  RuntimeEvalTask,
  RuntimeToolTrace,
  RuntimeVerifierResult,
} from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  matchesExactPatchInput,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

const OUTPUT_PATH = "FORGET.txt";

export interface KnowledgeForgetWorld extends RuntimeFixtureWorld {
  knowledgeId: string;
  forgottenValue: string;
  targetContent: string;
  taskValue: string;
  controlEntry: KnowledgeEntry;
  expectedHash: string;
}

export const knowledgeForgetTask: RuntimeEvalTask<KnowledgeForgetWorld> = {
  id: "knowledge-forget",
  description: "Delete one durable preference while completing an unrelated exact workspace task.",
  fixtureVersion: "knowledge-forget-v6",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 5, maxToolCalls: 5, timeoutMs: 180_000 },
  statePolicy: {
    allowedMutations: ["infrastructure", "sessions", "knowledge"],
    requiredMutations: ["knowledge"],
  },
  toolPolicy: {
    allowedTools: ["search_knowledge", "update_knowledge", "apply_patch", "edit"],
    allowedCapabilities: ["knowledge", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const knowledgeId = "preference.deploy-window";
    const forgottenValue = seededToken(seed, "WINDOW");
    const targetContent = `Preferred deployment window is ${forgottenValue}.`;
    const taskValue = seededToken(seed, "FORGET_TASK");
    const controlEntry: KnowledgeEntry = {
      id: "preference.control-format",
      timestamp: "2026-07-18T00:01:00.000Z",
      type: "preference",
      content: `Preferred control format is ${seededToken(seed, "CONTROL")}.`,
      confidence: 0.9,
      tags: ["control", "format"],
    };
    const targetEntry: KnowledgeEntry = {
      id: knowledgeId,
      timestamp: "2026-07-18T00:00:00.000Z",
      type: "preference",
      content: targetContent,
      confidence: 0.8,
      tags: ["deployment", "window"],
    };
    const expected = `${taskValue}\n`;
    await writeFixture(root, {
      ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(targetEntry)}\n${JSON.stringify(controlEntry)}\n`,
    });
    return {
      root,
      seed,
      knowledgeId,
      forgottenValue,
      targetContent,
      taskValue,
      controlEntry,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [],
      allowedChanges: [OUTPUT_PATH],
    };
  },
  createRuntimeConfig: createKnowledgeRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `Please forget my saved deployment-window preference at stable key ${world.knowledgeId}. Separately, create ${OUTPUT_PATH} containing exactly ${world.taskValue} and one trailing newline for this task.`,
    },
  ],
  verify: verifyForgottenKnowledge,
  snapshotWorld: async (world) => ({
    entries: await readKnowledge(join(world.root, ".diligent/knowledge")),
    output: await exactFile(world.root, OUTPUT_PATH),
  }),
  evaluate(input) {
    const searches = input.toolCalls.filter((call) => call.name === "search_knowledge");
    const deletions = input.toolCalls.filter((call) => call.name === "update_knowledge");
    const writes = input.toolCalls.filter((call) => call.capability === "write");
    const hasCreateRecovery = writes.length === 2;
    if (
      searches.length > 2 ||
      deletions.length !== 1 ||
      (writes.length !== 1 && !hasCreateRecovery) ||
      input.toolCalls.length !== searches.length + deletions.length + writes.length
    )
      return fail(
        "trace_count",
        "Expected at most two searches, one delete, and one workspace write.",
        "runtime_policy",
      );
    const deletion = deletions[0]!;
    const write = writes.at(-1)!;
    const preDeleteSearches = searches.filter((search) => search.sequence < deletion.sequence);
    const postDeleteSearches = searches.filter((search) => search.sequence > deletion.sequence);
    if (
      preDeleteSearches.some(
        (search) =>
          search.capability !== "knowledge" || search.outcome !== "success" || !isSafeSearch(search.input, input.world),
      )
    )
      return fail(
        "search",
        "Every bounded pre-delete search must be successful and exclude transient task intent.",
        "runtime_policy",
      );
    if (
      preDeleteSearches.length + postDeleteSearches.length !== searches.length ||
      postDeleteSearches.length > 1 ||
      (postDeleteSearches[0] !== undefined &&
        !isExactPostDeleteAbsenceConfirmation(input, deletion, write, postDeleteSearches[0]))
    )
      return fail(
        "confirmation",
        "The optional post-delete search did not prove bounded absence of the target entry.",
        "runtime_policy",
      );
    if (
      deletion.name !== "update_knowledge" ||
      deletion.capability !== "knowledge" ||
      deletion.outcome !== "success" ||
      !exactObject(deletion.input, { action: "delete", id: input.world.knowledgeId })
    )
      return fail("delete", "The update trace was not the exact successful knowledge deletion.", "runtime_policy");
    if (hasCreateRecovery && !isExactAnthropicCreateRecovery(input, writes))
      return fail(
        "write_recovery",
        "The failed workspace create was not the exact bounded Anthropic path recovery.",
        "runtime_policy",
      );
    if (
      write?.capability !== "write" ||
      write.outcome !== "success" ||
      !isProviderNativeExactCreate(write, OUTPUT_PATH, input.world.expected)
    )
      return fail(
        "write",
        "The write trace was not the provider-native exact workspace creation.",
        writeTargetsPath(write, OUTPUT_PATH) ? "format_contract" : "runtime_policy",
      );
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent knowledge-store and output verification failed.", "runtime_policy");
    const output = input.workspace.final.entries.find((entry) => entry.path === OUTPUT_PATH);
    return output?.sha256 === input.world.expectedHash
      ? postDeleteSearches.length === 1
        ? {
            passed: true,
            diagnostics: [
              {
                dimension: "efficiency" as const,
                code: "knowledge_forget.confirmation_search",
                message: "A bounded post-delete absence confirmation was used before completion.",
              },
            ],
          }
        : { passed: true }
      : fail("output_hash", `${OUTPUT_PATH} did not have the exact final hash.`, "format_contract");
  },
};

async function createKnowledgeRuntimeConfig(world: KnowledgeForgetWorld, profile: EvalProfile) {
  const config = await createFixtureRuntimeConfig(world, profile);
  return {
    ...config,
    diligent: { ...config.diligent, knowledge: { enabled: true, injectionBudget: 1024, maxItems: 5 } },
  };
}

async function verifyForgottenKnowledge(
  world: KnowledgeForgetWorld,
  signal: AbortSignal,
): Promise<RuntimeVerifierResult> {
  const started = performance.now();
  const entries = await readKnowledge(join(world.root, ".diligent/knowledge"));
  const output = await exactFile(world.root, OUTPUT_PATH);
  const storeText = JSON.stringify(entries);
  const validStore =
    entries.length === 1 &&
    JSON.stringify(entries[0]) === JSON.stringify(world.controlEntry) &&
    !entries.some((entry) => entry.id === world.knowledgeId) &&
    !storeText.includes(world.targetContent) &&
    !storeText.includes(world.forgottenValue);
  const valid = !signal.aborted && validStore && output === world.expected;
  return {
    argv: ["knowledge-forget-verifier"],
    exitCode: valid ? 0 : 1,
    elapsedMs: Math.round(performance.now() - started),
    stdout: valid ? JSON.stringify({ entries, outputHash: world.expectedHash }) : "",
    stderr: valid ? "" : "Forgotten knowledge or independent project output did not match the exact final state.",
    timedOut: signal.aborted,
  };
}

function isProviderNativeExactCreate(
  call: RuntimeEvalExecution<unknown>["toolCalls"][number],
  path: string,
  content: string,
): boolean {
  if (call.name === "apply_patch") return matchesExactPatchInput(call.input, exactAddPatch(path, content));
  if (call.name === "edit")
    return exactObject(call.input, {
      file_path: `$WORKSPACE/${path}`,
      old_string: "",
      new_string: content,
      replace_all: false,
    });
  return false;
}

function writeTargetsPath(call: RuntimeToolTrace | undefined, path: string): boolean {
  if (!call || !isRecord(call.input)) return false;
  if (call.name === "edit") return call.input.file_path === `$WORKSPACE/${path}`;
  return (
    call.name === "apply_patch" && typeof call.input.patch === "string" && call.input.patch.includes(` File: ${path}`)
  );
}

function isExactAnthropicCreateRecovery(
  execution: RuntimeEvalExecution<KnowledgeForgetWorld>,
  writes: RuntimeEvalExecution<KnowledgeForgetWorld>["toolCalls"],
): boolean {
  if (execution.profile.provider !== "anthropic" || writes.length !== 2) return false;
  const [failed, retry] = writes;
  if (!failed || !retry) return false;
  const error = `Error: file_path must be absolute: ${OUTPUT_PATH}`;
  const failedIndex = execution.toolCalls.indexOf(failed);
  const retryIndex = execution.toolCalls.indexOf(retry);
  return (
    failedIndex >= 0 &&
    retryIndex === failedIndex + 1 &&
    retry.sequence === failed.sequence + 1 &&
    typeof failed.threadId === "string" &&
    failed.threadId.length > 0 &&
    retry.threadId === failed.threadId &&
    failed.childThreadId === undefined &&
    retry.childThreadId === undefined &&
    failed.name === "edit" &&
    failed.capability === "write" &&
    failed.outcome === "runtime_error" &&
    failed.error === error &&
    exactObject(failed.input, {
      file_path: OUTPUT_PATH,
      old_string: "",
      new_string: execution.world.expected,
      replace_all: false,
    }) &&
    exactObject(failed.output, { output: error, metadata: { error: true } })
  );
}

function exactAddPatch(path: string, content: string): string {
  return `*** Begin Patch\n*** Add File: ${path}\n${content
    .split("\n")
    .slice(0, -1)
    .map((line) => `+${line}`)
    .join("\n")}\n*** End Patch`;
}

function exactObject(value: unknown, expected: Record<string, unknown>): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => JSON.stringify(record[key]) === JSON.stringify(expected[key]))
  );
}

function isSafeSearch(value: unknown, world: KnowledgeForgetWorld): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length >= 1 &&
    keys.length <= 2 &&
    keys.every((key) => key === "id" || key === "query") &&
    (record.id !== undefined || record.query !== undefined) &&
    (record.id === undefined || record.id === world.knowledgeId) &&
    (record.query === undefined ||
      (typeof record.query === "string" && record.query.trim().length > 0 && !record.query.includes(world.taskValue)))
  );
}

function isExactPostDeleteAbsenceConfirmation(
  execution: RuntimeEvalExecution<KnowledgeForgetWorld>,
  deletion: RuntimeEvalExecution<KnowledgeForgetWorld>["toolCalls"][number],
  write: RuntimeEvalExecution<KnowledgeForgetWorld>["toolCalls"][number],
  confirmation: RuntimeEvalExecution<KnowledgeForgetWorld>["toolCalls"][number],
): boolean {
  if (!isRecord(confirmation.input) || !exactKeys(confirmation.input, ["id_prefix", "query"])) return false;
  const { id_prefix: idPrefix, query } = confirmation.input;
  if (
    typeof idPrefix !== "string" ||
    idPrefix.length === 0 ||
    !execution.world.knowledgeId.startsWith(idPrefix) ||
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.includes(execution.world.taskValue)
  )
    return false;
  if (!isRecord(confirmation.output)) return false;
  const outputText = JSON.stringify(confirmation.output);
  const deletionIndex = execution.toolCalls.indexOf(deletion);
  const confirmationIndex = execution.toolCalls.indexOf(confirmation);
  return (
    confirmation.capability === "knowledge" &&
    confirmation.outcome === "success" &&
    confirmation.output.output === "No knowledge entries found" &&
    exactObject(confirmation.output.metadata, { matchCount: 0, ids: [] }) &&
    !outputText.includes(execution.world.targetContent) &&
    !outputText.includes(execution.world.forgottenValue) &&
    confirmation.sequence > deletion.sequence &&
    confirmationIndex > deletionIndex &&
    typeof confirmation.threadId === "string" &&
    confirmation.threadId.length > 0 &&
    confirmation.threadId === deletion.threadId &&
    confirmation.threadId === write.threadId &&
    confirmation.childThreadId === undefined
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.slice().sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `knowledge_forget.${code}`, message, dimension };
}
