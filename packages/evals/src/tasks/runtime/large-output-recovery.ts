// @summary Behavioral runtime eval for recovering a hidden fact from a registered truncated tool output

import type { BundledToolProvider } from "@diligent/runtime";
import { z } from "zod";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeWorldSnapshot } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

const FIXTURE_TOOL = "retrieve_archived_record";
const PROVIDER_ID = "eval-large-output-recovery";
const MANIFEST_PATH = "manifest.json";
const KEEP_PATH = ".git/.keep";
const OUTPUT_PATH = "$TOOL_OUTPUT/full-output-000001.txt";
const RETAINED_BYTES = 1_024;
const FACT_LINE = 501;
const SENTINEL_LINE = 450;
const LINE_COUNT = 600;

export interface LargeOutputRecoveryWorld extends RuntimeFixtureWorld {
  argument: string;
  hiddenFact: string;
  payloadSentinel: string;
  guidance: string;
  clientPrompt: string;
  manifestContent: string;
  manifestHash: string;
  generatedBytes: number;
  generatedHash: string;
  retainedBytes: number;
  factLine: number;
  readOffset: number;
  readLimit: number;
}

export const largeOutputRecoveryTask: RuntimeEvalTask<LargeOutputRecoveryWorld> = {
  id: "large-output-recovery",
  description: "Recover one exact hidden fact through core truncation and a registered bounded full-output read.",
  fixtureVersion: "large-output-recovery-v5",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 3,
    maxToolCalls: 2,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: [FIXTURE_TOOL, "read"],
    allowedCapabilities: ["execute", "read"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const fixture = fixtureFor(seed);
    await writeFixture(root, { [MANIFEST_PATH]: fixture.manifestContent, [KEEP_PATH]: "fixture boundary\n" });
    return {
      root,
      seed,
      expected: fixture.hiddenFact,
      protectedPaths: [MANIFEST_PATH, KEEP_PATH],
      allowedChanges: [],
      ...fixture,
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createBundledToolProviders(world): readonly BundledToolProvider[] {
    return [
      {
        id: PROVIDER_ID,
        createTools: () => [
          {
            name: FIXTURE_TOOL,
            description:
              `Retrieve the archived record for a request identifier. In large records, the authorization is the ` +
              `RECOVERY_VALUE field on line ${world.factLine}; use a bounded full-output read when the inline result is truncated.`,
            parameters: z.object({ request_id: z.string() }).strict(),
            async execute({ request_id }) {
              if (request_id !== world.argument)
                return { output: "Error: archived request was not found.", metadata: { error: true } };
              return {
                output: generatePayload(world),
                maxOutputBytes: world.retainedBytes,
                truncateDirection: "head" as const,
              };
            },
          },
        ],
      },
    ];
  },
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  snapshotWorld: async (world) => ({
    argument: world.argument,
    generatedBytes: world.generatedBytes,
    generatedHash: world.generatedHash,
    protectedPaths: world.protectedPaths,
  }),
  evaluate(input) {
    if (!input.turns[0]) return fail("turn", "The recovery turn is missing.");
    return (
      validateManifest(input) ??
      validateTools(input) ??
      validateForbiddenSurfaces(input) ??
      validateFinal(input) ?? { passed: true }
    );
  },
};

function fixtureFor(seed: string) {
  const argument = seededToken(seed, "ARCHIVE_REQUEST");
  const hiddenFact = seededToken(seed, "RECOVERY_FACT");
  const payloadSentinel = seededToken(seed, "UNRETAINED_SENTINEL");
  const guidance =
    `RECOVERY INDEX: authorization_field=RECOVERY_VALUE; line=${FACT_LINE}; ` +
    `recommended_window=offset:${FACT_LINE},limit:1; record_size=${LINE_COUNT}_lines.`;
  const clientPrompt =
    `Resolve archival request ${argument} and return its authorization value. ` +
    "Keep the response concise: use either the value alone or one `The authorization value is:` label followed by the value.";
  const manifestContent = `${JSON.stringify({ request: argument, classification: "archived-authorization" }, null, 2)}\n`;
  const basis = {
    argument,
    hiddenFact,
    payloadSentinel,
    guidance,
    clientPrompt,
    manifestContent,
    manifestHash: sha256Text(manifestContent),
    retainedBytes: RETAINED_BYTES,
    factLine: FACT_LINE,
    readOffset: FACT_LINE,
    readLimit: 1,
  };
  const payload = generatePayload(basis);
  return { ...basis, generatedBytes: Buffer.byteLength(payload), generatedHash: sha256Text(payload) };
}

function generatePayload(world: Pick<LargeOutputRecoveryWorld, "guidance" | "hiddenFact" | "payloadSentinel">): string {
  return Array.from({ length: LINE_COUNT }, (_, index) => {
    const line = index + 1;
    if (line === 1) return world.guidance;
    if (line === SENTINEL_LINE) return world.payloadSentinel;
    if (line === FACT_LINE) return `RECOVERY_VALUE=${world.hiddenFact}`;
    return `ARCHIVE_ROW_${String(line).padStart(3, "0")}_${"x".repeat(36)}`;
  }).join("\n");
}

function validateManifest(input: RuntimeEvalExecution<LargeOutputRecoveryWorld>) {
  if (
    !hasExactInitialManifest(input.workspace.initial, input.world) ||
    !sameProjectManifest(input.workspace.initial, input.workspace.final)
  )
    return fail("manifest", "The protected manifest kind, size, hash, membership, or final project state changed.");
}

function validateTools(input: RuntimeEvalExecution<LargeOutputRecoveryWorld>) {
  const fixture = input.toolCalls[0];
  const read = input.toolCalls[1];
  if (
    input.toolCalls.length !== 2 ||
    !fixture ||
    !read ||
    fixture.toolCallId.length === 0 ||
    read.toolCallId.length === 0 ||
    fixture.toolCallId === read.toolCallId ||
    fixture.sequence !== 1 ||
    fixture.name !== FIXTURE_TOOL ||
    fixture.capability !== "execute" ||
    fixture.outcome !== "success" ||
    fixture.error !== undefined ||
    fixture.childThreadId !== undefined ||
    fixture.threadId !== input.session.threadId ||
    JSON.stringify(fixture.input) !== JSON.stringify({ request_id: input.world.argument }) ||
    read.sequence !== 2 ||
    read.name !== "read" ||
    read.capability !== "read" ||
    read.outcome !== "success" ||
    read.error !== undefined ||
    read.childThreadId !== undefined ||
    read.threadId !== input.session.threadId ||
    !isBoundedFactReadInput(read.input, input.world.factLine)
  )
    return fail("tools", "The advertised or executed tools, order, actor, outcome, or strict arguments were wrong.");
}

function isBoundedFactReadInput(value: unknown, factLine: number): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "file_path,limit,offset") return false;
  const { file_path, offset, limit } = value;
  return (
    file_path === OUTPUT_PATH &&
    typeof offset === "number" &&
    Number.isInteger(offset) &&
    typeof limit === "number" &&
    Number.isInteger(limit) &&
    offset >= 1 &&
    limit >= 1 &&
    limit <= 20 &&
    offset <= factLine &&
    factLine < offset + limit
  );
}

