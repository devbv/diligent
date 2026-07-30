// @summary Adds a script instance to the .ovdrjm level file.

import * as scriptAdd from "../methods/script.add";
import { buildScriptAddRender } from "../render";
import { applyLevelChanges } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { addScriptToDocument } from "./script-document-operations";

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

async function executeScriptAdd(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = toToolName(scriptAdd.method);
  const parsed = scriptAdd.params.parse(args);

  const approval = await ctx.approve({
    permission: "write",
    toolName,
    description: `Add ${parsed.class} "${parsed.name}" under ${parsed.parentGuid}`,
    details: parsed,
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  const release = await writeLock.acquire();
  try {
    const added = addScriptToDocument(cwd, parsed);

    await applyLevelChanges();

    let output = `Script added: ${parsed.name} (${added.guid})`;
    const normalizations: string[] = [];
    if (added.normalizedLeadingSpaceGroups > 0) {
      normalizations.push(`${added.normalizedLeadingSpaceGroups} leading 4-space group(s) → tabs`);
    }
    if (added.normalizedLineEndings > 0) {
      normalizations.push(`${added.normalizedLineEndings} line ending(s) normalized`);
    }
    if (normalizations.length > 0) output += ` (${normalizations.join(", ")})`;
    return {
      output,
      render: buildScriptAddRender(parsed as unknown as Record<string, unknown>, output, added.guid),
      metadata: { method: "script.add", guid: added.guid, name: parsed.name, class: parsed.class },
    };
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  } finally {
    release();
  }
}

export function createScriptAddTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: toToolName(scriptAdd.method),
    description: scriptAdd.description,
    parameters: scriptAdd.params,
    async execute(args, ctx) {
      return executeScriptAdd(args, ctx, cwd, writeLock);
    },
  };
}
