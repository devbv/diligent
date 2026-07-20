// @summary Behavioral runtime eval for natural-intent routing across fixture-owned bundled tools

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

const INTENDED_TOOL = "coordinate_field_journey";
const DECOY_TOOL = "schedule_archive_collection";
const INTENDED_PROVIDER = "eval-field-journey-provider";
const DECOY_PROVIDER = "eval-archive-collection-provider";
const MANIFEST_PATH = "manifest.json";
const KEEP_PATH = ".git/.keep";

const INTENDED_DESCRIPTION =
  "Coordinate a field-research journey when the assignment, destination, travel window, participants, and onboard needs are known.";
const DECOY_DESCRIPTION =
  "Schedule secure collection of boxed archive materials when a repository, loading slot, and parcel inventory are known.";

interface JourneyRequest {
  assignment_ref: string;
  route: {
    destination: { city: string; country_code: string };
    travel_window: { outbound: string; inbound: string };
    participants: Array<{ identity: string; duty: "lead" | "observer" }>;
  };
  service: { cabin: "quiet" | "standard"; accessibility_support: boolean };
}

interface ProviderAssemblyRecord {
  providerId: string;
  cwd: string;
}

interface ExecutionRecord {
  providerId: string;
  toolName: string;
  input: unknown;
}

export interface BundledToolRoutingWorld extends RuntimeFixtureWorld {
  assignmentRef: string;
  destinationCity: string;
  destinationCountry: string;
  outboundDate: string;
  inboundDate: string;
  leadIdentity: string;
  observerIdentity: string;
  request: JourneyRequest;
  receipt: string;
  decoyReceipt: string;
  clientPrompt: string;
  manifestContent: string;
  manifestHash: string;
  providerAssembly: ProviderAssemblyRecord[];
  executions: ExecutionRecord[];
}

