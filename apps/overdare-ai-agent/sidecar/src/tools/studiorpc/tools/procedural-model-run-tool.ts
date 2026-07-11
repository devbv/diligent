// @summary Run a persisted procedural model: delete the prior generation and re-apply idempotently.

import { z } from "zod";
import { runProceduralScript } from "../../../procedural";
import { readManifest, readModelScript, writeManifest } from "../../../procedural/manifest";
import type { ProceduralOp, ProceduralParameters } from "../../../procedural/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { applyProceduralOps } from "./procedural-apply";
import { findWorkspaceGuid, guidExistsInScene } from "./procedural-scene";

const TOOL_NAME = "studiorpc_procedural_model_run";

const vec3Schema = z.object({ X: z.number(), Y: z.number(), Z: z.number() }).strict();

const params = z
  .object({
    id: z.string().min(1).describe("generationId of the saved model (from studiorpc_procedural_model_list)."),
    targetGuid: z
      .string()
      .optional()
      .describe("Parent GUID for the generation. Defaults to the last parent, else the Workspace."),
    parameters: z
      .object({ Size: vec3Schema.optional(), Attributes: z.record(z.string(), z.unknown()).optional() })
      .strict()
      .optional()
      .describe("Override the model's stored generation parameters."),
  })
  .strip();

export interface ProceduralModelRunArgs {
  id: string;
  targetGuid?: string;
  parameters?: ProceduralParameters;
}

export function parseProceduralModelRunArgs(value: Record<string, unknown>): ProceduralModelRunArgs {
  const parsed = params.parse(value);
  return {
    id: parsed.id,
    targetGuid: parsed.targetGuid,
    parameters: parsed.parameters
      ? { Size: parsed.parameters.Size ?? { X: 10, Y: 10, Z: 10 }, Attributes: parsed.parameters.Attributes ?? {} }
      : undefined,
  };
}

async function executeProceduralModelRun(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const parsed = parseProceduralModelRunArgs(args);
  const manifest = readManifest(cwd, parsed.id);
  if (!manifest) {
    throw new Error(
      `No saved procedural model with id "${parsed.id}". Save one first or use studiorpc_procedural_model_list.`,
    );
  }

  const scriptSource = readModelScript(cwd, manifest);
  const parameters = parsed.parameters ?? manifest.parameters;
  const targetGuid = parsed.targetGuid ?? manifest.parentGuid ?? findWorkspaceGuid(cwd);
  if (!targetGuid) {
    throw new Error("Could not resolve a target GUID. Pass `targetGuid`, or ensure the level has a Workspace.");
  }

  // Generate mode (no scene): the model builds a fresh subtree; idempotency comes
  // from deleting the prior generation's roots first.
  const {
    ops: addOps,
    generationId,
    scriptName,
  } = await runProceduralScript({
    scriptSource,
    parameters,
    targetGuid,
  });

  const priorRoots = manifest.rootGuids ?? [];
  const existingRoots = priorRoots.filter((guid) => guidExistsInScene(cwd, guid));
  const driftedRoots = priorRoots.filter((guid) => !existingRoots.includes(guid));
  const deleteOps: ProceduralOp[] = existingRoots.map((guid) => ({ kind: "delete", guid, depth: 1 }));

  const adds = addOps.filter((op) => op.kind === "add").length;
  const priorDesc =
    existingRoots.length > 0
      ? `deletes prior generation (${existingRoots.length} root${existingRoots.length === 1 ? "" : "s"}) and `
      : "";
  const approval = await ctx.approve({
    permission: "write",
    toolName: TOOL_NAME,
    description: `Regenerate model "${scriptName}" (${generationId}): ${priorDesc}adds ${adds} node${adds === 1 ? "" : "s"}`,
    details: {
      generationId,
      targetGuid,
      priorRoots: existingRoots,
      driftedRoots,
      adds,
    },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true, method: "procedural.model.run" } };
  }

  const release = await writeLock.acquire();
  try {
    const result = await applyProceduralOps([...deleteOps, ...addOps], { targetGuid, cwd });
    writeManifest(cwd, {
      ...manifest,
      parameters,
      parentGuid: targetGuid,
      rootGuids: result.rootGuids,
      updatedAt: new Date().toISOString(),
    });

    const warnings: string[] = [];
    if (driftedRoots.length > 0) {
      warnings.push(
        `${driftedRoots.length} prior root${driftedRoots.length === 1 ? "" : "s"} no longer existed (manual edit); ` +
          "created a fresh generation instead.",
      );
    }
    return {
      output: JSON.stringify(
        {
          applied: true,
          generationId,
          scriptName,
          deletedPriorRoots: result.deletedGuids,
          adds: result.addCount,
          rootGuids: result.rootGuids,
          warnings,
        },
        null,
        2,
      ),
      metadata: {
        method: "procedural.model.run",
        generationId,
        scriptName,
        targetGuid,
        addCount: result.addCount,
        deleteCount: result.deleteCount,
        rootGuids: result.rootGuids,
        driftedRoots,
        ...(warnings.length > 0 && { warnings }),
      },
    };
  } finally {
    release();
  }
}

export function createProceduralModelRunTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: TOOL_NAME,
    description:
      "Generate a saved OVERDARE procedural model into the scene as Model/Part geometry (never a Script " +
      "instance). Looks the model up by `id`, runs its host-side Luau script with its stored (or overridden) " +
      "parameters, deletes the prior generation via the manifest, re-applies the new generation, and updates the " +
      "manifest — so repeated runs replace rather than duplicate. If the prior generation was manually removed, " +
      "it warns and creates a fresh one.",
    parameters: params,
    parseArgs: (raw) => parseProceduralModelRunArgs(raw as Record<string, unknown>),
    async execute(args, ctx) {
      return executeProceduralModelRun(args, ctx, cwd, writeLock);
    },
  };
}
