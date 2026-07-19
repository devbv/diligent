// @summary Core eval for provider transport of multiple image blocks returned by one in-memory tool

import { z } from "zod";
import type { EvalTask } from "../../task";
import { type EvalImageColor, seededImagePair, solidColorImageBlock } from "../image-fixture";
import { getFinalAssistant, getToolTrace } from "./helpers";

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
    if (trace.length !== 1)
      return {
        passed: false,
        code: "image_tool_result.trace",
        message: "Expected exactly one get_swatch_pair call.",
        dimension: "behavior",
      };
    if (trace[0]?.toolName !== "get_swatch_pair")
      return {
        passed: false,
        code: "image_tool_result.trace",
        message: "The only tool call used an undeclared tool surface.",
        dimension: "runtime_policy",
      };
    const finalText =
      getFinalAssistant(execution)
        ?.content.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "";
    const semantic = /A=(RED|BLUE);\s*B=(RED|BLUE)/i.exec(finalText);
    if (
      semantic?.[1]?.toUpperCase() !== execution.world.colors.a ||
      semantic[2]?.toUpperCase() !== execution.world.colors.b
    )
      return {
        passed: false,
        code: "image_tool_result.answer",
        message: "The response did not classify both images in the correct order.",
        dimension: "semantic_goal",
      };
    return finalText === execution.world.expected
      ? { passed: true }
      : {
          passed: false,
          code: "image_tool_result.format",
          message: `Expected exact response bytes ${execution.world.expected}.`,
          dimension: "format_contract",
        };
  },
};
