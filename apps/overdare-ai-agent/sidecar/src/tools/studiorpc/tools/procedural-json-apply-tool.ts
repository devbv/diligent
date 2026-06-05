// @summary Applies externally-created procedural scene JSON to Studio.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import * as instanceUpsert from "../methods/instance.upsert";
import { applyLevelChanges } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { executeInstanceUpsertInner } from "./instance-upsert-tool";

const MAX_NODES = 9999;
const MAX_DEPTH = 50;
export const PROCEDURAL_JSON_APPLY_BATCH_SIZE = 100;

const proceduralNodeSchema: z.ZodType<ProceduralJsonNode> = z.lazy(() =>
  z
    .object({
      class: z.string(),
      name: z.string(),
      properties: z.record(z.string(), z.unknown()).default({}),
      children: z.array(proceduralNodeSchema).optional(),
    })
    .strict(),
);

const proceduralJsonSchema = z
  .object({
    version: z.number().optional(),
    kind: z.string().optional(),
    generationId: z.string().optional(),
    scriptName: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    children: z.array(proceduralNodeSchema).min(1),
  })
  .strict();

const params = z
  .object({
    targetParentGuid: z.string().describe("Existing Studio parent GUID that receives the generated top-level nodes."),
    jsonPath: z
      .string()
      .min(1)
      .describe("Absolute or project-relative path to an externally-created procedural JSON file."),
    maxNodes: z.number().int().positive().max(MAX_NODES).optional(),
  })
  .strip();

export interface ProceduralJsonNode {
  class: string;
  name: string;
  properties?: Record<string, unknown>;
  children?: ProceduralJsonNode[];
}

interface ProceduralJsonDocument {
  version?: number;
  kind?: string;
  generationId?: string;
  scriptName?: string;
  parameters?: Record<string, unknown>;
  children: ProceduralJsonNode[];
}

export interface ProceduralJsonApplyArgs {
  targetParentGuid: string;
  jsonPath?: string;
  proceduralJson: ProceduralJsonDocument;
  maxNodes?: number;
}

interface ApplySummary {
  addCount: number;
  batches: number;
  targetGuids: string[];
  generationId?: string;
  scriptName?: string;
}

function parseProceduralJson(value: ProceduralJsonDocument | string): ProceduralJsonDocument {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return proceduralJsonSchema.parse(parsed);
  }
  return proceduralJsonSchema.parse(value);
}

function resolveJsonFilePath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export function parseProceduralJsonApplyArgs(value: Record<string, unknown>, cwd: string): ProceduralJsonApplyArgs {
  const parsed = params.parse(value);
  const proceduralJson = parseProceduralJson(readFileSync(resolveJsonFilePath(cwd, parsed.jsonPath), "utf8"));
  return {
    targetParentGuid: parsed.targetParentGuid,
    proceduralJson,
    jsonPath: parsed.jsonPath,
    maxNodes: parsed.maxNodes,
  };
}

function countNodes(nodes: ProceduralJsonNode[], depth = 1): number {
  if (depth > MAX_DEPTH) {
    throw new Error(`Procedural JSON exceeds maximum depth of ${MAX_DEPTH}.`);
  }
  let count = 0;
  for (const node of nodes) {
    count += 1 + countNodes(node.children ?? [], depth + 1);
  }
  return count;
}

function assertNodeLimit(document: ProceduralJsonDocument, maxNodes: number): number {
  const nodeCount = countNodes(document.children);
  if (nodeCount > maxNodes) {
    throw new Error(`Procedural JSON contains ${nodeCount} nodes, which exceeds maxNodes ${maxNodes}.`);
  }
  return nodeCount;
}

async function applyNodeTree(
  nodes: ProceduralJsonNode[],
  parentGuid: string,
  cwd: string,
  summary: ApplySummary,
): Promise<void> {
  for (let startIndex = 0; startIndex < nodes.length; startIndex += PROCEDURAL_JSON_APPLY_BATCH_SIZE) {
    const batch = nodes.slice(startIndex, startIndex + PROCEDURAL_JSON_APPLY_BATCH_SIZE);
    const parsedUpsert = instanceUpsert.parseArgs({
      items: batch.map((node) => ({
        class: node.class,
        parentGuid,
        name: node.name,
        properties: node.properties ?? {},
      })),
    });
    const result = await executeInstanceUpsertInner(parsedUpsert, cwd, { applyAndSaveChanges: false });
    const metadata = result.metadata as { added?: { guid: string }[] } | undefined;
    const added = metadata?.added ?? [];
    if (added.length !== batch.length) {
      throw new Error(`Studio returned ${added.length} GUIDs for ${batch.length} generated nodes.`);
    }
    summary.addCount += batch.length;
    summary.batches += 1;
    summary.targetGuids.push(...added.map((item) => item.guid));

    for (let index = 0; index < batch.length; index++) {
      const node = batch[index];
      const addedGuid = added[index]?.guid;
      if (!addedGuid) {
        throw new Error(`Studio did not return a GUID for generated node ${node.name}.`);
      }
      await applyNodeTree(node.children ?? [], addedGuid, cwd, summary);
    }
  }
}

async function executeProceduralJsonApply(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "studiorpc_procedural_json_apply";
  const parsedArgs = parseProceduralJsonApplyArgs(args, cwd);
  const proceduralJson = parsedArgs.proceduralJson as ProceduralJsonDocument;
  const nodeCount = assertNodeLimit(proceduralJson, parsedArgs.maxNodes ?? MAX_NODES);

  const approval = await ctx.approve({
    permission: "write",
    toolName,
    description: `Apply procedural JSON with ${nodeCount} generated node${nodeCount === 1 ? "" : "s"}`,
    details: {
      targetParentGuid: parsedArgs.targetParentGuid,
      jsonPath: parsedArgs.jsonPath,
      generationId: proceduralJson.generationId,
      scriptName: proceduralJson.scriptName,
      nodeCount,
    },
  });
  if (approval === "reject") {
    return {
      output: "[Rejected by user]",
      metadata: { error: true, method: "procedural-json.apply" },
    };
  }

  const release = await writeLock.acquire();
  try {
    const summary: ApplySummary = {
      addCount: 0,
      batches: 0,
      targetGuids: [],
      generationId: proceduralJson.generationId,
      scriptName: proceduralJson.scriptName,
    };
    await applyNodeTree(proceduralJson.children, parsedArgs.targetParentGuid, cwd, summary);
    await applyLevelChanges();

    return {
      output: JSON.stringify(
        {
          applied: true,
          adds: summary.addCount,
          batches: summary.batches,
          targetGuids: summary.targetGuids,
        },
        null,
        2,
      ),
      metadata: {
        method: "procedural-json.apply",
        addCount: summary.addCount,
        batches: summary.batches,
        targetGuids: summary.targetGuids,
        generationId: summary.generationId,
        scriptName: summary.scriptName,
      },
    };
  } finally {
    release();
  }
}

export function createProceduralJsonApplyTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: "studiorpc_procedural_json_apply",
    description:
      "Apply externally-created OVERDARE procedural JSON to Studio. Creates nested children recursively by creating each parent before its children and using the live returned GUID.",
    parameters: params,
    parseArgs: (raw) => parseProceduralJsonApplyArgs(raw as Record<string, unknown>, cwd),
    async execute(args, ctx) {
      return executeProceduralJsonApply(args, ctx, cwd, writeLock);
    },
  };
}
