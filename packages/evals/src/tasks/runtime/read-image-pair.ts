// @summary Runtime eval for paired image reading with bounded, redacted evidence

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@diligent/core/message-contract";
import type { RuntimeEvalTask } from "../../runtime-task";
import { type EvalImageColor, seededImagePair, solidColorPng } from "../image-fixture";
import { createFixtureRuntimeConfig, DEFAULT_RUNTIME_LIMITS, type RuntimeFixtureWorld } from "./helpers";

export interface ReadImagePairWorld extends RuntimeFixtureWorld {
  colors: { a: EvalImageColor; b: EvalImageColor };
}

export const readImagePairTask: RuntimeEvalTask<ReadImagePairWorld> = {
  id: "read-image-pair",
  description: "Read two seed-swapped images and report each dominant color exactly.",
  fixtureVersion: "read-image-pair-v1",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 6, maxToolCalls: 4, timeoutMs: 180_000 },
  statePolicy: {
    allowedMutations: ["infrastructure", "sessions", "image_sidecars"],
    requiredMutations: ["image_sidecars"],
  },
  toolPolicy: {
    allowedTools: ["read_image"],
    allowedCapabilities: ["read"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const colors = seededImagePair(seed);
    await writeFile(join(root, "a.png"), solidColorPng(colors.a));
    await writeFile(join(root, "b.png"), solidColorPng(colors.b));
    return {
      root,
      seed,
      colors,
      expected: `A=${colors.a}; B=${colors.b}`,
      protectedPaths: ["a.png", "b.png"],
      allowedChanges: [],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `Call read_image exactly once on ${world.root}/a.png and exactly once on ${world.root}/b.png. Identify each image's dominant color. Reply with exactly A=RED; B=BLUE or A=BLUE; B=RED, matching the files, with no other text.`,
    },
  ],
  snapshotWorld: async (world) => ({ colors: world.colors }),
  evaluate(input) {
    const reads = input.toolCalls.filter((call) => call.name === "read_image" && !call.error);
    if (reads.length !== 2)
      return {
        passed: false,
        code: "read_image_pair.count",
        message: "Expected exactly two successful image reads.",
        dimension: "behavior",
      };
    const paths = reads.map((call) => (isRecord(call.input) ? call.input.file_path : undefined));
    if (!paths.includes("$WORKSPACE/a.png") || !paths.includes("$WORKSPACE/b.png"))
      return {
        passed: false,
        code: "read_image_pair.paths",
        message: "Both seeded image paths must be read.",
        dimension: "runtime_policy",
      };
    if (JSON.stringify(input).includes("iVBOR"))
      return {
        passed: false,
        code: "read_image_pair.base64",
        message: "Raw image base64 leaked into eval evidence.",
        dimension: "runtime_policy",
      };
    const answer = lastAssistantText(input.turns.at(-1)?.messages ?? []);
    const semantic = /A=(RED|BLUE);\s*B=(RED|BLUE)/i.exec(answer);
    if (semantic?.[1]?.toUpperCase() !== input.world.colors.a || semantic?.[2]?.toUpperCase() !== input.world.colors.b)
      return {
        passed: false,
        code: "read_image_pair.answer",
        message: "The response classified one or both images incorrectly.",
        dimension: "semantic_goal",
      };
    return answer === input.world.expected
      ? { passed: true }
      : {
          passed: false,
          code: "read_image_pair.answer",
          message: `Expected exact response ${input.world.expected}.`,
          dimension: "format_contract",
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
