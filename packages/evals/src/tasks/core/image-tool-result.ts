// @summary Core eval candidate for provider transport of multiple image blocks returned by one in-memory tool

import { z } from "zod";
import type { EvalTask } from "../../task";
import { type EvalImageColor, seededImagePair, solidColorImageBlock } from "../image-fixture";
import { getFinalText, getToolTrace, isRecord } from "./helpers";

export interface ImageToolResultWorld {
  colors: { a: EvalImageColor; b: EvalImageColor };
  expected: string;
  requested: boolean;
}

export const imageToolResultTask: EvalTask<ImageToolResultWorld> = {
  id: "image-tool-result",
  description: "Identify two seed-swapped images returned by one in-memory tool result.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "Use the available image tool exactly once. The returned images are ordered A then B. Inspect both images and answer only in the requested exact format.",
    },
  ],
  limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 180_000, maxOutputTokens: 8_192 },
  createWorld(seed) {
    const colors = seededImagePair(seed);
    return { colors, expected: `A=${colors.a}; B=${colors.b}`, requested: false };
  },
  createTools: (world) => [
    {
      name: "get_swatch_pair",
      description: "Return two color swatches ordered A then B.",
      parameters: z.object({}),
      async execute() {
        world.requested = true;
        return {
          output: "Two swatch images are attached in order A then B.",
          outputImages: [solidColorImageBlock(world.colors.a), solidColorImageBlock(world.colors.b)],
        };
      },
    },
  ],
  createUserMessage: () => ({
    role: "user",
    content:
      "Call get_swatch_pair exactly once, inspect both returned images, and reply with exactly A=RED; B=BLUE or A=BLUE; B=RED matching their order. Include no other text.",
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({ colors: world.colors, requested: world.requested }),
  evaluate(execution) {
    const trace = getToolTrace(execution);
    if (trace.length !== 1 || trace[0]?.toolName !== "get_swatch_pair")
      return {
        passed: false,
        code: "image_tool_result.trace",
        message: "Expected exactly one get_swatch_pair call.",
      };
    if (!execution.world.requested)
      return { passed: false, code: "image_tool_result.not_requested", message: "The image tool did not execute." };
    const toolEnd = execution.events.find(
      ({ event }) =>
        event.type === "tool_end" && event.toolCallId === trace[0]!.toolCallId && event.toolName === "get_swatch_pair",
    )?.event;
    if (!toolEnd || toolEnd.type !== "tool_end" || !hasTwoPngImages(toolEnd.outputImages))
      return {
        passed: false,
        code: "image_tool_result.evidence",
        message: "The core tool_end event did not retain both PNG image blocks.",
      };
    return getFinalText(execution) === execution.world.expected
      ? { passed: true }
      : {
          passed: false,
          code: "image_tool_result.answer",
          message: `Expected exact response ${execution.world.expected}.`,
        };
  },
};

function hasTwoPngImages(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return value.every(
    (image) =>
      isRecord(image) &&
      isRecord(image.source) &&
      image.source.type === "base64" &&
      image.source.media_type === "image/png" &&
      typeof image.source.data === "string" &&
      image.source.data.startsWith("iVBOR"),
  );
}
