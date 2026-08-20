// @summary Reads a script's Source through the Studio instance.read RPC, with line numbers.

import type * as scriptRead from "../../methods/script.read";
import { buildScriptReadRender } from "../../render";
import type { ToolResult } from "../../types";
import { DEPTH_SELF, readInstanceNode } from "./client";
import { instanceTypeOf, SCRIPT_CLASSES } from "./scripts";

type ScriptReadArgs = ReturnType<typeof scriptRead.params.parse>;

const DEFAULT_LIMIT = 2000;

function formatLineNumber(lineNum: number, maxLineNum: number): string {
  const width = String(maxLineNum).length;
  return `${String(lineNum).padStart(width)}\t`;
}

export async function readScriptViaRpc(parsed: ScriptReadArgs): Promise<ToolResult> {
  const { targetGuid, offset, limit } = parsed;

  let source: string;
  let scriptName: string;
  try {
    const target = await readInstanceNode(targetGuid, DEPTH_SELF);
    if (!target) {
      return { output: `Error: ActorGuid not found: ${targetGuid}`, metadata: { error: true } };
    }

    const instanceType = instanceTypeOf(target);
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

  const allLines = source.split("\n");
  const startLine = offset ? offset - 1 : 0;
  const maxLines = limit ?? DEFAULT_LIMIT;
  const selectedLines = allLines.slice(startLine, startLine + maxLines);
  const totalLines = allLines.length;

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
