// @summary Reads a script's Source property from .ovdrjm with line numbers.

import * as scriptRead from "../methods/script.read";
import { buildScriptReadRender } from "../render";
import type { Tool, ToolResult } from "../types";
import { findNodeByActorGuid, readOvdrjmRoot } from "./ovdrjm-utils";

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
const DEFAULT_LIMIT = 2000;

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

function formatLineNumber(lineNum: number, maxLineNum: number): string {
  const width = String(maxLineNum).length;
  return `${String(lineNum).padStart(width)}\t`;
}

async function executeScriptRead(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const parsed = scriptRead.params.parse(args);
  const { targetGuid, offset, limit } = parsed;

  // --- Read .ovdrjm ---
  let source: string;
  let scriptName: string;
  try {
    const { root } = readOvdrjmRoot(cwd);

    const target = findNodeByActorGuid(root, targetGuid);
    if (!target) {
      return { output: `Error: ActorGuid not found: ${targetGuid}`, metadata: { error: true } };
    }

    const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
    if (!instanceType || !SCRIPT_CLASSES.has(instanceType)) {
      return {
        output:
          `Error: instance ${targetGuid} is ${instanceType ?? "unknown"}, not a script. ` +
          "Use studiorpc_instance_read to read non-script instances.",
        metadata: { error: true },
      };
    }

    source = typeof target.Source === "string" ? target.Source : "";
    scriptName = typeof target.Name === "string" ? target.Name : targetGuid;
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  }

  // --- Apply offset/limit ---
  const allLines = source.split("\n");
  const startLine = offset ? offset - 1 : 0;
  const maxLines = limit ?? DEFAULT_LIMIT;
  const selectedLines = allLines.slice(startLine, startLine + maxLines);
  const totalLines = allLines.length;

  // --- Format with line numbers ---
  const maxLineNum = startLine + selectedLines.length;
  const numbered = selectedLines.map((line, i) => formatLineNumber(startLine + i + 1, maxLineNum) + line);

  let output = numbered.join("\n");

  if (startLine + maxLines < totalLines) {
    output += `\n\n... (showing lines ${startLine + 1}-${startLine + selectedLines.length} of ${totalLines} total)`;
  }

  return {
    output,
    render: buildScriptReadRender({
      targetGuid,
      scriptName,
      lineCount: selectedLines.length,
      content: output,
      offset: startLine + 1,
      limit: maxLines,
    }),
    metadata: { method: "script.read", targetGuid, totalLines, linesReturned: selectedLines.length },
  };
}

export function createScriptReadTool(cwd: string): Tool {
  return {
    name: toToolName(scriptRead.method),
    description: scriptRead.description,
    parameters: scriptRead.params,
    async execute(args) {
      return executeScriptRead(args, cwd);
    },
  };
}