function validateForbiddenSurfaces(input: RuntimeEvalExecution<LargeOutputRecoveryWorld>) {
  if (
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.approvals.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.childSessions.length !== 0 ||
    input.verifier !== undefined ||
    input.runtimeState.diff.some((change) => change.category !== "infrastructure" && change.category !== "sessions") ||
    input.toolCalls.some((call) => call.name !== FIXTURE_TOOL && call.name !== "read")
  )
    return fail(
      "forbidden",
      "A forbidden mutation, action, approval, input, child, compaction, verifier, or tool appeared.",
    );
}

function validateFinal(input: RuntimeEvalExecution<LargeOutputRecoveryWorld>) {
  const final = [...input.turns[0]!.messages].reverse().find((message) => message.role === "assistant");
  const textBlocks = final?.content.filter((block) => block.type === "text") ?? [];
  if (
    !final ||
    !Array.isArray(final.content) ||
    final.content.some((block) => block.type !== "thinking" && block.type !== "text") ||
    textBlocks.length !== 1 ||
    Object.keys(textBlocks[0]!).length !== 2 ||
    !isExclusiveAuthorizationAnswer(textBlocks[0]!.text, input.world.hiddenFact)
  )
    return fail("final", "The final response was not the exclusive authorization value in a declared format.");
}

function isExclusiveAuthorizationAnswer(text: string, hiddenFact: string): boolean {
  if (text === hiddenFact) return true;
  const label = "The authorization value is:";
  if (!text.startsWith(label)) return false;
  const labeledValue = text.slice(label.length).trim();
  return labeledValue === hiddenFact || labeledValue === `\`${hiddenFact}\``;
}

function hasExactInitialManifest(snapshot: RuntimeWorldSnapshot, world: LargeOutputRecoveryWorld): boolean {
  const expected = [
    { path: ".git", kind: "directory", size: 0 },
    { path: KEEP_PATH, kind: "file", size: 17, sha256: sha256Text("fixture boundary\n"), executable: false },
    {
      path: MANIFEST_PATH,
      kind: "file",
      size: Buffer.byteLength(world.manifestContent),
      sha256: world.manifestHash,
      executable: false,
    },
  ];
  return JSON.stringify(snapshot.entries) === JSON.stringify(expected);
}

function sameProjectManifest(initial: RuntimeWorldSnapshot, final: RuntimeWorldSnapshot): boolean {
  const project = (snapshot: RuntimeWorldSnapshot) =>
    snapshot.entries.filter((entry) => entry.path !== ".diligent" && !entry.path.startsWith(".diligent/"));
  return JSON.stringify(project(initial)) === JSON.stringify(project(final));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const LARGE_OUTPUT_FAILURE_DIMENSIONS = {
  turn: "behavior",
  manifest: "runtime_policy",
  tools: "runtime_policy",
  forbidden: "runtime_policy",
  final: "semantic_goal",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof LARGE_OUTPUT_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `large_output_recovery.${code}`,
    message,
    dimension: LARGE_OUTPUT_FAILURE_DIMENSIONS[code],
  };
}
