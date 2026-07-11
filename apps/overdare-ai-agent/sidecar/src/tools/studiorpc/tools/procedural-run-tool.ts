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
      .describe(
        "Inline Luau procedural script source, executed host-side (NOT created as a Script instance in the " +
          "Studio scene). Use for concise one-shot edits/transforms. Return a table with " +
          "OnGenerate(parameters, targetContainer). Injected globals: Vector3, Color3, CFrame. Available modules: " +
          "require(script.Dependencies.GeometryPrimitives) and require(script.Dependencies.MathUtils). " +
          "See the procedural-luau-json skill for the full API.",
      ),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute or project-relative path to a .lua procedural script file on disk (host-side source, NOT a " +
          "Studio scene Script). Use when a file is easier to author or reuse. Same Luau surface as `script`.",
      ),
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
  })
  .strip();

export interface ProceduralRunArgs {
  scriptSource: string;
  scriptRef: string;
  targetGuid?: string;
  parameters: ProceduralParameters;
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
  };
}

// `parsed` is already the output of parseArgs (the tool framework runs parseArgs
// before execute); do NOT re-parse here — parseProceduralRunArgs is not
// idempotent (it maps script/scriptPath -> scriptSource/scriptRef), so a second
// pass would drop those keys and fail the "exactly one" check.
async function executeProceduralRun(
  parsed: ProceduralRunArgs,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const targetGuid = parsed.targetGuid ?? findWorkspaceGuid(cwd);
  if (!targetGuid) {
    throw new Error("Could not resolve a target GUID. Pass `targetGuid`, or ensure the level has a Workspace.");
  }

  const scene = readProceduralScene(cwd, targetGuid);
  const { ops, generationId, scriptName } = await runProceduralScript({
    scriptSource: parsed.scriptSource,
    parameters: parsed.parameters,
    scene,
    targetGuid,
    autoGenerationId: true,
  });

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
      "PREFER THIS over hand-placing/moving instances one-by-one whenever the work is algorithmic, parametric, or " +
      "rule-based: grids/rings/arcs/stairs/symmetry, repeated or math-driven placement, or bulk transforms across " +
      "many existing objects (e.g. 'shift/scale/recolor/delete every X'). It runs deterministically and is " +
      "re-runnable, so the same script reproduces the same scene. Reach for studiorpc_instance_upsert/move/delete " +
      "only for a few specific, hand-picked objects. Rule of thumb: if you'd write a loop or a formula to place it, " +
      "use this tool. " +
      "The script is host-side Luau source (inline `script` or an external `.lua` file via `scriptPath`) — it is " +
      "NOT authored as a Script instance inside the Studio scene, and the applied result is scene geometry " +
      "(Model/Part instances), never a Script object. " +
      "The current scene subtree (targetGuid, or the whole Workspace) is injected as a `workspace` global so " +
      "transform scripts can read and mutate existing objects; freshly-built nodes are added. " +
      "Transforms are limited to property updates (CFrame, Size, Color, Material, WorldPivot) plus add/delete — " +
      "it CANNOT reparent an existing object; use studiorpc_instance_move for hierarchy changes. " +
      "Scripts may use the injected globals (Vector3, Color3, CFrame) and dependency modules " +
      "(script.Dependencies.GeometryPrimitives / MathUtils). " +
      "Derives add/update/delete ops by diffing the script's end state against the scene, then applies them. " +
      "One-shot: nothing is persisted. Use studiorpc_procedural_model_save/_run for reusable models.",
    parameters: params,
    parseArgs: (raw) => parseProceduralRunArgs(raw as Record<string, unknown>, cwd),
    async execute(args, ctx) {
      return executeProceduralRun(args as ProceduralRunArgs, ctx, cwd, writeLock);
    },
  };
}
