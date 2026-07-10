// @summary Invokes the Luau procedural runner (generate + transform).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assertInputWithinArgvLimit,
  assertNodeCountWithinLimit,
  type ProceduralLimits,
  resolveLimits,
  spawnLuauCaptured,
} from "./limits";
import { deriveProceduralOps } from "./ops";
import { extractProceduralScriptMetadata } from "./script-metadata";
import type {
  ProceduralDummyJson,
  ProceduralGeneratedNode,
  ProceduralGenerationInput,
  ProceduralSerializedNode,
  RunProceduralScriptInput,
  RunProceduralScriptResult,
} from "./types";

const vector3Schema = z.object({ X: z.number(), Y: z.number(), Z: z.number() }).strict();
const color3Schema = z.object({ R: z.number(), G: z.number(), B: z.number() }).strict();
const cframeSchema = z.object({ Position: vector3Schema, Orientation: vector3Schema }).strict();
const modelPropertiesSchema = z.object({ WorldPivot: cframeSchema.optional() }).strict();
const partPropertiesSchema = z
  .object({
    Shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
    CFrame: cframeSchema.optional(),
    Size: vector3Schema.optional(),
    Anchored: z.boolean().optional(),
    CanCollide: z.boolean().optional(),
    CanQuery: z.boolean().optional(),
    CanTouch: z.boolean().optional(),
    CastShadow: z.boolean().optional(),
    CollisionGroup: z.string().optional(),
    Color: color3Schema.optional(),
    Locked: z.boolean().optional(),
    Mass: z.number().optional(),
    Massless: z.boolean().optional(),
    Material: z.string().optional(),
    MaterialVariant: z.string().optional(),
    Reflectance: z.number().optional(),
    RootPriority: z.number().optional(),
    Transparency: z.number().optional(),
  })
  .strict();

const proceduralGeneratedNodeSchema: z.ZodType<ProceduralGeneratedNode> = z.lazy(() =>
  z.union([
    z
      .object({
        class: z.literal("Model"),
        name: z.string(),
        properties: modelPropertiesSchema,
        children: z.array(proceduralGeneratedNodeSchema).optional(),
      })
      .strict(),
    z
      .object({
        class: z.literal("Part"),
        name: z.string(),
        properties: partPropertiesSchema,
        children: z.array(proceduralGeneratedNodeSchema).optional(),
      })
      .strict(),
  ]),
);

const proceduralDummyJsonSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("overdare.procedural-dummy-json"),
    generationId: z.string(),
    scriptName: z.string(),
    parameters: z.object({ Size: vector3Schema, Attributes: z.record(z.string(), z.unknown()).optional() }).strict(),
    children: z.array(proceduralGeneratedNodeSchema),
  })
  .strict();

export interface ProceduralLuauRuntimeOptions {
  luauBin?: string;
  limits?: Partial<ProceduralLimits>;
}

const VENDORED_LUAU_VERSION = "0.723";
const OUTPUT_SENTINEL = "__OVDR_PROCEDURAL_JSON__";

function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function sidecarDir(): string {
  return path.resolve(currentDir(), "..", "..");
}

function platformLuauBinaryName(): string {
  return process.platform === "win32" ? "luau.exe" : "luau";
}

function vendoredPlatformName(): string | undefined {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return undefined;
}

function vendoredLuauPath(): string | undefined {
  const platformName = vendoredPlatformName();
  if (!platformName) return undefined;
  return path.join(sidecarDir(), "vendor", "luau", VENDORED_LUAU_VERSION, platformName, platformLuauBinaryName());
}

export async function resolveLuauExecutable(options: ProceduralLuauRuntimeOptions = {}): Promise<string> {
  const candidates = [options.luauBin, process.env.OVDR_LUAU_BIN, process.env.LUAU_BIN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    return candidate;
  }
  const vendoredPath = vendoredLuauPath();
  if (vendoredPath) return vendoredPath;
  const luauPath = Bun.which("luau");
  if (luauPath) return luauPath;
  throw new Error("Luau executable not found. Set OVDR_LUAU_BIN or LUAU_BIN, or install a `luau` executable on PATH.");
}

interface RawRunnerOutput {
  version: number;
  kind: string;
  generationId: string;
  scriptName: string;
  parameters: unknown;
  children: ProceduralSerializedNode[];
}

/**
 * Spawns the Luau runner for the given normalized input and returns the parsed
 * runner output. Enforces the argv-transport size guard and subprocess
 * guardrails (timeout / max output bytes).
 */
async function runLuauProgram(
  normalizedInput: Record<string, unknown>,
  options: ProceduralLuauRuntimeOptions,
): Promise<RawRunnerOutput> {
  const limits = resolveLimits(options.limits);
  const luauBin = await resolveLuauExecutable(options);
  const luauDir = path.join(currentDir(), "luau");
  const encodedInput = JSON.stringify(normalizedInput);
  assertInputWithinArgvLimit(encodedInput, limits);

  const { stdout, stderr, exitCode } = await spawnLuauCaptured(
    luauBin,
    ["runner.lua", "--program-args", encodedInput],
    {
      cwd: luauDir,
      limits,
    },
  );

  if (exitCode !== 0) {
    throw new Error(`Procedural Luau runner failed with exit code ${exitCode}.\n${stderr || stdout}`.trim());
  }

  const outputLine = stdout.split(/\r?\n/).find((line) => line.startsWith(OUTPUT_SENTINEL));
  if (!outputLine) {
    throw new Error(`Procedural Luau runner did not emit output.\n${stderr || stdout}`.trim());
  }
  return JSON.parse(outputLine.slice(OUTPUT_SENTINEL.length)) as RawRunnerOutput;
}

export async function generateProceduralDummyJson(
  input: ProceduralGenerationInput,
  options: ProceduralLuauRuntimeOptions = {},
): Promise<ProceduralDummyJson> {
  const metadata = extractProceduralScriptMetadata(input.scriptSource, input.scriptName);
  const normalizedInput = {
    ...input,
    parameters: {
      ...input.parameters,
      Attributes: input.parameters.Attributes ?? {},
    },
    ...metadata,
  };
  const raw = await runLuauProgram(normalizedInput, options);
  assertNodeCountWithinLimit(raw.children, resolveLimits(options.limits));
  return proceduralDummyJsonSchema.parse(raw) as ProceduralDummyJson;
}

/**
 * Runs a procedural script and returns the derived scene ops (add/update/delete).
 *
 * With no `scene`, the script is a pure generator and every node is an `add`.
 * With a `scene`, transform mutations are derived by diffing the injected
 * snapshot against the runner's serialized end state.
 */
export async function runProceduralScript(
  input: RunProceduralScriptInput,
  options: ProceduralLuauRuntimeOptions = {},
): Promise<RunProceduralScriptResult> {
  const metadata = extractProceduralScriptMetadata(input.scriptSource, input.scriptName, {
    autoGenerationId: input.autoGenerationId,
  });
  const normalizedInput: Record<string, unknown> = {
    scriptSource: input.scriptSource,
    parameters: {
      ...input.parameters,
      Attributes: input.parameters.Attributes ?? {},
    },
    ...metadata,
    ...(input.scene ? { scene: input.scene } : {}),
  };
  const raw = await runLuauProgram(normalizedInput, options);
  const nodeCount = assertNodeCountWithinLimit(raw.children, resolveLimits(options.limits));
  const ops = deriveProceduralOps(raw.children, input.scene, input.targetGuid);
  return { generationId: metadata.generationId, scriptName: metadata.scriptName, ops, nodeCount };
}
