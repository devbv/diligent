// @summary Runtime eval for an ordered read, overwrite, and confirmation read of one workspace file

import type { Message } from "@diligent/core/message-contract";
import type { RuntimeEvalTask } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

export interface FileRoundtripWorld extends RuntimeFixtureWorld {
  original: string;
  updated: string;
  expectedHash: string;
}

export const fileRoundtripTask: RuntimeEvalTask<FileRoundtripWorld> = {
  id: "file-roundtrip",
  description: "Read, overwrite, and re-read one workspace file in an exact ordered sequence.",
  fixtureVersion: "file-roundtrip-v0",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 6, maxToolCalls: 5, timeoutMs: 180_000 },
  toolPolicy: {
    allowedTools: ["read", "write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const original = seededToken(seed, "ORIGINAL");
    const updated = seededToken(seed, "UPDATED");
    const expected = `${updated}\n`;
    await writeFixture(root, { "document.txt": `${original}\n` });
    return {
      root,
      seed,
      original,
      updated,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [],
      allowedChanges: ["document.txt"],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `Use the read tool on ${world.root}/document.txt and note its current exact content. Overwrite that same file so it contains only ${world.updated} and one trailing newline. Then use the read tool on the same file again to confirm the persisted content. Reply with exactly FINAL=${world.updated} and no other text.`,
    },
  ],
  snapshotWorld: async (world) => ({
    original: world.original,
    updated: world.updated,
    result: await exactFile(world.root, "document.txt"),
  }),
  evaluate(input) {
    const calls = input.toolCalls.filter((call) => !call.error);
    const writes = calls.filter((call) => call.capability === "write");
    if (writes.length !== 1)
      return {
        passed: false,
        code: "file_roundtrip.write_count",
        message: "Expected exactly one successful overwrite.",
      };
    const writeIndex = calls.indexOf(writes[0]!);
    const targetReads = calls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          call.name === "read" && isRecord(call.input) && call.input.file_path === "$WORKSPACE/document.txt",
      );
    const before = targetReads.find(({ index }) => index < writeIndex);
    const after = targetReads.find(({ index }) => index > writeIndex);
    if (!before || !after)
      return {
        passed: false,
        code: "file_roundtrip.order",
        message: "Expected a read of document.txt before and after its overwrite.",
      };
    if (!JSON.stringify(before.call.output).includes(input.world.original))
      return {
        passed: false,
        code: "file_roundtrip.initial_read",
        message: "The first read did not observe the original content.",
      };
    if (!JSON.stringify(after.call.output).includes(input.world.updated))
      return {
        passed: false,
        code: "file_roundtrip.confirmation_read",
        message: "The confirmation read did not observe the updated content.",
      };
    const result = input.workspace.final.entries.find((entry) => entry.path === "document.txt");
    if (result?.sha256 !== input.world.expectedHash)
      return {
        passed: false,
        code: "file_roundtrip.file",
        message: "The final file did not contain the exact updated value.",
      };
    return lastAssistantText(input.turns.at(-1)?.messages ?? []) === `FINAL=${input.world.updated}`
      ? { passed: true }
      : {
          passed: false,
          code: "file_roundtrip.answer",
          message: "The final response did not match the confirmed updated value.",
        };
  },
};

function lastAssistantText(messages: Message[]): string {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  if (!last || last.role !== "assistant") return "";
  return last.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
