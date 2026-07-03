import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { loadOverdareConfig } from "./config";
import { buildValidateLuaRender } from "./render";

type ToolRenderPayload = {
  inputSummary?: string;
  outputSummary?: string;
  blocks: Array<Record<string, unknown>>;
};

const execFileAsync = promisify(execFile);

// ── .ovdrjm helpers (minimal subset) ─────────────────────────────────────────

type OvdrjmNode = Record<string, unknown> & {
  ActorGuid?: unknown;
  LuaChildren?: unknown;
};

function findNodeByActorGuid(node: OvdrjmNode, targetGuid: string): OvdrjmNode | undefined {
  if (typeof node.ActorGuid === "string" && node.ActorGuid === targetGuid) return node;
  if (!Array.isArray(node.LuaChildren)) return undefined;
  for (const child of node.LuaChildren) {
    if (typeof child !== "object" || child === null) continue;
    const found = findNodeByActorGuid(child as OvdrjmNode, targetGuid);
    if (found) return found;
  }
  return undefined;
}

function collectAllScripts(node: OvdrjmNode): OvdrjmNode[] {
  const result: OvdrjmNode[] = [];
  const instanceType = typeof node.InstanceType === "string" ? node.InstanceType : undefined;
  if (instanceType && SCRIPT_CLASSES.has(instanceType)) {
    result.push(node);
  }
  if (Array.isArray(node.LuaChildren)) {
    for (const child of node.LuaChildren) {
      if (typeof child === "object" && child !== null) {
        result.push(...collectAllScripts(child as OvdrjmNode));
      }
    }
  }
  return result;
}

function readOvdrjmRoot(cwd: string): OvdrjmNode {
  const entries = readdirSync(cwd, { withFileTypes: true });
  const umapFile = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(".umap"));
  if (!umapFile) throw new Error("No .umap file found in current working directory.");
  const ovdrjmPath = join(cwd, umapFile.name.replace(/\.umap$/i, ".ovdrjm"));
  const buf = readFileSync(ovdrjmPath);
  const raw = buf[0] === 0xff && buf[1] === 0xfe ? new TextDecoder("utf-16le").decode(buf) : buf.toString("utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const root = parsed.Root;
  if (typeof root !== "object" || root === null) throw new Error("Invalid .ovdrjm format: Root object is missing.");
  return root as OvdrjmNode;
}

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureSetupFiles(dir: string): Promise<string> {
  const luaurcPath = join(dir, ".luaurc");
  if (!existsSync(luaurcPath)) {
    await writeFile(luaurcPath, JSON.stringify({ languageMode: "strict" }, null, 2), "utf-8");
  }
  const sourcemapPath = join(dir, "sourcemap.temp.json");
  if (!existsSync(sourcemapPath)) {
    await writeFile(
      sourcemapPath,
      JSON.stringify({ name: "THIS_IS_TEMPORAL_SOURCEMAP", className: "DataModel" }, null, 2),
      "utf-8",
    );
  }
  return sourcemapPath;
}

const IGNORED_PATTERNS = [
  "[INFO]",
  "'Instance'",
  "Unknown require",
  "Argument count mismatch",
  "Unknown type used in",
  "Expected this to be",
  "Expected type",
  "but got 'nil'",
  "could be nil",
  "Cannot call a value of type nil",
  "Type 'nil'",
  "cannot be compared",
  "not found in table",
  "not compatible with type",
  "does not have key",
];

// Matches a luau-lsp diagnostic header like `File.lua(39,1):`. A diagnostic may
// span several lines (a header followed by continuation lines), so a header marks
// the start of a new record.
const DIAGNOSTIC_HEADER = /\(\d+,\d+\):/;

// Groups raw output into diagnostic records. Lines without a header are treated
// as continuation of the previous record, so multi-line messages stay intact
// instead of being split (and partially dropped) on every newline.
export function splitDiagnostics(raw: string): string[] {
  const records: string[] = [];
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    if (DIAGNOSTIC_HEADER.test(line) && current.length > 0) {
      records.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) records.push(current.join("\n"));
  return records;
}

function filterOutput(raw: string): string {
  return (
    splitDiagnostics(raw)
      .filter((record) => record.trim())
      // Classify the whole record (not individual lines) so a multi-line message
      // is dropped as a unit.
      .filter((record) => !IGNORED_PATTERNS.some((p) => record.includes(p)))
      .join("\n")
      .trim()
  );
}

// ── Bundled asset path resolution ────────────────────────────────────────────

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((candidate) => existsSync(candidate));
}

