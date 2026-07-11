// @summary Invokes the Luau procedural runner (generate + transform).

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assertGeneratedNodeCountWithinLimit,
  assertInputWithinLimit,
  assertNodeCountWithinLimit,
  type ProceduralLimits,
  resolveLimits,
  spawnLuauCaptured,
} from "./limits";
import { deriveProceduralOps } from "./ops";
import { extractProceduralScriptName } from "./script-metadata";
import type {
  ProceduralDummyJson,
  ProceduralGeneratedNode,
  ProceduralGenerationInput,
  ProceduralSerializedNode,
  RunProceduralScriptInput,
  RunProceduralScriptResult,
} from "./types";

const vector3Schema = z.object({ X: z.number(), Y: z.number(), Z: z.number() }).strict();
const proceduralGeneratedNodeSchema: z.ZodType<ProceduralGeneratedNode> = z.lazy(() =>
  z
    .object({
      class: z.string(),
      name: z.string(),
      localId: z.string().min(1),
      properties: z.record(z.string(), z.unknown()),
      children: z.array(proceduralGeneratedNodeSchema).optional(),
    })
    .strict(),
);

const proceduralDummyJsonSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("overdare.procedural-dummy-json"),
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

/**
 * In a compiled/packaged sidecar the interpreter ships beside the executable
 * under `assets/bin` (populated per-target by build-overdare-sidecar.ts), since
 * `import.meta.url` no longer resolves to the source `vendor/` tree there.
 */
function packagedLuauPath(): string {
  return path.join(path.dirname(process.execPath), "assets", "bin", platformLuauBinaryName());
}

/**
 * Resolves the directory that holds `runner.lua` and its Luau dependencies
 * (`json.lua`, `ovdr-shim.lua`, `dependencies/*.lua`). The runner is executed by
 * an external `luau` subprocess, so it must live on real disk.
 *
 * In a compiled sidecar `import.meta.url` resolves into Bun's embedded virtual
 * filesystem (e.g. `B:\~BUN\root\...`), which the subprocess cannot read, so the
 * tree is staged beside the executable under `assets/lua/procedural` (populated
 * by build-overdare-sidecar.ts). In the dev/source tree it lives next to this
 * module under `luau/`.
 */
function resolveLuauRunnerDir(): string {
  const packaged = path.join(path.dirname(process.execPath), "assets", "lua", "procedural");
  if (existsSync(path.join(packaged, "runner.lua"))) return packaged;
  return path.join(currentDir(), "luau");
}

export async function resolveLuauExecutable(options: ProceduralLuauRuntimeOptions = {}): Promise<string> {
  const explicit = [options.luauBin, process.env.OVDR_LUAU_BIN, process.env.LUAU_BIN].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (explicit) return explicit;

  // Packaged build: interpreter next to the executable.
  const packaged = packagedLuauPath();
  if (existsSync(packaged)) return packaged;

  // Dev / source tree: per-platform vendored binary.
  const vendored = vendoredLuauPath();
  if (vendored && existsSync(vendored)) return vendored;

  const onPath = Bun.which("luau");
  if (onPath) return onPath;
  throw new Error("Luau executable not found. Set OVDR_LUAU_BIN or LUAU_BIN, or install a `luau` executable on PATH.");
}

interface RawRunnerOutput {
  version: number;
  kind: string;
  scriptName: string;
  parameters: unknown;
  children: ProceduralSerializedNode[];
  sceneRoot?: ProceduralSerializedNode;
}

function toLuaLongString(value: string): string {
  let equals = "";
  while (value.includes(`]${equals}]`)) equals += "=";
  return `[${equals}[${value}]${equals}]`;
}

function stageLuauExecution(luauDir: string, encodedInput: string, scriptSource: string): string {
  const executionDir = mkdtempSync(path.join(tmpdir(), "overdare-procedural-"));
  try {
    cpSync(luauDir, executionDir, { recursive: true });
    writeFileSync(path.join(executionDir, "procedural-input.lua"), `return ${toLuaLongString(encodedInput)}\n`, "utf8");
    writeFileSync(
      path.join(executionDir, "procedural-script-source.lua"),
      `return ${toLuaLongString(scriptSource)}\n`,
      "utf8",
    );
    return executionDir;
  } catch (error) {
    rmSync(executionDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Spawns the Luau runner for the given normalized input and returns the parsed
 * runner output. The complete input is staged in a unique temporary Luau
 * module so process argv stays small regardless of script or scene size.
 */
async function runLuauProgram(
  normalizedInput: Record<string, unknown>,
  options: ProceduralLuauRuntimeOptions,
): Promise<RawRunnerOutput> {
  const limits = resolveLimits(options.limits);
  const luauBin = await resolveLuauExecutable(options);
  const luauDir = resolveLuauRunnerDir();
  const scriptSource = normalizedInput.scriptSource;
  if (typeof scriptSource !== "string") {
    throw new Error("Procedural runner input is missing scriptSource.");
  }
  const encodedInput = JSON.stringify({
    ...normalizedInput,
    scriptSource: undefined,
    scriptSourceModule: "./procedural-script-source",
  });
  assertInputWithinLimit(encodedInput, limits, Buffer.byteLength(scriptSource, "utf8"));
  const executionDir = stageLuauExecution(luauDir, encodedInput, scriptSource);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    ({ stdout, stderr, exitCode } = await spawnLuauCaptured(
      luauBin,
      ["runner.lua", "--program-args", "--input-module=./procedural-input"],
      {
        cwd: executionDir,
        limits,
      },
    ));
  } finally {
    rmSync(executionDir, { recursive: true, force: true });
  }

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
  const scriptName = extractProceduralScriptName(input.scriptSource, input.scriptName);
  const normalizedInput = {
    ...input,
    parameters: {
      ...input.parameters,
      Attributes: input.parameters.Attributes ?? {},
    },
    scriptName,
  };
  const raw = await runLuauProgram(normalizedInput, options);
  assertNodeCountWithinLimit(raw.children, resolveLimits(options.limits));
  return proceduralDummyJsonSchema.parse(raw) as ProceduralDummyJson;
}

/**
 * Runs a procedural script and returns the derived scene ops (add/update/move/delete).
 *
 * With no `scene`, the script is a pure generator and every node is an `add`.
 * With a `scene`, transform mutations are derived by diffing the injected
 * snapshot against the runner's serialized end state.
 */
export async function runProceduralScript(
  input: RunProceduralScriptInput,
  options: ProceduralLuauRuntimeOptions = {},
): Promise<RunProceduralScriptResult> {
  const scriptName = extractProceduralScriptName(input.scriptSource, input.scriptName);
  const normalizedInput: Record<string, unknown> = {
    scriptSource: input.scriptSource,
    parameters: {
      ...input.parameters,
      Attributes: input.parameters.Attributes ?? {},
    },
    scriptName,
    ...(input.scene ? { scene: input.scene } : {}),
  };
  const raw = await runLuauProgram(normalizedInput, options);
  const nodeCount = assertGeneratedNodeCountWithinLimit(raw.children, resolveLimits(options.limits));
  if (input.scene && !raw.sceneRoot) {
    throw new Error(`Protected procedural target root ${input.scene.guid} cannot be destroyed.`);
  }
  const ops = deriveProceduralOps(raw.children, input.scene, input.targetGuid, raw.sceneRoot);
  return { scriptName, ops, nodeCount };
}
