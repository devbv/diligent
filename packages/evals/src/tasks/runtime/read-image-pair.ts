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
      return { passed: false, code: "read_image_pair.count", message: "Expected exactly two successful image reads." };
    const paths = reads.map((call) => (isRecord(call.input) ? call.input.file_path : undefined));
    if (!paths.includes("$WORKSPACE/a.png") || !paths.includes("$WORKSPACE/b.png"))
      return { passed: false, code: "read_image_pair.paths", message: "Both seeded image paths must be read." };
    if (reads.some((call) => !hasImageEvidence(call.output)))
      return {
        passed: false,
        code: "read_image_pair.evidence",
        message: "Each image read must retain redacted image evidence.",
      };
    const runtimeEvents = input.turns.flatMap((turn) => turn.runtimeEvents);
    if (
      reads.some(
        (call) =>
          !runtimeEvents.some((event) => {
            if (!isRecord(event)) return false;
            return (
              event.type === "tool_end" &&
              event.toolName === "read_image" &&
              event.toolCallId === call.toolCallId &&
              hasRedactedImageBlocks(event.outputImages)
            );
          }),
      )
    )
      return {
        passed: false,
        code: "read_image_pair.runtime_event",
        message: "Each image read must retain redacted outputImages on its runtime tool_end event.",
      };
    if (JSON.stringify(input).includes("iVBOR"))
      return { passed: false, code: "read_image_pair.base64", message: "Raw image base64 leaked into eval evidence." };
    return lastAssistantText(input.turns.at(-1)?.messages ?? []) === input.world.expected
      ? { passed: true }
      : {
          passed: false,
          code: "read_image_pair.answer",
          message: `Expected exact response ${input.world.expected}.`,
        };
  },
};

function hasImageEvidence(output: unknown): boolean {
  if (!isRecord(output) || !Array.isArray(output.outputImages) || output.outputImages.length === 0) return false;
  return output.outputImages.every((image) => {
    if (!isRecord(image) || !isRecord(image.source)) return false;
    return image.source.media_type === "image/png" && image.source.data === "[base64 omitted]";
  });
}

function hasRedactedImageBlocks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    value.every((image) => {
      if (!isRecord(image) || !isRecord(image.source)) return false;
      return image.source.media_type === "image/png" && image.source.data === "[base64 omitted]";
    })
  );
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
  return value !== null && typeof value === "object";
}