function getRuntimeAssetPath(kind: "bin" | "lua", name: string): string | undefined {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const sidecarRoot = path.resolve(moduleDir, "../../..");
  return firstExistingPath([
    path.join(path.dirname(process.execPath), "assets", kind, name),
    path.join(sidecarRoot, "assets", kind, name),
  ]);
}

// ── Config resolution ────────────────────────────────────────────────────────

function resolveLuauLspPath(): string {
  if (process.env.LUAU_LSP_PATH) return process.env.LUAU_LSP_PATH;
  const cfg = loadOverdareConfig();
  if (cfg.luauLspPath) return cfg.luauLspPath;
  const bin = process.platform === "win32" ? "luau-lsp.exe" : "luau-lsp";
  return getRuntimeAssetPath("bin", bin) ?? "luau-lsp";
}

function resolveTypesPath(): string | undefined {
  if (process.env.OVERDARE_TYPES_PATH) return process.env.OVERDARE_TYPES_PATH;
  const cfg = loadOverdareConfig();
  if (cfg.typesPath) return cfg.typesPath;
  return getRuntimeAssetPath("lua", "overdare-types.d.lua");
}

// ── Exported tool shape ──────────────────────────────────────────────────────

export const name = "validatelua";

export const description = `Validates Luau script code for type errors and lint warnings using luau-lsp analyze.

Takes \`targetGuids\` — an array of script GUIDs to validate. If omitted, validates ALL scripts in the level.
Reads script Source from the .ovdrjm level file, writes to temp files, runs luau-lsp, and returns results.

Returns the luau-lsp analyze output grouped per script. If no issues are found, returns "[OK] ScriptName" per script.

Among the reported errors, Instance property-related errors are critical and must be addressed. Other errors are generally less important and can be deprioritized.`;

export const parameters = z.object({
  targetGuids: z
    .array(z.string())
    .optional()
    .describe("GUIDs of scripts to validate. If omitted, validates all scripts in the level."),
});

type Params = z.infer<typeof parameters>;

interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  approve: (req: {
    permission: "read" | "write" | "execute";
    toolName: string;
    description: string;
    details?: Record<string, unknown>;
  }) => Promise<"once" | "always" | "reject">;
}

interface ToolResult {
  output: string;
  render?: ToolRenderPayload;
  metadata?: Record<string, unknown>;
}

interface ScriptInfo {
  guid: string;
  name: string;
  source: string;
}

function resolveScripts(cwd: string, targetGuids?: string[]): ScriptInfo[] {
  const root = readOvdrjmRoot(cwd);

  if (!targetGuids || targetGuids.length === 0) {
    // Validate all scripts
    const allScripts = collectAllScripts(root);
    return allScripts.map((node) => ({
      guid: typeof node.ActorGuid === "string" ? node.ActorGuid : "",
      name: typeof node.Name === "string" ? node.Name : "unnamed",
      source: typeof node.Source === "string" ? node.Source : "",
    }));
  }

  // Validate specific GUIDs
  const scripts: ScriptInfo[] = [];
  for (const guid of targetGuids) {
    const target = findNodeByActorGuid(root, guid);
    if (!target) throw new Error(`ActorGuid not found: ${guid}`);
    const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
    if (!instanceType || !SCRIPT_CLASSES.has(instanceType)) {
      throw new Error(`Instance ${guid} is ${instanceType ?? "unknown"}, not a script.`);
    }
    scripts.push({
      guid,
      name: typeof target.Name === "string" ? target.Name : "unnamed",
      source: typeof target.Source === "string" ? target.Source : "",
    });
  }
  return scripts;
}

