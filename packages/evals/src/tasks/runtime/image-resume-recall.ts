// @summary Strict runtime eval for sidecar-backed image recall across server restart

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@diligent/core/message-contract";
import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension, EvalSemanticResult } from "../../task";
import { type EvalImageColor, seededImagePair, solidColorPng } from "../image-fixture";
import { createFixtureRuntimeConfig, DEFAULT_RUNTIME_LIMITS, type RuntimeFixtureWorld } from "./helpers";

const FIXTURE_PATH = "remembered-color.png";
const TOOL_NAME = "read_image";

export interface ImageResumeRecallWorld extends RuntimeFixtureWorld {
  color: EvalImageColor;
  fixturePath: string;
  fixtureSha256: string;
  sidecarRefSha256: string;
  fixtureSize: number;
}

export const imageResumeRecallTask: RuntimeEvalTask<ImageResumeRecallWorld> = {
  id: "image-resume-recall",
  description: "Read one image, restart, and recall its dominant color from sidecar-backed session evidence.",
  fixtureVersion: "image-resume-recall-v2",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 3,
    maxToolCalls: 1,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    timeoutMs: 180_000,
  },
  statePolicy: {
    allowedMutations: ["infrastructure", "sessions", "image_sidecars"],
    requiredMutations: ["image_sidecars"],
  },
  toolPolicy: {
    allowedTools: [TOOL_NAME],
    allowedCapabilities: ["read"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const color = seededImagePair(seed).a;
    const png = solidColorPng(color);
    await writeFile(join(root, FIXTURE_PATH), png);
    return {
      root,
      seed,
      color,
      fixturePath: FIXTURE_PATH,
      fixtureSha256: createHash("sha256").update(png).digest("hex"),
      sidecarRefSha256: createHash("sha256").update(png.toString("base64")).digest("hex"),
      fixtureSize: png.byteLength,
      expected: `COLOR=${color}`,
      protectedPaths: [FIXTURE_PATH],
      allowedChanges: [],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `Inspect the named image at ${world.root}/${world.fixturePath}, remember its dominant color for a later turn, and reply exactly ACK. Do not mention how you inspected it or reveal the color.`,
    },
    { kind: "restart_and_resume" },
    {
      kind: "turn",
      message:
        "Based only on your earlier inspection, reply with exactly COLOR=<dominant color>, replacing <dominant color> with the remembered value. Do not inspect the image again or include other text.",
    },
  ],
  snapshotWorld: async (world) => ({ color: world.color }),
  evaluate(input) {
    return evaluateLiveImageResumeRecall(input);
  },
};

function evaluateLiveImageResumeRecall(input: RuntimeEvalExecution<ImageResumeRecallWorld>): EvalSemanticResult {
  const fail = (code: string, message: string, dimension: EvalDimension): EvalSemanticResult => ({
    passed: false,
    code,
    message,
    dimension,
  });
  if (input.turns.length !== 2)
    return fail("image_resume.turns", "Expected the inspection and resumed recall turns.", "behavior");
  if (
    input.childSessions.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.approvals.length !== 0 ||
    input.userInputRequests.length !== 0
  )
    return fail("image_resume.forbidden_activity", "The recall used a forbidden side channel.", "runtime_policy");
  if (input.toolCalls.length !== 1)
    return fail("image_resume.read_count", "The image must be read exactly once before restart.", "behavior");
  const read = input.toolCalls[0]!;
  if (
    read.name !== TOOL_NAME ||
    read.capability !== "read" ||
    read.outcome !== "success" ||
    read.childThreadId !== undefined ||
    !deepEqual(read.input, { file_path: `$WORKSPACE/${input.world.fixturePath}` })
  )
    return fail("image_resume.read", "The intended image read was missing or broadened.", "runtime_policy");
  const ack = lastAssistantText(input.turns[0]!.messages);
  if (ack !== "ACK")
    return fail("image_resume.ack", "The inspection turn must end with exactly ACK.", "format_contract");
  const answer = lastAssistantText(input.turns[1]!.messages);
  if (!isExactColorAnswer(answer, input.world.color))
    return fail("image_resume.answer", "The resumed answer recalled the wrong color.", "semantic_goal");
  if (JSON.stringify(input).includes("iVBOR"))
    return fail("image_resume.base64", "Raw PNG base64 leaked into captured evidence.", "runtime_policy");
  if (!deepEqual(projectEntries(input.workspace.initial.entries), projectEntries(input.workspace.final.entries)))
    return fail("image_resume.project_manifest", "The protected project changed.", "runtime_policy");
  return { passed: true };
}

function isExactColorAnswer(value: string, color: EvalImageColor): boolean {
  const match = /^COLOR=([A-Za-z]+)$/.exec(value);
  return match?.[1]?.toUpperCase() === color;
}

function lastAssistantText(messages: Message[]): string {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  if (!last || last.role !== "assistant") return "";
  return last.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function projectEntries(entries: RuntimeEvalExecution<ImageResumeRecallWorld>["workspace"]["initial"]["entries"]) {
  return entries.filter((entry) => entry.path !== ".diligent" && !entry.path.startsWith(".diligent/"));
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
