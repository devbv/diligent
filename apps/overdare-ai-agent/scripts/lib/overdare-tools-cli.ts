import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import type { BundledToolProvider } from "@diligent/runtime";
import { createStudioRpcToolProvider } from "../../sidecar/src/tools/studiorpc";
import { createValidatorToolProvider } from "../../sidecar/src/tools/validator";

type CliBundledToolProvider = Pick<BundledToolProvider, "id" | "createTools">;

type ToolEntry = {
  tool: Tool;
  source: string;
  version: string;
};

export interface CliStreams {
  stdout: Pick<typeof console, "log"> & { write?: (text: string) => void };
  stderr: Pick<typeof console, "error"> & { write?: (text: string) => void };
}

export interface ParsedCliArgs {
  command: "list" | "inspect" | "run" | "help";
  toolName?: string;
  args?: string;
  argsFile?: string;
  cwd: string;
  json: boolean;
  yes: boolean;
}

const bundledToolProviders: CliBundledToolProvider[] = [createStudioRpcToolProvider(), createValidatorToolProvider()];

function bundledProviderSource(id: string): string {
  return id
    .replace(/^@[^/]+\//, "")
    .replace(/-tools$/, "")
    .replace(/-hooks$/, "");
}

export async function loadOverdareTools(cwd: string): Promise<Map<string, ToolEntry>> {
  const registry = new Map<string, ToolEntry>();
  for (const provider of bundledToolProviders) {
    const source = bundledProviderSource(provider.id);
    const tools = await provider.createTools({ cwd });
    for (const tool of tools) {
      registry.set(tool.name, { tool, source, version: "built-in" });
    }
  }
  return registry;
}

export function parseCliArgs(argv: string[], cwd = process.cwd()): ParsedCliArgs {
  const [rawCommand, rawToolName, ...rest] = argv;
  const command = (rawCommand ?? "help") as ParsedCliArgs["command"];
  let args: string | undefined;
  let argsFile: string | undefined;
  let nextCwd = cwd;
  let json = false;
  let yes = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--args") args = rest[++index];
    else if (token === "--args-file") argsFile = rest[++index];
    else if (token === "--cwd") nextCwd = resolve(rest[++index] ?? cwd);
    else if (token === "--json") json = true;
    else if (token === "--yes" || token === "--yolo") yes = true;
    else throw new Error(`Unknown option: ${token}`);
  }

  if (!["list", "inspect", "run", "help"].includes(command)) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }

  return { command, toolName: rawToolName, args, argsFile, cwd: nextCwd, json, yes };
}

export async function resolveToolArgs(parsed: ParsedCliArgs): Promise<unknown> {
  if (parsed.args && parsed.argsFile) {
    throw new Error("Use either --args or --args-file, not both.");
  }
  if (parsed.argsFile) {
    const content = await readFile(resolve(parsed.argsFile), "utf-8");
    return content.trim() ? JSON.parse(content) : {};
  }
  if (parsed.args) {
    return JSON.parse(parsed.args);
  }
  return {};
}

function printUsage(streams: CliStreams): void {
  streams.stdout.log(`OVERDARE tool CLI

Usage:
  overdare-tools list
  overdare-tools inspect <tool-name>
  overdare-tools run <tool-name> [--args '<json>' | --args-file <file>] [--json] [--yes] [--cwd <path>]

Examples:
  overdare-tools list
  overdare-tools inspect studiorpc_level_browse
  overdare-tools run validatelua --args '{"source":"print(1)"}'
  overdare-tools run studiorpc_level_browse --args '{}' --json
`);
}

function printJson(streams: CliStreams, value: unknown): void {
  streams.stdout.log(JSON.stringify(value, null, 2));
}

function printResultPretty(streams: CliStreams, toolName: string, source: string, result: ToolResult): void {
  streams.stdout.log(`tool: ${toolName}`);
  streams.stdout.log(`source: ${source}`);
  streams.stdout.log("");
  streams.stdout.log(result.output);
  if (result.metadata && Object.keys(result.metadata).length > 0) {
    streams.stdout.log("");
    streams.stdout.log("metadata:");
    streams.stdout.log(JSON.stringify(result.metadata, null, 2));
  }
}

function createToolContext(streams: CliStreams): ToolContext {
  const controller = new AbortController();
  return {
    toolCallId: randomUUID(),
    signal: controller.signal,
    abort: () => controller.abort(),
    onUpdate: (partialResult) => {
      if (typeof streams.stderr.write === "function") {
        streams.stderr.write(partialResult);
      } else {
        streams.stderr.error(partialResult);
      }
    },
  };
}

function summarizeSchema(tool: Tool): unknown {
  const schema = tool.parameters as { safeParse?: (value: unknown) => unknown; _def?: unknown; shape?: unknown };
  if ("shape" in schema && schema.shape) return schema.shape;
  if ("_def" in schema) {
    return schema._def;
  }
  return "Schema inspection unavailable";
}

export async function runOverdareToolsCli(argv: string[], streams: CliStreams): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    streams.stderr.error(error instanceof Error ? error.message : String(error));
    printUsage(streams);
    return 1;
  }

  if (parsed.command === "help") {
    printUsage(streams);
    return 0;
  }

  const tools = await loadOverdareTools(parsed.cwd);

  if (parsed.command === "list") {
    const items = Array.from(tools.entries())
      .map(([name, entry]) => ({ name, source: entry.source, description: entry.tool.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (parsed.json) {
      printJson(streams, items);
      return 0;
    }
    for (const item of items) {
      streams.stdout.log(`${item.name} [${item.source}]`);
      streams.stdout.log(`  ${item.description}`);
    }
    return 0;
  }

  if (!parsed.toolName) {
    streams.stderr.error("Tool name is required.");
    printUsage(streams);
    return 1;
  }

  const entry = tools.get(parsed.toolName);
  if (!entry) {
    streams.stderr.error(`Unknown tool: ${parsed.toolName}`);
    return 1;
  }

  if (parsed.command === "inspect") {
    const payload = {
      name: parsed.toolName,
      source: entry.source,
      version: entry.version,
      description: entry.tool.description,
      supportParallel: entry.tool.supportParallel ?? false,
      parameters: summarizeSchema(entry.tool),
    };
    if (parsed.json) {
      printJson(streams, payload);
    } else {
      streams.stdout.log(`name: ${payload.name}`);
      streams.stdout.log(`source: ${payload.source}`);
      streams.stdout.log(`version: ${payload.version}`);
      streams.stdout.log(`parallel: ${payload.supportParallel}`);
      streams.stdout.log("");
      streams.stdout.log(payload.description);
      streams.stdout.log("");
      streams.stdout.log(JSON.stringify(payload.parameters, null, 2));
    }
    return 0;
  }

  try {
    const rawArgs = await resolveToolArgs(parsed);
    const parsedArgs = entry.tool.parseArgs ? entry.tool.parseArgs(rawArgs) : entry.tool.parameters.parse(rawArgs);
    const result = await entry.tool.execute(parsedArgs, createToolContext(streams));
    if (parsed.json) {
      printJson(streams, {
        tool: parsed.toolName,
        source: entry.source,
        cwd: parsed.cwd,
        args: parsedArgs,
        result,
      });
    } else {
      printResultPretty(streams, parsed.toolName, entry.source, result);
    }
    return 0;
  } catch (error) {
    streams.stderr.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
