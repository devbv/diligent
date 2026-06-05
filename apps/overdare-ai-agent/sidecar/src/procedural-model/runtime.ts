// @summary Invokes the Luau procedural dummy JSON runner.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { extractProceduralScriptMetadata } from "./script-metadata";
import type { ProceduralDummyJson, ProceduralGeneratedNode, ProceduralGenerationInput } from "./types";

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

export async function generateProceduralDummyJson(
  input: ProceduralGenerationInput,
  options: ProceduralLuauRuntimeOptions = {},
): Promise<ProceduralDummyJson> {
  const metadata = extractProceduralScriptMetadata(input.scriptSource, input.scriptName);
  const luauBin = await resolveLuauExecutable(options);
  const luauDir = path.join(currentDir(), "luau");
  const normalizedInput = {
    ...input,
    parameters: {
      ...input.parameters,
      Attributes: input.parameters.Attributes ?? {},
    },
    ...metadata,
  };
  const proc = Bun.spawn([luauBin, "runner.lua", "--program-args", JSON.stringify(normalizedInput)], {
    cwd: luauDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Procedural Luau runner failed with exit code ${exitCode}.\n${stderr || stdout}`.trim());
  }

  const outputLine = stdout.split(/\r?\n/).find((line) => line.startsWith(OUTPUT_SENTINEL));
  if (!outputLine) {
    throw new Error(`Procedural Luau runner did not emit dummy JSON.\n${stderr || stdout}`.trim());
  }
  return proceduralDummyJsonSchema.parse(JSON.parse(outputLine.slice(OUTPUT_SENTINEL.length))) as ProceduralDummyJson;
}
