// @summary Runtime eval candidate for stable-id project-knowledge search and in-place update

import { join } from "node:path";
import { readKnowledge } from "@diligent/runtime";
import type { RuntimeEvalTask, RuntimeVerifierResult } from "../../runtime-task";
import type { EvalProfile } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  writeFixture,
} from "./helpers";

export interface KnowledgeUpdateWorld extends RuntimeFixtureWorld {
  token: string;
  knowledgeId: string;
  content: string;
  tags: string[];
}

export const knowledgeUpdateTask: RuntimeEvalTask<KnowledgeUpdateWorld> = {
  id: "knowledge-update",
  description: "Search a stable knowledge id and update the durable preference in place.",
  fixtureVersion: "knowledge-update-v0",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 8, maxToolCalls: 6, timeoutMs: 180_000 },
  toolPolicy: {
    allowedTools: ["search_knowledge", "update_knowledge"],
    allowedCapabilities: ["knowledge"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const token = seededToken(seed, "MARKER");
    const knowledgeId = "preference.response-marker";
    const content = `Preferred response marker is ${token}.`;
    const tags = ["response-marker"];
    await writeFixture(root, {
      ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify({
        id: knowledgeId,
        timestamp: "2026-07-18T00:00:00.000Z",
        type: "preference",
        content: "Preferred response marker is OLD_VALUE.",
        confidence: 0.8,
        tags,
      })}\n`,
    });
    return {
      root,
      seed,
      token,
      knowledgeId,
      content,
      tags,
      expected: content,
      protectedPaths: [],
      allowedChanges: [],
    };
  },
  createRuntimeConfig: createKnowledgeRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `This is an explicit durable preference update. First search project knowledge using the exact id ${world.knowledgeId}. Then update that same id in place with type preference, content exactly "${world.content}", and tags ["response-marker"]. Do not create a second entry. Reply only ACK.`,
    },
  ],
  verify: verifyKnowledgeStore,
  snapshotWorld: async (world) => ({
    token: world.token,
    entries: await readKnowledge(join(world.root, ".diligent/knowledge")),
  }),
  evaluate(input) {
    const successful = input.toolCalls.filter((call) => !call.error);
    const searchIndex = successful.findIndex((call) => call.name === "search_knowledge");
    const updateIndex = successful.findIndex((call) => call.name === "update_knowledge");
    if (searchIndex < 0 || updateIndex < 0 || searchIndex >= updateIndex)
      return {
        passed: false,
        code: "knowledge_update.tool_order",
        message: "Expected a successful knowledge search before the update.",
      };
    const searchInput = successful[searchIndex]!.input;
    if (!isRecord(searchInput) || searchInput.id !== input.world.knowledgeId)
      return {
        passed: false,
        code: "knowledge_update.wrong_search",
        message: "The stable knowledge id was not searched exactly.",
      };
    const updateInput = successful[updateIndex]!.input;
    if (
      !isRecord(updateInput) ||
      (updateInput.action !== undefined && updateInput.action !== "upsert") ||
      updateInput.id !== input.world.knowledgeId ||
      updateInput.type !== "preference" ||
      updateInput.content !== input.world.content ||
      !sameStrings(updateInput.tags, input.world.tags)
    )
      return {
        passed: false,
        code: "knowledge_update.wrong_update",
        message: "The knowledge update arguments did not match the expected durable preference.",
      };
    return input.verifier?.exitCode === 0
      ? { passed: true }
      : {
          passed: false,
          code: "knowledge_update.store_mismatch",
          message: "The final knowledge store did not contain exactly one updated stable-id entry.",
        };
  },
};

async function createKnowledgeRuntimeConfig(world: KnowledgeUpdateWorld, profile: EvalProfile) {
  const config = await createFixtureRuntimeConfig(world, profile);
  return {
    ...config,
    diligent: { ...config.diligent, knowledge: { enabled: true, injectionBudget: 1024, maxItems: 5 } },
  };
}

async function verifyKnowledgeStore(world: KnowledgeUpdateWorld): Promise<RuntimeVerifierResult> {
  const started = performance.now();
  const entries = await readKnowledge(join(world.root, ".diligent/knowledge"));
  const matches = entries.filter((entry) => entry.id === world.knowledgeId);
  const expected = matches[0];
  const valid =
    entries.length === 1 &&
    matches.length === 1 &&
    expected?.type === "preference" &&
    expected.content === world.content &&
    sameStrings(expected.tags, world.tags);
  return {
    argv: ["knowledge-store-verifier"],
    exitCode: valid ? 0 : 1,
    elapsedMs: Math.round(performance.now() - started),
    stdout: valid ? JSON.stringify(expected) : JSON.stringify(entries),
    stderr: valid ? "" : "Knowledge store did not match the expected stable-id update.",
    timedOut: false,
  };
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
