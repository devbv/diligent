// @summary Run a reusable project-local procedural recipe against the current scene.

import { z } from "zod";
import { PROCEDURAL_RECIPE_ID_PATTERN, readRecipeScript, runProceduralScript } from "../../../procedural";
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
    id: z
      .string()
      .min(1)
      .regex(
        PROCEDURAL_RECIPE_ID_PATTERN,
        "Use only letters, digits, '.', '_', and '-'; the recipe id must start with a letter or digit.",
      )
      .describe(
        "Stable recipe id. The host-side Luau source must be stored at " +
          ".overdare/procedural/<id>/main.lua. Search that directory and reuse an existing recipe before creating " +
          "a new one; edit the same file and rerun after failures or requested changes.",
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
  recipeId: string;
  scriptSource: string;
  scriptRef: string;
  targetGuid?: string;
  parameters: ProceduralParameters;
}

export function parseProceduralRunArgs(value: Record<string, unknown>, cwd: string): ProceduralRunArgs {
  const parsed = params.parse(value);
  const { scriptSource, scriptRef } = readRecipeScript(cwd, parsed.id);
  return {
    recipeId: parsed.id,
    scriptSource,
    scriptRef,
    targetGuid: parsed.targetGuid,
    parameters: {
      Size: parsed.parameters?.Size ?? { ...DEFAULT_SIZE },
      Attributes: parsed.parameters?.Attributes ?? {},
    },
  };
}

// `parsed` is already the output of parseArgs (the tool framework runs parseArgs
// before execute); do NOT re-parse here — parseProceduralRunArgs is not
// idempotent (it maps id -> scriptSource/scriptRef and reads the file), so a
// second pass would fail on the now-required, already-consumed id.
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
  const { ops, scriptName } = await runProceduralScript({
    scriptSource: parsed.scriptSource,
    parameters: parsed.parameters,
    scene,
    targetGuid,
  });

  const adds = ops.filter((op) => op.kind === "add").length;
  const updates = ops.filter((op) => op.kind === "update").length;
  const moves = ops.filter((op) => op.kind === "move").length;
  const deletes = ops.filter((op) => op.kind === "delete").length;

  if (ops.length === 0) {
    return {
      output: "Procedural run produced no scene changes.",
      metadata: {
        method: "procedural.run",
        recipeId: parsed.recipeId,
        scriptName,
        adds: 0,
        updates: 0,
        moves: 0,
        deletes: 0,
      },
    };
  }

  const approval = await ctx.approve({
    permission: "write",
    toolName: TOOL_NAME,
    description: `Run procedural script "${scriptName}" (+${adds} / ~${updates} / >${moves} / -${deletes} node${
      adds + updates + moves + deletes === 1 ? "" : "s"
    })`,
    details: {
      recipeId: parsed.recipeId,
      scriptRef: parsed.scriptRef,
      targetGuid,
      adds,
      updates,
      moves,
      deletes,
    },
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
          recipeId: parsed.recipeId,
          scriptRef: parsed.scriptRef,
          scriptName,
          adds: result.addCount,
          updates: result.updateCount,
          moves: result.moveCount,
          deletes: result.deleteCount,
          skippedDeletes: result.skippedDeletes,
          addedGuids: result.addedGuids,
          movedGuids: result.movedGuids,
          warnings: result.warnings,
          info: result.info,
        },
        null,
        2,
      ),
      metadata: {
        method: "procedural.run",
        recipeId: parsed.recipeId,
        scriptRef: parsed.scriptRef,
        scriptName,
        targetGuid,
        addCount: result.addCount,
        updateCount: result.updateCount,
        moveCount: result.moveCount,
        deleteCount: result.deleteCount,
        addedGuids: result.addedGuids,
        updatedGuids: result.updatedGuids,
        movedGuids: result.movedGuids,
        deletedGuids: result.deletedGuids,
        skippedDeletes: result.skippedDeletes,
        ...(result.warnings.length > 0 && { warnings: result.warnings }),
        ...(result.info.length > 0 && { info: result.info }),
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
      "Run a reusable OVERDARE procedural Luau recipe against the current scene and apply the result. " +
      "PREFER THIS over hand-placing/moving instances one-by-one whenever the work is algorithmic, parametric, or " +
      "rule-based: grids/rings/arcs/stairs/symmetry, repeated or math-driven placement, or bulk transforms across " +
      "many existing objects (e.g. 'shift/scale/recolor/delete every X'). It runs deterministically and is " +
      "re-runnable, so the same script reproduces the same scene. Reach for studiorpc_instance_upsert/move/delete " +
      "only for a few specific, hand-picked objects. Rule of thumb: if you'd write a loop or a formula to place it, " +
      "use this tool. " +
      "The recipe is project-local host-side source at `.overdare/procedural/<id>/main.lua`. Before creating one, " +
      "search `.overdare/procedural/` and reuse an existing recipe when possible. Never create agent-authored " +
      "procedural source under an OS temp directory. Write or edit `main.lua`, then call this tool with its `id`; " +
      "if a run fails, fix the same file and rerun it. " +
      "It is host-side source, NOT a Script instance inside the Studio scene, and the applied result is scene " +
      "geometry (Model/Part instances), never a Script object. " +
      "The current scene subtree (targetGuid, or the whole Workspace) is injected as a `workspace` global so " +
      "transform scripts can read and mutate existing objects; freshly-built nodes are added. " +
      "Transforms support every property declared by the target instance's upsert schema, plus add/move/delete. " +
      "Assign `instance.Parent = parent` to reparent an existing object under an existing or same-run generated parent. " +
      "Scripts may use the injected globals (Vector3, Color3, CFrame) and dependency modules " +
      "(script.Dependencies.GeometryPrimitives / MathUtils). " +
      "The recipe decides whether to patch existing instances or destroy and recreate them. The runtime derives " +
      "add/update/move/delete ops by diffing the script's end state against the scene, previews those counts for " +
      "approval, and applies them atomically. The canonical source file remains available for later edits and runs.",
    parameters: params,
    parseArgs: (raw) => parseProceduralRunArgs(raw as Record<string, unknown>, cwd),
    async execute(args, ctx) {
      return executeProceduralRun(args as ProceduralRunArgs, ctx, cwd, writeLock);
    },
  };
}
