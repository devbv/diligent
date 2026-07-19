// @summary Construct-validity regressions for seeded evidence-based file-roundtrip selection

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamContext } from "@diligent/core/provider-contract";
import { DEFAULT_PROFILES } from "../../../src/profiles";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import { type FileRoundtripWorld, fileRoundtripTask } from "../../../src/tasks/runtime/file-roundtrip";
import { writeFixture } from "../../../src/tasks/runtime/helpers";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("file-roundtrip", () => {
  test("uses a representation-independent semantic verifier for the selected record", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-eval-file-selection-verifier-"));
    try {
      const world = await fileRoundtripTask.setup("shared-seed-123", root);
      const selected = world.records.find((record) => record.path === world.selectedPath)!;
      await writeFixture(root, {
        [world.selectedPath]: `${JSON.stringify({ status: world.pendingStatus, owner: selected.owner, record: selected.id })}\n`,
      });
      expect(await fileRoundtripTask.verify!(world, new AbortController().signal)).toMatchObject({
        argv: ["verify-selected-record", world.selectedPath],
        exitCode: 0,
        timedOut: false,
      });

      await writeFixture(root, {
        [world.selectedPath]: `${JSON.stringify({
          status: world.pendingStatus,
          owner: selected.owner,
          record: selected.id,
          extra: true,
        })}\n`,
      });
      expect((await fileRoundtripTask.verify!(world, new AbortController().signal)).exitCode).toBe(1);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("makes the seeded index decision and exact semantic update for both providers", async () => {
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(fileRoundtripTask.evaluate(execution)).toEqual({ passed: true });
      const writeIndex = execution.toolCalls.findIndex(
        (call) => call.outcome === "success" && call.capability === "write",
      );
      expect(execution.toolCalls.slice(writeIndex + 1).some((call) => call.name === "read")).toBe(false);
    }
  });

  test("accepts one provider-neutral index-path recovery and an extra safe record read", async () => {
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile, { relativeIndexRecovery: true, extraSafeRead: true });
      expect(fileRoundtripTask.evaluate(execution)).toEqual({
        passed: true,
        diagnostics: [
          {
            dimension: "efficiency",
            code: "file_roundtrip.safe_read_recovery",
            message: "One bounded read inside the records fixture failed before successful completion.",
          },
        ],
      });
      expect(execution.toolCalls).toHaveLength(5);
    }
  });

  test("accepts the preserved Anthropic failed records-directory read as one bounded safe recovery", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[1]!, { recordsDirectoryRecovery: true });

    expect(execution.toolCalls.map(({ name, outcome, input }) => ({ name, outcome, input }))).toEqual([
      {
        name: "read",
        outcome: "success",
        input: { file_path: "$WORKSPACE/records/index.json" },
      },
      {
        name: "read",
        outcome: "runtime_error",
        input: { file_path: "$WORKSPACE/records" },
      },
      {
        name: "read",
        outcome: "success",
        input: { file_path: `$WORKSPACE/${execution.world.selectedPath}` },
      },
      {
        name: "edit",
        outcome: "success",
        input: expect.objectContaining({ file_path: `$WORKSPACE/${execution.world.selectedPath}` }),
      },
    ]);
    expect(fileRoundtripTask.evaluate(execution)).toEqual({
      passed: true,
      diagnostics: [
        {
          dimension: "efficiency",
          code: "file_roundtrip.safe_read_recovery",
          message: "One bounded read inside the records fixture failed before successful completion.",
        },
      ],
    });

    const incidentalShape = structuredClone(execution);
    Object.assign(incidentalShape.toolCalls[1]!.input as Record<string, unknown>, { offset: 1, limit: 10 });
    incidentalShape.toolCalls[1]!.error = "Provider-neutral read failure wording";
    expect(fileRoundtripTask.evaluate(incidentalShape)).toEqual({
      passed: true,
      diagnostics: expect.any(Array),
    });
  });

  test("rejects wrong target, wrong content, extra mutation, unsafe recovery, and repeated failures", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    const world = baseline.world;
    const wrongTarget = structuredClone(baseline);
    const decoy = world.records.find((record) => record.path !== world.selectedPath)!;
    const write = wrongTarget.toolCalls.find((call) => call.capability === "write")!;
    write.input = rewriteWriteTarget(write.input, world.selectedPath, decoy.path);
    expect(fileRoundtripTask.evaluate(wrongTarget).passed).toBe(false);

    const wrongContent = structuredClone(baseline);
    wrongContent.verifier!.exitCode = 1;
    expect(fileRoundtripTask.evaluate(wrongContent).passed).toBe(false);

    const extraMutation = structuredClone(baseline);
    extraMutation.workspace.final.entries.find((entry) => entry.path === decoy.path)!.sha256 = "mutated-decoy";
    expect(fileRoundtripTask.evaluate(extraMutation).passed).toBe(false);

    const unsupportedRecovery = await assembledExecution(DEFAULT_PROFILES[1]!, { relativeIndexRecovery: true });
    (unsupportedRecovery.toolCalls[0]!.input as { file_path: string }).file_path = "private/unknown.json";
    expect(fileRoundtripTask.evaluate(unsupportedRecovery).passed).toBe(false);

    const unsafeRecovery = await assembledExecution(DEFAULT_PROFILES[1]!, { recordsDirectoryRecovery: true });
    (unsafeRecovery.toolCalls[1]!.input as { file_path: string }).file_path = "$WORKSPACE/private";
    expect(fileRoundtripTask.evaluate(unsafeRecovery).passed).toBe(false);

    const repeatedFailure = await assembledExecution(DEFAULT_PROFILES[1]!, { recordsDirectoryRecovery: true });
    const duplicateFailure = structuredClone(repeatedFailure.toolCalls[1]!);
    duplicateFailure.toolCallId = "second-failed-read";
    repeatedFailure.toolCalls.splice(2, 0, duplicateFailure);
    repeatedFailure.toolCalls.forEach((call, index) => {
      call.sequence = index + 1;
    });
    expect(fileRoundtripTask.evaluate(repeatedFailure).passed).toBe(false);

    const wrongIntermediateWrite = structuredClone(baseline);
    const successfulWrite = wrongIntermediateWrite.toolCalls.find((call) => call.capability === "write")!;
    const inserted = structuredClone(successfulWrite);
    inserted.toolCallId = "wrong-intermediate-write";
    inserted.input = rewriteWriteTarget(inserted.input, world.selectedPath, decoy.path);
    wrongIntermediateWrite.toolCalls.splice(successfulWrite.sequence - 1, 0, inserted);
    wrongIntermediateWrite.toolCalls.forEach((call, index) => {
      call.sequence = index + 1;
    });
    expect(fileRoundtripTask.evaluate(wrongIntermediateWrite).passed).toBe(false);
  });
});

