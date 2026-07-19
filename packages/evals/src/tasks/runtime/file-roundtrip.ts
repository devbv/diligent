// @summary Runtime eval for a seeded index-grounded semantic update among decoy records

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@diligent/core/message-contract";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeVerifierResult } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

const INDEX_PATH = "records/index.json";
const RECORD_IDS = ["record-amber", "record-cobalt", "record-jade"] as const;

export interface FileRoundtripRecord {
  id: string;
  path: string;
  owner: string;
  initialStatus: string;
  content: string;
  hash: string;
}

export interface FileRoundtripWorld extends RuntimeFixtureWorld {
  indexPath: string;
  indexContent: string;
  indexHash: string;
  recordPaths: string[];
  records: FileRoundtripRecord[];
  selectedRecordId: string;
  selectedPath: string;
  pendingStatus: string;
  clientPrompt: string;
}

export const fileRoundtripTask: RuntimeEvalTask<FileRoundtripWorld> = {
  id: "file-roundtrip",
  description: "Use a seeded index to select and semantically update exactly one record among decoys.",
  fixtureVersion: "file-roundtrip-v1",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 6,
    maxToolCalls: 5,
    maxChangedFiles: 1,
    maxChangedBytes: 1_024,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "apply_patch", "edit"],
    allowedCapabilities: ["read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const fixture = fixtureFor(seed);
    await writeFixture(root, {
      [fixture.indexPath]: fixture.indexContent,
      ...Object.fromEntries(fixture.records.map((record) => [record.path, record.content])),
    });
    return {
      root,
      seed,
      expected: `UPDATED=${fixture.selectedRecordId}`,
      protectedPaths: [
        fixture.indexPath,
        ...fixture.records.filter((record) => record.path !== fixture.selectedPath).map((record) => record.path),
      ],
      allowedChanges: [fixture.selectedPath],
      ...fixture,
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  verify: verifySelectedRecord,
  snapshotWorld: async (world) => ({
    selected: await exactFile(world.root, world.selectedPath),
    protected: await Promise.all(
      world.protectedPaths.map(async (path) => ({ path, content: await exactFile(world.root, path) })),
    ),
  }),
  evaluate(input) {
    const failure = validateTrace(input) ?? validateWorkspaceAndVerifier(input) ?? validateFinal(input);
    if (failure) return failure;
    if (input.toolCalls.some((trace) => trace.outcome !== "success")) {
      return {
        passed: true,
        diagnostics: [
          {
            dimension: "efficiency",
            code: "file_roundtrip.safe_read_recovery",
            message: "One bounded read inside the records fixture failed before successful completion.",
          },
        ],
      };
    }
    return { passed: true };
  },
};

function fixtureFor(seed: string) {
  const selectedIndex = Number.parseInt(sha256Text(seed).slice(0, 8), 16) % RECORD_IDS.length;
  const selectedRecordId = RECORD_IDS[selectedIndex]!;
  const pendingStatus = seededToken(seed, "PENDING_STATUS");
  const records = RECORD_IDS.map((id, index) => {
    const record = {
      record: id,
      owner: seededToken(seed, `OWNER_${index}`),
      status: seededToken(seed, `INITIAL_STATUS_${index}`),
    };
    const content = `${JSON.stringify(record, null, 2)}\n`;
    return {
      id,
      path: `records/${id}.json`,
      owner: record.owner,
      initialStatus: record.status,
      content,
      hash: sha256Text(content),
    };
  });
  const indexContent = `${JSON.stringify({ active_record: selectedRecordId, pending_status: pendingStatus }, null, 2)}\n`;
  return {
    indexPath: INDEX_PATH,
    indexContent,
    indexHash: sha256Text(indexContent),
    recordPaths: records.map((record) => record.path),
    records,
    selectedRecordId,
    selectedPath: `records/${selectedRecordId}.json`,
    pendingStatus,
    clientPrompt:
      "Review records/index.json to determine which record is active and which pending status applies. Update only the referenced record so its status matches the pending status while preserving its record and owner fields. Leave every other file unchanged. Reply with only UPDATED=<active record id>.",
  };
}

async function verifySelectedRecord(world: FileRoundtripWorld): Promise<RuntimeVerifierResult> {
  const started = performance.now();
  let valid = true;
  let stderr = "";
  try {
    const selected = world.records.find((record) => record.path === world.selectedPath);
    if (!selected) throw new Error("Selected record fixture is missing.");
    const parsed: unknown = JSON.parse(await readFile(join(world.root, world.selectedPath), "utf8"));
    valid = isExactRecord(parsed, selected.id, selected.owner, world.pendingStatus);
    for (const path of world.protectedPaths) {
      const expected =
        path === world.indexPath ? world.indexContent : world.records.find((record) => record.path === path)?.content;
      if (expected === undefined || (await readFile(join(world.root, path), "utf8")) !== expected) {
        valid = false;
      }
    }
    if (!valid) stderr = "Selected semantics or protected fixture bytes diverged.";
  } catch (error) {
    valid = false;
    stderr = error instanceof Error ? error.message : String(error);
  }
  return {
    argv: ["verify-selected-record", world.selectedPath],
    exitCode: valid ? 0 : 1,
    elapsedMs: Math.round(performance.now() - started),
    stdout: valid ? "selected record semantics matched" : "",
    stderr,
    timedOut: false,
  };
}

function validateTrace(input: RuntimeEvalExecution<FileRoundtripWorld>) {
  const traces = input.toolCalls;
  const failed = traces.filter((trace) => trace.outcome !== "success");
  if (
    traces.length < 3 ||
    traces.length > fileRoundtripTask.limits.maxToolCalls ||
    traces.some((trace, index) => trace.sequence !== index + 1) ||
    traces.some((trace) => !["read", "apply_patch", "edit"].includes(trace.name)) ||
    failed.length > 1 ||
    (failed.length === 1 && !isBoundedSafeReadRecovery(traces))
  )
    return fail(
      "recovery",
      "Only one bounded failed read inside the records fixture is accepted as recovery.",
      "runtime_policy",
    );

  const successfulWrites = traces.filter((trace) => trace.outcome === "success" && trace.capability === "write");
  const firstWriteIndex = traces.indexOf(successfulWrites[0]!);
  if (
    successfulWrites.length === 0 ||
    successfulWrites.some((trace) => !writeTargetsOnly(trace, input.world.selectedPath))
  )
    return fail("mutation", "Every successful mutation must target only the index-selected record.", "runtime_policy");

  const successfulReads = traces
    .map((trace, index) => ({ trace, index }))
    .filter(({ trace }) => trace.outcome === "success" && trace.name === "read");
  const allowedReadPaths = new Set(
    [input.world.indexPath, ...input.world.recordPaths].map((path) => workspacePath(path)),
  );
  if (
    successfulReads.some(({ trace }) => !isRecord(trace.input) || !allowedReadPaths.has(String(trace.input.file_path)))
  )
    return fail("read_scope", "A successful read escaped the seeded index and record fixture.", "runtime_policy");
  const indexRead = successfulReads.find(
    ({ trace, index }) => index < firstWriteIndex && isExactReadPath(trace.input, workspacePath(input.world.indexPath)),
  );
  const targetRead = successfulReads.find(
    ({ trace, index }) =>
      index < firstWriteIndex && isExactReadPath(trace.input, workspacePath(input.world.selectedPath)),
  );
  const selected = input.world.records.find((record) => record.path === input.world.selectedPath);
  if (
    !indexRead ||
    !targetRead ||
    !selected ||
    !outputContains(indexRead.trace.output, input.world.selectedRecordId, input.world.pendingStatus) ||
    !outputContains(targetRead.trace.output, selected.id, selected.owner, selected.initialStatus)
  )
    return fail(
      "grounding",
      "The successful mutation was not grounded in the selected index and target record evidence.",
      "behavior",
    );
}

function validateWorkspaceAndVerifier(input: RuntimeEvalExecution<FileRoundtripWorld>) {
  const selected = input.workspace.final.entries.find((entry) => entry.path === input.world.selectedPath);
  if (input.verifier?.timedOut)
    return fail("verifier_timeout", "The deterministic selected-record verifier timed out.", "harness_terminal");
  if (selected?.kind !== "file" || input.verifier?.exitCode !== 0)
    return fail("semantic_result", "The deterministic selected-record verifier did not pass.", "semantic_goal");
  for (const path of input.world.protectedPaths) {
    const initial = input.workspace.initial.entries.find((entry) => entry.path === path);
    const final = input.workspace.final.entries.find((entry) => entry.path === path);
    if (JSON.stringify(initial) !== JSON.stringify(final))
      return fail(
        "isolation",
        "An index or decoy record changed outside the selected mutation boundary.",
        "runtime_policy",
      );
  }
  if (
    input.runtimeState.diff.some((change) => !["infrastructure", "sessions"].includes(change.category)) ||
    input.childSessions.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.userInputRequests.length !== 0
  )
    return fail(
      "isolation",
      "Undeclared runtime state, child, compaction, action, or input evidence appeared.",
      "runtime_policy",
    );
}

function validateFinal(input: RuntimeEvalExecution<FileRoundtripWorld>) {
  const actual = lastAssistantText(input.turns[0]?.messages ?? []);
  if (actual === input.world.expected) return undefined;
  return fail(
    "answer",
    "The final answer did not identify only the index-selected record.",
    actual.trim() === input.world.expected ? "format_contract" : "semantic_goal",
  );
}

function isBoundedSafeReadRecovery(traces: RuntimeEvalExecution<FileRoundtripWorld>["toolCalls"]): boolean {
  const failedIndex = traces.findIndex((trace) => trace.outcome !== "success");
  const failed = traces[failedIndex];
  const firstWriteIndex = traces.findIndex((trace) => trace.outcome === "success" && trace.capability === "write");
  return (
    failedIndex >= 0 &&
    failedIndex < firstWriteIndex &&
    failed?.name === "read" &&
    failed.capability === "read" &&
    failed.outcome === "runtime_error" &&
    isSafeRecordsReadInput(failed.input)
  );
}

function isSafeRecordsReadInput(input: unknown): boolean {
  if (!isRecord(input) || Object.keys(input).some((key) => !["file_path", "limit", "offset"].includes(key)))
    return false;
  const path = input.file_path;
  if (
    typeof path !== "string" ||
    path.split("/").includes("..") ||
    (input.offset !== undefined &&
      (typeof input.offset !== "number" || !Number.isInteger(input.offset) || input.offset < 1)) ||
    (input.limit !== undefined &&
      (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1))
  )
    return false;
  return (
    path === "records" ||
    path.startsWith("records/") ||
    path === "$WORKSPACE/records" ||
    path.startsWith("$WORKSPACE/records/")
  );
}

function writeTargetsOnly(
  trace: RuntimeEvalExecution<FileRoundtripWorld>["toolCalls"][number],
  selectedPath: string,
): boolean {
  if (!isRecord(trace.input)) return false;
  if (trace.name === "edit") return trace.input.file_path === workspacePath(selectedPath);
  if (trace.name !== "apply_patch" || typeof trace.input.patch !== "string") return false;
  const headers = [...trace.input.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
    (match) => match[1],
  );
  return headers.length === 1 && headers[0] === relativePath(selectedPath);
}

function isExactReadPath(input: unknown, path: string): boolean {
  return isRecord(input) && Object.keys(input).length === 1 && input.file_path === path;
}

function outputContains(output: unknown, ...values: string[]): boolean {
  const text = JSON.stringify(output);
  return values.every((value) => text.includes(value));
}

function isExactRecord(value: unknown, id: string, owner: string, status: string): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") === "owner,record,status" &&
    value.record === id &&
    value.owner === owner &&
    value.status === status
  );
}

function relativePath(path: string, root = "$WORKSPACE"): string {
  const prefix = `${root}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path.startsWith("$WORKSPACE/") ? path.slice("$WORKSPACE/".length) : path;
}

function workspacePath(path: string): string {
  return path.startsWith("$WORKSPACE/") ? path : `$WORKSPACE/${path}`;
}

function lastAssistantText(messages: Message[]): string {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  if (!last || last.role !== "assistant") return "";
  return last.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `file_roundtrip.${code}`, message, dimension };
}
