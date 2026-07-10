// @summary One-shot procedural run: execute a script against the current scene and apply the derived ops.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { runProceduralScript } from "../../../procedural";
import type { ProceduralParameters } from "../../../procedural/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { applyProceduralOps } from "./procedural-apply";
import { findWorkspaceGuid, readProceduralScene } from "./procedural-scene";

const TOOL_NAME = "studiorpc_procedural_run";
const DEFAULT_SIZE = { X: 10, Y: 10, Z: 10 } as const;

const vec3Schema = z.object({ X: z.number(), Y: z.number(), Z: z.number() }).strict();

const params = z
  .object({
    script: z
      .string()
      .min(1)
      .optional()
      .describe("Inline Luau procedural script source. Use for small edits/transforms."),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute or project-relative path to a .lua procedural script. Use for large scripts."),
    targetGuid: z
      .string()
      .optional()
      .describe("Scene subtree to inject and parent new nodes under. Defaults to the Workspace (whole scene)."),
    parameters: z
      .object({
        Size: vec3Schema.optional(),
        Attributes: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional()
      .describe("Free-form generation parameters. Read the script to learn which knobs it uses."),
    maxNodes: z.number().int().positive().optional().describe("Override the max serialized node count guardrail."),
  })
  .strip();

export interface ProceduralRunArgs {
  scriptSource: string;
  scriptRef: string;
  targetGuid?: string;
  parameters: ProceduralParameters;
  maxNodes?: number;
}

function resolveScriptPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export function parseProceduralRunArgs(value: Record<string, unknown>, cwd: string): ProceduralRunArgs {
  const parsed = params.parse(value);
  if (!parsed.script === !parsed.scriptPath) {
    throw new Error("Provide exactly one of `script` (inline) or `scriptPath` (file).");
  }
  const scriptSource = parsed.script ?? readFileSync(resolveScriptPath(cwd, parsed.scriptPath as string), "utf8");
  return {
    scriptSource,
    scriptRef: parsed.script ? "<inline>" : (parsed.scriptPath as string),
    targetGuid: parsed.targetGuid,
    parameters: {
      Size: parsed.parameters?.Size ?? { ...DEFAULT_SIZE },
      Attributes: parsed.parameters?.Attributes ?? {},
    },
    maxNodes: parsed.maxNodes,
  };
}

async function executeProceduralRun(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const parsed = parseProceduralRunArgs(args, cwd);

  const targetGuid = parsed.targetGuid ?? findWorkspaceGuid(cwd);
  if (!targetGuid) {
    throw new Error("Could not resolve a target GUID. Pass `targetGuid`, or ensure the level has a Workspace.");
  }

  const scene = readProceduralScene(cwd, targetGuid);
  const { ops, generationId, scriptName } = await runProceduralScript(
    { scriptSource: parsed.scriptSource, parameters: parsed.parameters, scene, targetGuid, autoGenerationId: true },
    { limits: parsed.maxNodes ? { maxNodes: parsed.maxNodes } : undefined },
  );

  const adds = ops.filter((op) => op.kind === "add").length;
  const updates = ops.filter((op) => op.kind === "update").length;
  const deletes = ops.filter((op) => op.kind === "delete").length;

  if (ops.length === 0) {
    return {
      output: "Procedural run produced no scene changes.",
      metadata: { method: "procedural.run", generationId, scriptName, adds: 0, updates: 0, deletes: 0 },
    };
  }

  const approval = await ctx.approve({
    permission: "write",
    toolName: TOOL_NAME,
    description: `Run procedural script "${scriptName}" (+${adds} / ~${updates} / -${deletes} node${
      adds + updates + deletes === 1 ? "" : "s"
    })`,
    details: { scriptRef: parsed.scriptRef, targetGuid, generationId, adds, updates, deletes },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true, method: "procedural.run" } };
  }

  const release = await writeLock.acquire();
  try {
    const result = await applyProceduralOps(ops, { targetGuid, cwd });
    return {
      output: JSON.stringify(
        {
          applied: true,
          generationId,
          scriptName,
          adds: result.addCount,
          updates: result.updateCount,
          deletes: result.deleteCount,
          skippedDeletes: result.skippedDeletes,
          addedGuids: result.addedGuids,
        },
        null,
        2,
      ),
      metadata: {
        method: "procedural.run",
        generationId,
        scriptName,
        targetGuid,
        addCount: result.addCount,
        updateCount: result.updateCount,
        deleteCount: result.deleteCount,
        addedGuids: result.addedGuids,
        updatedGuids: result.updatedGuids,
        deletedGuids: result.deletedGuids,
        skippedDeletes: result.skippedDeletes,
      },
    };
  } finally {
    release();
  }
}

export function createProceduralRunTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: TOOL_NAME,
    description:
      "Run an OVERDARE procedural Luau script once against the current scene and apply the result. " +
      "The current scene subtree (targetGuid, or the whole Workspace) is injected as a `workspace` global so " +
      "transform scripts can read and mutate existing objects; freshly-built nodes are added. " +
      "Provide the script inline via `script` (small edits) or as a file via `scriptPath` (large scripts). " +
      "Derives add/update/delete ops by diffing the script's end state against the scene, then applies them. " +
      "One-shot: nothing is persisted. Use studiorpc_procedural_model_save/_run for reusable models.",
    parameters: params,
    parseArgs: (raw) => parseProceduralRunArgs(raw as Record<string, unknown>, cwd),
    async execute(args, ctx) {
      return executeProceduralRun(args, ctx, cwd, writeLock);
    },
  };
}