async function assembledExecution(
  profile: EvalProfile,
  scenario: { relativeIndexRecovery?: boolean; recordsDirectoryRecovery?: boolean; extraSafeRead?: boolean } = {},
): Promise<RuntimeEvalExecution<FileRoundtripWorld>> {
  const seed = "shared-seed-123";
  let providerCall = 0;
  let activeId = "";
  let pendingStatus = "";
  let initialStatus = "";
  const result = await runRuntimeEvalExecution({
    task: fileRoundtripTask,
    profile,
    seed,
    streamFunction(_model, context, options) {
      const cwd = cwdFromContext(context);
      const call = providerCall++;
      const recoveryOffset = scenario.relativeIndexRecovery || scenario.recordsDirectoryRecovery ? 1 : 0;
      if (call === recoveryOffset + 1) {
        const evidence = JSON.stringify(context.messages).replaceAll("\\", "");
        activeId = requiredMatch(evidence, /"active_record"\s*:\s*"([^"]+)"/);
        pendingStatus = requiredMatch(evidence, /"pending_status"\s*:\s*"([^"]+)"/);
      }
      if (call === recoveryOffset + 2) {
        const evidence = JSON.stringify(context.messages).replaceAll("\\", "");
        initialStatus = requiredMatch(evidence, /"status"\s*:\s*"([^"]+)"/);
      }
      const writeCall = recoveryOffset + 2 + Number(scenario.extraSafeRead === true);
      const response =
        call === 0 && scenario.relativeIndexRecovery
          ? toolCall("file-index-relative", "read", { file_path: "records/index.json" })
          : call === 0 && scenario.recordsDirectoryRecovery
            ? toolCall("file-index", "read", { file_path: join(cwd, "records/index.json") })
            : call === 1 && scenario.recordsDirectoryRecovery
              ? toolCall("file-records-directory", "read", { file_path: join(cwd, "records") })
              : call === recoveryOffset
                ? toolCall("file-index", "read", { file_path: join(cwd, "records/index.json") })
                : call === recoveryOffset + 1
                  ? toolCall("file-target", "read", { file_path: join(cwd, `records/${activeId}.json`) })
                  : scenario.extraSafeRead && call === recoveryOffset + 2
                    ? toolCall("file-decoy", "read", {
                        file_path: join(
                          cwd,
                          `records/${activeId === "record-amber" ? "record-cobalt" : "record-amber"}.json`,
                        ),
                      })
                    : call === writeCall
                      ? profile.provider === "anthropic"
                        ? toolCall("file-write", "edit", {
                            file_path: join(cwd, `records/${activeId}.json`),
                            old_string: `  "status": "${initialStatus}"`,
                            new_string: `  "status": "${pendingStatus}"`,
                            replace_all: false,
                          })
                        : toolCall("file-write", "apply_patch", {
                            patch:
                              `*** Begin Patch\n*** Update File: records/${activeId}.json\n@@\n` +
                              `-  "status": "${initialStatus}"\n+  "status": "${pendingStatus}"\n*** End Patch`,
                          })
                      : assistantMessage([{ type: "text", text: `UPDATED=${activeId}` }]);
      return sequenceStream([response])(_model, context, options);
    },
  });
  expect(
    result.failures,
    JSON.stringify({ failures: result.failures, events: result.execution.turns[0]?.coreEvents }),
  ).toEqual([]);
  if (scenario.relativeIndexRecovery || scenario.recordsDirectoryRecovery) {
    expect(result.diagnostics).toEqual([
      {
        dimension: "efficiency",
        code: "file_roundtrip.safe_read_recovery",
        message: "One bounded read inside the records fixture failed before successful completion.",
      },
    ]);
    expect(result.passed).toBe(true);
  }
  return result.execution as RuntimeEvalExecution<FileRoundtripWorld>;
}

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return assistantMessage([{ type: "tool_call", id, name, input }], "tool_use");
}

function cwdFromContext(context: StreamContext): string {
  const base = context.systemPrompt.find((section) => section.label === "base")?.content ?? "";
  const match = base.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error("Missing runtime cwd in provider context.");
  return match[1];
}

function requiredMatch(value: string, pattern: RegExp): string {
  const match = value.match(pattern)?.[1];
  if (!match) throw new Error(`Missing fixture evidence for ${pattern}.`);
  return match;
}

function rewriteWriteTarget(input: unknown, from: string, to: string): unknown {
  if (typeof input !== "object" || input === null) return input;
  const changed = structuredClone(input) as Record<string, unknown>;
  if (typeof changed.file_path === "string") changed.file_path = changed.file_path.replace(from, to);
  if (typeof changed.patch === "string") changed.patch = changed.patch.replace(from, to);
  return changed;
}