export async function execute(args: Params, ctx: ToolContext, cwd: string): Promise<ToolResult> {
  const approval = await ctx.approve({
    permission: "execute",
    toolName: name,
    description: `Validate Luau: ${args.targetGuids?.length ?? "all"} script(s)`,
    details: { targetGuids: args.targetGuids },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  const luauLspPath = resolveLuauLspPath();
  const typesPath = resolveTypesPath();

  // Verify luau-lsp is available
  try {
    await execFileAsync(luauLspPath, ["--version"]);
  } catch {
    throw new Error(
      `luau-lsp not found at: ${luauLspPath}\n` +
        `Set the LUAU_LSP_PATH environment variable or install luau-lsp.\n` +
        `Download: https://github.com/JohnnyMorganz/luau-lsp/releases`,
    );
  }

  // Verify type definitions if provided
  if (typesPath) {
    try {
      await access(typesPath);
    } catch {
      throw new Error(
        `Type definitions file not found: ${typesPath}\n` +
          `Set the OVERDARE_TYPES_PATH environment variable to the correct path.`,
      );
    }
  }

  // Resolve scripts from .ovdrjm
  let scripts: ScriptInfo[];
  try {
    scripts = resolveScripts(cwd, args.targetGuids);
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  }

  if (scripts.length === 0) {
    return {
      output: "No scripts found in the level.",
      render: buildValidateLuaRender("(no scripts)", "No scripts found in the level."),
      metadata: { fileCount: 0, issueCount: 0 },
    };
  }

  // Write scripts to temp directory
  const tempDir = await mkdtemp(join(tmpdir(), "validatelua-"));
  try {
    // Map: temp file path → ScriptInfo
    const fileToScript = new Map<string, ScriptInfo>();
    const luaFiles: string[] = [];

    for (const script of scripts) {
      const fileName = `${script.guid}.lua`;
      const filePath = join(tempDir, fileName);
      await writeFile(filePath, script.source, "utf-8");
      fileToScript.set(filePath, script);
      luaFiles.push(filePath);
    }

    // Setup luaurc and sourcemap in temp dir
    const sourcemapPath = await ensureSetupFiles(tempDir);

    // Build luau-lsp analyze arguments
    const analyzeArgs = ["analyze", "--sourcemap", sourcemapPath];
    if (typesPath) {
      analyzeArgs.push("--definitions", typesPath);
    }
    analyzeArgs.push(...luaFiles);

    // Run analysis
    const { stdout, stderr } = await execFileAsync(luauLspPath, analyzeArgs).catch(
      (error: { stdout?: string; stderr?: string }) => ({
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );

    const rawOutput = filterOutput([stdout, stderr].filter(Boolean).join("\n"));

    // ── Single script ──────────────────────────────────────────────────────────
    if (scripts.length === 1) {
      const script = scripts[0];
      const label = `${script.name} [${script.guid}]`;
      // Replace temp file paths with script name in output
      const output = rawOutput ? rawOutput.replaceAll(luaFiles[0], label) : "No issues found. Code is valid.";
      const issueCount = rawOutput ? splitDiagnostics(rawOutput).filter((r) => r.trim()).length : 0;
      return {
        output,
        render: buildValidateLuaRender(label, output, { issueCount }),
        metadata: { fileCount: 1, issueCount, scripts: [{ guid: script.guid, name: script.name }] },
      };
    }

    // ── Multi-script: group output lines per script ────────────────────────────
    const fileIssues = new Map<string, string[]>();
    // Build a filename → full-path lookup so we can match regardless of path
    // separators (luau-lsp may emit forward slashes even on Windows).
    const fileNameToPath = new Map<string, string>();
    for (const file of luaFiles) {
      fileIssues.set(file, []);
      fileNameToPath.set(path.basename(file), file);
    }

    for (const record of splitDiagnostics(rawOutput)) {
      if (!record.trim()) continue;
      // Match on the record's header line (first line) for the full-path case,
      // then fall back to a filename match anywhere in the record.
      const header = record.split("\n", 1)[0];
      let matched = false;
      for (const file of luaFiles) {
        if (header.startsWith(`${file}(`) || header.startsWith(`${file}:`)) {
          fileIssues.get(file)!.push(record);
          matched = true;
          break;
        }
      }
      if (!matched) {
        for (const [fileName, filePath] of fileNameToPath) {
          if (record.includes(fileName)) {
            fileIssues.get(filePath)!.push(record);
            break;
          }
        }
      }
    }

    let totalIssues = 0;
    const sections: string[] = [];

    for (const file of luaFiles) {
      const script = fileToScript.get(file)!;
      const issues = fileIssues.get(file)!;
      const label = `${script.name} [${script.guid}]`;
      if (issues.length === 0) {
        sections.push(`[OK] ${label}`);
      } else {
        totalIssues += issues.length;
        const fileName = path.basename(file);
        const mappedIssues = issues.map((record) => record.replaceAll(file, label).replaceAll(fileName, label));
        sections.push(`[${issues.length} issue(s)] ${label}\n${mappedIssues.join("\n")}`);
      }
    }

    sections.push(`\n--- ${scripts.length} script(s) checked, ${totalIssues} issue(s) found ---`);

    const output = sections.join("\n\n");
    return {
      output,
      render: buildValidateLuaRender(`${scripts.length} scripts`, output, { issueCount: totalIssues }),
      metadata: {
        fileCount: scripts.length,
        issueCount: totalIssues,
        scripts: scripts.map((s) => ({ guid: s.guid, name: s.name })),
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