export const bundledToolRoutingTask: RuntimeEvalTask<BundledToolRoutingWorld> = {
  id: "bundled-tool-routing",
  description: "Route a natural request to one of two normally assembled bundled tools with exact nested input.",
  fixtureVersion: "bundled-tool-routing-v3",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 2,
    maxToolCalls: 1,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: [INTENDED_TOOL, DECOY_TOOL],
    allowedCapabilities: ["execute"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const fixture = fixtureFor(seed);
    await writeFixture(root, { [MANIFEST_PATH]: fixture.manifestContent, [KEEP_PATH]: "fixture boundary\n" });
    return {
      root,
      seed,
      expected: fixture.receipt,
      protectedPaths: [MANIFEST_PATH, KEEP_PATH],
      allowedChanges: [],
      ...fixture,
      providerAssembly: [],
      executions: [],
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createBundledToolProviders(world): readonly BundledToolProvider[] {
    return [intendedProvider(world), decoyProvider(world)];
  },
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  snapshotWorld: async (world) => ({
    assignmentRef: world.assignmentRef,
    request: world.request,
    receipt: world.receipt,
    protectedPaths: world.protectedPaths,
  }),
  evaluate(input) {
    return (
      validateManifest(input) ??
      validateAssemblyAndTrace(input) ??
      validateIsolation(input) ??
      validateFinal(input) ?? { passed: true }
    );
  },
};

function intendedProvider(world: BundledToolRoutingWorld): BundledToolProvider {
  return {
    id: INTENDED_PROVIDER,
    createTools({ cwd }) {
      world.providerAssembly.push({ providerId: INTENDED_PROVIDER, cwd });
      return [
        {
          name: INTENDED_TOOL,
          description: INTENDED_DESCRIPTION,
          parameters: journeySchema(),
          async execute(input) {
            world.executions.push({ providerId: INTENDED_PROVIDER, toolName: INTENDED_TOOL, input });
            return { output: canonicalJson(input) === canonicalJson(world.request) ? world.receipt : "REJECTED_INPUT" };
          },
        },
      ];
    },
  };
}

function decoyProvider(world: BundledToolRoutingWorld): BundledToolProvider {
  return {
    id: DECOY_PROVIDER,
    createTools({ cwd }) {
      world.providerAssembly.push({ providerId: DECOY_PROVIDER, cwd });
      return [
        {
          name: DECOY_TOOL,
          description: DECOY_DESCRIPTION,
          parameters: z
            .object({
              repository_code: z.string(),
              loading_slot: z.object({ date: z.string(), hour_utc: z.number().int() }).strict(),
              parcels: z.array(z.object({ label: z.string(), crate_count: z.number().int().positive() }).strict()),
            })
            .strict(),
          async execute(input) {
            world.executions.push({ providerId: DECOY_PROVIDER, toolName: DECOY_TOOL, input });
            return { output: world.decoyReceipt };
          },
        },
      ];
    },
  };
}

function journeySchema() {
  return z
    .object({
      assignment_ref: z.string(),
      route: z
        .object({
          destination: z.object({ city: z.string(), country_code: z.string().length(2) }).strict(),
          travel_window: z.object({ outbound: z.string(), inbound: z.string() }).strict(),
          participants: z
            .array(z.object({ identity: z.string(), duty: z.enum(["lead", "observer"]) }).strict())
            .length(2),
        })
        .strict(),
      service: z.object({ cabin: z.enum(["quiet", "standard"]), accessibility_support: z.boolean() }).strict(),
    })
    .strict();
}

function fixtureFor(seed: string) {
  const assignmentRef = seededToken(seed, "ASSIGNMENT");
  const destinationCity = seededToken(seed, "CITY");
  const destinationCountry = "KR";
  const outboundDate = "2026-09-17";
  const inboundDate = "2026-09-21";
  const leadIdentity = seededToken(seed, "LEAD");
  const observerIdentity = seededToken(seed, "OBSERVER");
  const request: JourneyRequest = {
    assignment_ref: assignmentRef,
    route: {
      destination: { city: destinationCity, country_code: destinationCountry },
      travel_window: { outbound: outboundDate, inbound: inboundDate },
      participants: [
        { identity: leadIdentity, duty: "lead" },
        { identity: observerIdentity, duty: "observer" },
      ],
    },
    service: { cabin: "quiet", accessibility_support: false },
  };
  const receipt = seededToken(seed, "JOURNEY_RECEIPT");
  const decoyReceipt = seededToken(seed, "COLLECTION_RECEIPT");
  const clientPrompt =
    `Please arrange the field trip tied to ${assignmentRef}. ${leadIdentity} will lead and ${observerIdentity} will ` +
    `observe in ${destinationCity}, ${destinationCountry}, traveling ${outboundDate} through ${inboundDate}. ` +
    "They prefer a quiet cabin and do not need accessibility support. After the tool succeeds, reply with its output verbatim and no other text.";
  const manifestContent = `${JSON.stringify({ fixture: "field-journey", assignment: assignmentRef }, null, 2)}\n`;
  return {
    assignmentRef,
    destinationCity,
    destinationCountry,
    outboundDate,
    inboundDate,
    leadIdentity,
    observerIdentity,
    request,
    receipt,
    decoyReceipt,
    clientPrompt,
    manifestContent,
    manifestHash: sha256Text(manifestContent),
  };
}

function validateManifest(input: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const expected = [
    { path: ".git", kind: "directory", size: 0 },
    { path: KEEP_PATH, kind: "file", size: 17, sha256: sha256Text("fixture boundary\n"), executable: false },
    {
      path: MANIFEST_PATH,
      kind: "file",
      size: Buffer.byteLength(input.world.manifestContent),
      sha256: input.world.manifestHash,
      executable: false,
    },
  ];
  if (
    JSON.stringify(input.workspace.initial.entries) !== JSON.stringify(expected) ||
    !sameProjectManifest(input.workspace.initial, input.workspace.final)
  )
    return fail("manifest", "The protected fixture manifest changed in kind, size, hash, membership, or final state.");
}

function validateAssemblyAndTrace(input: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const trace = input.toolCalls[0];
  if (
    input.toolCalls.length !== 1 ||
    !trace ||
    trace.sequence !== 1 ||
    trace.toolCallId.length === 0 ||
    trace.name !== INTENDED_TOOL ||
    trace.capability !== "execute" ||
    trace.outcome !== "success" ||
    trace.error !== undefined ||
    trace.childThreadId !== undefined ||
    trace.threadId !== input.session.threadId ||
    canonicalJson(trace.input) !== canonicalJson(input.world.request)
  )
    return fail("trace", "The intended bundled tool was not selected once with exact nested input and root actor.");
}

function validateIsolation(input: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const report = JSON.stringify([
    input.turns,
    input.providerCalls,
    input.toolCalls,
    input.logs,
    input.session,
    input.threadReads,
    input.workspace,
    input.runtimeState,
    input.advertisedTools,
  ]);
  if (
    input.toolOutputFiles.length !== 0 ||
    input.childSessions.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.approvals.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.verifier !== undefined ||
    input.runtimeState.diff.some((change) => change.category !== "infrastructure" && change.category !== "sessions") ||
    JSON.stringify(input.logs).includes(input.world.receipt) ||
    report.includes(input.world.decoyReceipt)
  )
    return fail(
      "isolation",
      "Forbidden state, action, collaboration, input, verifier, output, or decoy leakage appeared.",
    );
}

function validateFinal(input: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const final = input.turns[0]!.messages[3];
  if (!hasExactFinalAssistant(final, input.world.receipt))
    return fail("final", "The final response was not the exact exclusive intended receipt.");
}

function hasExactFinalAssistant(value: unknown, receipt: string): boolean {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content) || value.content.length !== 1)
    return false;
  const block = value.content[0];
  return (
    isRecord(block) &&
    Object.keys(block).sort().join(",") === "text,type" &&
    block.type === "text" &&
    (block.text === receipt || block.text === `Confirmed: ${receipt}`)
  );
}

function sameProjectManifest(initial: RuntimeWorldSnapshot, final: RuntimeWorldSnapshot): boolean {
  const project = (snapshot: RuntimeWorldSnapshot) =>
    snapshot.entries.filter((entry) => entry.path !== ".diligent" && !entry.path.startsWith(".diligent/"));
  return JSON.stringify(project(initial)) === JSON.stringify(project(final));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const BUNDLED_FAILURE_DIMENSIONS = {
  manifest: "runtime_policy",
  trace: "behavior",
  isolation: "runtime_policy",
  final: "semantic_goal",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof BUNDLED_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `bundled_tool_routing.${code}`,
    message,
    dimension: BUNDLED_FAILURE_DIMENSIONS[code],
  };
}
