// @summary Persist a procedural model: write its script + manifest after a dry-run validation.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { runProceduralScript } from "../../../procedural";
import {
  type ProceduralModelManifest,
  readManifest,
  writeManifest,
  writeModelScript,
} from "../../../procedural/manifest";
import { extractProceduralScriptMetadata } from "../../../procedural/script-metadata";
import type { ProceduralParameters } from "../../../procedural/types";
import type { Tool, ToolContext, ToolResult } from "../types";

const TOOL_NAME = "studiorpc_procedural_model_save";
const DEFAULT_SIZE = { X: 10, Y: 10, Z: 10 } as const;

const vec3Schema = z.object({ X: z.number(), Y: z.number(), Z: z.number() }).strict();

const params = z
  .object({
    script: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Inline Luau procedural script source, executed host-side (NOT a Script instance in the Studio scene). " +
          "Return a table with OnGenerate(parameters, targetContainer). Injected globals: Vector3, Color3, CFrame. " +
          "Available modules: require(script.Dependencies.GeometryPrimitives) and " +
          "require(script.Dependencies.MathUtils). See the procedural-luau-json skill for the full API.",
      ),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute or project-relative path to a .lua procedural script file on disk (host-side source, NOT a " +
          "Studio scene Script). Same Luau surface as `script`.",
      ),
    parameters: z
      .object({ Size: vec3Schema.optional(), Attributes: z.record(z.string(), z.unknown()).optional() })
      .strict()
      .optional()
      .describe("Default generation parameters stored with the model."),
  })
  .strip();

export interface ProceduralModelSaveArgs {
  scriptSource: string;
  parameters: ProceduralParameters;
}

function resolveScriptPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export function parseProceduralModelSaveArgs(value: Record<string, unknown>, cwd: string): ProceduralModelSaveArgs {
  const parsed = params.parse(value);
  if (!parsed.script === !parsed.scriptPath) {
    throw new Error("Provide exactly one of `script` (inline) or `scriptPath` (file).");
  }
  const scriptSource = parsed.script ?? readFileSync(resolveScriptPath(cwd, parsed.scriptPath as string), "utf8");
  return {
    scriptSource,
    parameters: {
      Size: parsed.parameters?.Size ?? { ...DEFAULT_SIZE },
      Attributes: parsed.parameters?.Attributes ?? {},
    },
  };
}

// `parsed` is already the output of parseArgs; do NOT re-parse (see the note in
// procedural-run-tool.ts — parseProceduralModelSaveArgs maps script/scriptPath ->
// scriptSource and is not idempotent).
async function executeProceduralModelSave(
  parsed: ProceduralModelSaveArgs,
  ctx: ToolContext,
  cwd: string,
): Promise<ToolResult> {
  // generationId is the model's stable identity — required for persisted models.
  const { generationId, scriptName } = extractProceduralScriptMetadata(parsed.scriptSource, undefined, {
    autoGenerationId: false,
  });

  // Dry-run: execute the script (no scene) so an invalid script fails at save time.
  const dryRun = await runProceduralScript({ scriptSource: parsed.scriptSource, parameters: parsed.parameters });
  const nodeCount = dryRun.nodeCount;

  const approval = await ctx.approve({
    permission: "write",
    toolName: TOOL_NAME,
    description: `Save procedural model "${scriptName}" (${generationId})`,
    details: { generationId, scriptName, nodeCount, parameters: parsed.parameters },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true, method: "procedural.model.save" } };
  }

  const existing = readManifest(cwd, generationId);
  const scriptPath = writeModelScript(cwd, generationId, parsed.scriptSource);
  const manifest: ProceduralModelManifest = {
    version: 1,
    generationId,
    scriptName,
    scriptPath,
    parameters: parsed.parameters,
    // Preserve the prior generation link so the next model_run can still replace it.
    parentGuid: existing?.parentGuid,
    rootGuids: existing?.rootGuids ?? [],
    updatedAt: new Date().toISOString(),
  };
  writeManifest(cwd, manifest);

  return {
    output: JSON.stringify({ saved: true, generationId, scriptName, scriptPath, nodeCount }, null, 2),
    metadata: { method: "procedural.model.save", generationId, scriptName, scriptPath, nodeCount },
  };
}

export function createProceduralModelSaveTool(cwd: string): Tool {
  return {
    name: TOOL_NAME,
    description:
      "Persist a reusable OVERDARE procedural model. The script is host-side Luau source (inline `script` or an " +
      "external `.lua` file via `scriptPath`), NOT a Script instance in the Studio scene. Writes the script to " +
      "the project's .overdare/procedural/scripts and records a manifest keyed by the script's required " +
      "`-- generationId:` comment. Validates the script with a dry-run (no scene changes). " +
      "Use studiorpc_procedural_model_run to generate it into the scene as Model/Part geometry.",
    parameters: params,
    parseArgs: (raw) => parseProceduralModelSaveArgs(raw as Record<string, unknown>, cwd),
    async execute(args, ctx) {
      return executeProceduralModelSave(args as ProceduralModelSaveArgs, ctx, cwd);
    },
  };
}
