// @summary Candidate core eval task for one concurrent batch of independent tool calls

import { z } from "zod";
import type { EvalTask } from "../../task";
import { fixtureToken, getFinalText, getToolTrace, isRecord } from "./helpers";

export interface ParallelToolFragment {
  fragmentId: string;
  code: string;
}

export interface ParallelToolsWorld {
  fragments: ParallelToolFragment[];
  activeLookups: number;
  maxConcurrentLookups: number;
  completedFragmentIds: string[];
}

export const parallelToolsTask: EvalTask<ParallelToolsWorld> = {
  id: "parallel-tools",
  description: "Looks up three independent fragments in one parallel function-tool batch.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "When independent lookups are requested, issue every lookup together in one assistant tool-call batch. Do not wait for one lookup before issuing another. Finish with every returned code.",
    },
  ],
  limits: { maxTurns: 4, maxToolCalls: 3, timeoutMs: 180_000, maxOutputTokens: 8_192 },
  createWorld: (seed) => ({
    fragments: [1, 2, 3].map((index) => ({
      fragmentId: fixtureToken(seed, `parallel-fragment-id-${index}`, `fragment_${index}`),
      code: fixtureToken(seed, `parallel-fragment-code-${index}`, `code_${index}`),
    })),
    activeLookups: 0,
    maxConcurrentLookups: 0,
    completedFragmentIds: [],
  }),
  createTools: (world) => [
    {
      name: "lookup_fragment",
      description: "Look up one independent fragment by its exact fragmentId.",
      parameters: z.object({ fragmentId: z.string() }),
      supportParallel: true,
      async execute({ fragmentId }) {
        const fragment = world.fragments.find((candidate) => candidate.fragmentId === fragmentId);
        if (!fragment) {
          return { output: "Error: fragment not found", metadata: { error: true, code: "fragment_not_found" } };
        }
        world.activeLookups += 1;
        world.maxConcurrentLookups = Math.max(world.maxConcurrentLookups, world.activeLookups);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          world.completedFragmentIds.push(fragmentId);
          return { output: JSON.stringify(fragment) };
        } finally {
          world.activeLookups -= 1;
        }
      },
    },
  ],
  createUserMessage: (world) => ({
    role: "user",
    content: [
      "Look up all three independent fragments together in one parallel tool-call batch:",
      ...world.fragments.map((fragment) => `- ${fragment.fragmentId}`),
      "Return all three codes in the final answer.",
    ].join("\n"),
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({
    fragments: world.fragments.map((fragment) => ({ ...fragment })),
    activeLookups: world.activeLookups,
    maxConcurrentLookups: world.maxConcurrentLookups,
    completedFragmentIds: [...world.completedFragmentIds],
  }),
  evaluate: (execution) => {
    const trace = getToolTrace(execution);
    if (
      trace.length !== execution.world.fragments.length ||
      trace.some((entry) => entry.toolName !== "lookup_fragment")
    ) {
      return {
        passed: false,
        code: "parallel_tools.wrong_trace",
        message: "Expected exactly three lookup_fragment calls.",
      };
    }
    const requestedIds = trace.flatMap((entry) =>
      isRecord(entry.input) && typeof entry.input.fragmentId === "string" ? [entry.input.fragmentId] : [],
    );
    const expectedIds = execution.world.fragments.map((fragment) => fragment.fragmentId);
    if (!sameValues(requestedIds, expectedIds)) {
      return {
        passed: false,
        code: "parallel_tools.wrong_fragment_ids",
        message: "The lookup batch did not use every exact fragment ID once.",
      };
    }
    if (execution.world.maxConcurrentLookups !== execution.world.fragments.length) {
      return {
        passed: false,
        code: "parallel_tools.not_parallel",
        message: "The fragment lookups were not executed as one concurrent batch.",
      };
    }
    if (!sameValues(execution.world.completedFragmentIds, expectedIds)) {
      return {
        passed: false,
        code: "parallel_tools.incomplete",
        message: "Not every fragment lookup completed.",
      };
    }
    const finalText = getFinalText(execution);
    if (execution.world.fragments.some((fragment) => !finalText.includes(fragment.code))) {
      return {
        passed: false,
        code: "parallel_tools.missing_codes",
        message: "The final answer omitted one or more fragment codes.",
      };
    }
    return { passed: true };
  },
};

function sameValues(actual: string[], expected: string[]): boolean {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return (
    sortedActual.length === sortedExpected.length &&
    sortedActual.every((value, index) => value === sortedExpected[index])
  );
}
