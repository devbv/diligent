// @summary Runtime eval for separating a durable preference from transient current-task intent

import { join } from "node:path";
import { readKnowledge } from "@diligent/runtime";
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

const OUTPUT_PATH = "CURRENT.txt";
const SEEDED_TIMESTAMP = "2026-07-18T00:00:00.000Z";

export interface KnowledgeIntentSplitWorld extends RuntimeFixtureWorld {
  knowledgeId: string;
  durableValue: string;
  transientValue: string;
  content: string;
  tags: string[];
  expectedHash: string;
}

export const knowledgeIntentSplitTask: RuntimeEvalTask<KnowledgeIntentSplitWorld> = {
  id: "knowledge-intent-split",
  description: "Persist one durable preference while keeping unrelated current-task intent out of knowledge.",
  fixtureVersion: "knowledge-intent-split-v4",
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
    const knowledgeId = "preference.review-audience";
    const durableValue = seededToken(seed, "AUDIENCE");
    const transientValue = seededToken(seed, "CURRENT");
    const content = `Preferred review audience is ${durableValue}.`;
    const tags = ["review", "audience"];
    const expected = `${transientValue}\n`;
    await writeFixture(root, {
      ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify({
        id: knowledgeId,
        timestamp: SEEDED_TIMESTAMP,
        type: "preference",
        content: "Preferred review audience is OLD_AUDIENCE.",
        confidence: 0.7,
        tags,
      })}\n`,
    });
    return {
      root,
      seed,
      knowledgeId,
      durableValue,
      transientValue,
      content,
      tags,
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
      message: `For future sessions, please remember that my preferred review audience is ${world.durableValue}, using the stable preference key ${world.knowledgeId}. Separately, for this task only, create ${OUTPUT_PATH} containing exactly ${world.transientValue} and one trailing newline.`,
    },
  ],
  verify: verifyIntentSplit,
  snapshotWorld: async (world) => ({
    entries: await readKnowledge(join(world.root, ".diligent/knowledge")),
    output: await exactFile(world.root, OUTPUT_PATH),
  }),
  evaluate(input) {
    const searches = input.toolCalls.filter((call) => call.name === "search_knowledge");
    const updates = input.toolCalls.filter((call) => call.name === "update_knowledge");
    const writes = input.toolCalls.filter((call) => call.capability === "write");
    const hasCreateRecovery = writes.length === 2;
    if (
      input.toolCalls.length > knowledgeIntentSplitTask.limits.maxToolCalls ||
      searches.length > 2 ||
      updates.length !== 1 ||
      (writes.length !== 1 && !hasCreateRecovery) ||
      input.toolCalls.length !== searches.length + updates.length + writes.length
    )
      return fail(
        "trace_count",
        "Expected up to two searches, one update, and one bounded workspace create path.",
        "runtime_policy",
      );
    const update = updates[0]!;
    const write = writes.at(-1)!;
    if (
      searches.some(
        (search) =>
          search.capability !== "knowledge" ||
          search.outcome !== "success" ||
          !isSafeOptionalSearch(search.input, input.world),
      )
    )
      return fail("search", "An optional search was not a safe durable-preference lookup.", "runtime_policy");
    if (
      update.name !== "update_knowledge" ||
      update.capability !== "knowledge" ||
      update.outcome !== "success" ||
      !isExactDurableUpsert(update.input, input.world)
    )
      return fail("update", "The update was not the exact successful durable preference upsert.", "runtime_policy");
    if (hasCreateRecovery && !isExactAnthropicCreateRecovery(input, update, searches, writes))
      return fail(
        "write_recovery",
        "The failed workspace create was not the exact bounded Anthropic path recovery.",
        "runtime_policy",
      );
    if (
      write?.capability !== "write" ||
      write.outcome !== "success" ||
      !isProviderNativeExactCreate(input, write, OUTPUT_PATH, input.world.expected)
    )
      return fail(
        "write",
        "The final trace was not the provider-native exact workspace creation.",
        writeTargetsPath(write, OUTPUT_PATH) ? "format_contract" : "runtime_policy",
      );
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent knowledge-store and output verification failed.", "runtime_policy");
    const output = input.workspace.final.entries.find((entry) => entry.path === OUTPUT_PATH);
    if (output?.sha256 !== input.world.expectedHash)
      return fail("output_hash", `${OUTPUT_PATH} did not have the exact final hash.`, "format_contract");
    return searches.length === 2
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "knowledge_intent_split.second_safe_search",
              message: "A second bounded read-only knowledge search was used before successful completion.",
            },
          ],
        }
      : { passed: true };
  },
};

async function createKnowledgeRuntimeConfig(world: KnowledgeIntentSplitWorld, profile: EvalProfile) {
  const config = await createFixtureRuntimeConfig(world, profile);
  return {
    ...config,
    diligent: { ...config.diligent, knowledge: { enabled: true, injectionBudget: 1024, maxItems: 5 } },
  };
}

async function verifyIntentSplit(
  world: KnowledgeIntentSplitWorld,
  signal: AbortSignal,
): Promise<RuntimeVerifierResult> {
  const started = performance.now();
  const entries = await readKnowledge(join(world.root, ".diligent/knowledge"));
  const output = await exactFile(world.root, OUTPUT_PATH);
  const entry = entries[0];
  const storeText = JSON.stringify(entries);
  const validEntry =
    entries.length === 1 &&
    entry !== undefined &&
    sameKeys(entry, ["confidence", "content", "id", "tags", "timestamp", "type"]) &&
    entry.id === world.knowledgeId &&
    entry.type === "preference" &&
    entry.content === world.content &&
    entry.confidence === 0.7 &&
    Array.isArray(entry.tags) &&
    entry.tags.every((tag) => typeof tag === "string") &&
    entry.timestamp !== SEEDED_TIMESTAMP &&
    Number.isFinite(Date.parse(entry.timestamp));
  const valid = !signal.aborted && validEntry && !storeText.includes(world.transientValue) && output === world.expected;
  return verifierResult(
    started,
    valid,
    signal.aborted,
    valid ? JSON.stringify({ entry, outputHash: world.expectedHash }) : JSON.stringify({ entries, output }),
    "Knowledge intent split did not match the exact final store and project output.",
  );
}

function isProviderNativeExactCreate(
  execution: RuntimeEvalExecution<unknown>,
  call: RuntimeEvalExecution<unknown>["toolCalls"][number],
  path: string,
  content: string,
): boolean {
  if (execution.profile.provider === "openai")
    return call.name === "apply_patch" && matchesExactPatchInput(call.input, exactAddPatch(path, content));
  if (execution.profile.provider === "anthropic")
    return (
      exactObject(call.input, {
        file_path: `$WORKSPACE/${path}`,
        old_string: "",
        new_string: content,
        replace_all: false,
      }) && call.name === "edit"
    );
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
  execution: RuntimeEvalExecution<KnowledgeIntentSplitWorld>,
  update: RuntimeEvalExecution<KnowledgeIntentSplitWorld>["toolCalls"][number],
  searches: RuntimeEvalExecution<KnowledgeIntentSplitWorld>["toolCalls"],
  writes: RuntimeEvalExecution<KnowledgeIntentSplitWorld>["toolCalls"],
): boolean {
  if (execution.profile.provider !== "anthropic" || writes.length !== 2) return false;
  const [recovery, write] = writes;
  if (!recovery || !write) return false;
  const error = `Error: file_path must be absolute: ${OUTPUT_PATH}`;
  const parentThreadId = recovery.threadId;
  return (
    execution.toolCalls.at(-2) === recovery &&
    execution.toolCalls.at(-1) === write &&
    execution.toolCalls.slice(0, -2).every((call) => call === update || searches.includes(call)) &&
    execution.toolCalls.every((call, index) => call.sequence === index + 1) &&
    typeof parentThreadId === "string" &&
    parentThreadId.length > 0 &&
    execution.toolCalls.every((call) => call.threadId === parentThreadId && call.childThreadId === undefined) &&
    recovery.name === "edit" &&
    recovery.capability === "write" &&
    recovery.outcome === "runtime_error" &&
    recovery.error === error &&
    exactObject(recovery.input, {
      file_path: OUTPUT_PATH,
      old_string: "",
      new_string: execution.world.expected,
      replace_all: false,
    }) &&
    exactObject(recovery.output, { output: error, metadata: { error: true } }) &&
    write.sequence === recovery.sequence + 1
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
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => JSON.stringify(value[key]) === JSON.stringify(expected[key]))
  );
}

function isExactDurableUpsert(value: unknown, world: KnowledgeIntentSplitWorld): boolean {
  if (!isRecord(value)) return false;
  const allowedKeys = ["action", "content", "id", "tags", "type"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return false;
  if (
    value.action !== "upsert" ||
    value.id !== world.knowledgeId ||
    value.type !== "preference" ||
    value.content !== world.content
  )
    return false;
  return (
    value.tags === undefined ||
    (Array.isArray(value.tags) &&
      value.tags.every((tag) => typeof tag === "string") &&
      !JSON.stringify(value.tags).includes(world.transientValue))
  );
}

function isSafeOptionalSearch(value: unknown, world: KnowledgeIntentSplitWorld): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length >= 1 &&
    keys.length <= 2 &&
    keys.every((key) => key === "id" || key === "id_prefix" || key === "query") &&
    (value.id !== undefined || value.id_prefix !== undefined || value.query !== undefined) &&
    (value.id === undefined || value.id === world.knowledgeId) &&
    (value.id_prefix === undefined || value.id_prefix === world.knowledgeId) &&
    (value.query === undefined ||
      (typeof value.query === "string" && value.query.trim().length > 0 && !value.query.includes(world.transientValue)))
  );
}

function sameKeys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verifierResult(
  started: number,
  valid: boolean,
  timedOut: boolean,
  stdout: string,
  error: string,
): RuntimeVerifierResult {
  return {
    argv: ["knowledge-intent-split-verifier"],
    exitCode: valid ? 0 : 1,
    elapsedMs: Math.round(performance.now() - started),
    stdout: valid ? stdout : "",
    stderr: valid ? "" : error,
    timedOut,
  };
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `knowledge_intent_split.${code}`, message, dimension };
}
