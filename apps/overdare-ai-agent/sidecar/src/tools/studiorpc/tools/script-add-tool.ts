// @summary Adds a script instance to the .ovdrjm level file.

import * as scriptAdd from "../methods/script.add";
import { buildScriptAddRender } from "../render";
import { applyAndSave } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  findNodeByActorGuid,
  isRecord,
  normalizeLeadingSpaces,
  normalizeLineEndings,
  type OvdrjmNode,
  readAndWriteOvdrjm,
} from "./ovdrjm-utils";

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

function makeActorGuid(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16)
      .toString(16)
      .toUpperCase(),
  ).join("");
}

function nextObjectKey(rootDoc: Record<string, unknown>): number {
  const current = rootDoc.MapObjectKeyIndex;
  const numeric = typeof current === "number" && Number.isFinite(current) ? Math.floor(current) : 0;
  const next = numeric + 1;
  rootDoc.MapObjectKeyIndex = next;
  return next;
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
    let addedGuid = "";
    let tabCount = 0;
    let eolCount = 0;

    readAndWriteOvdrjm(cwd, (rootDoc) => {
      const root = rootDoc.Root;
      if (!isRecord(root)) {
        throw new Error("Invalid .ovdrjm format: Root object is missing.");
      }

      const parent = findNodeByActorGuid(root as OvdrjmNode, parsed.parentGuid);
      if (!parent) {
        throw new Error(`Parent ActorGuid not found in .ovdrjm: ${parsed.parentGuid}`);
      }

      const childList = Array.isArray(parent.LuaChildren) ? parent.LuaChildren : [];
      parent.LuaChildren = childList;

      const guid = makeActorGuid();
      const normalized = normalizeLeadingSpaces(parsed.source);
      const eolNormalized = normalizeLineEndings(normalized.result);

      childList.push({
        InstanceType: parsed.class,
        ActorGuid: guid,
        ObjectKey: nextObjectKey(rootDoc),
        Name: parsed.name,
        Source: eolNormalized.result,
      });
      addedGuid = guid;
      tabCount = normalized.converted;
      eolCount = eolNormalized.converted;
    });

    await applyAndSave();

    let output = `Script added: ${parsed.name} (${addedGuid})`;
    const normalizations: string[] = [];
    if (tabCount > 0) normalizations.push(`${tabCount} leading 4-space group(s) → tabs`);
    if (eolCount > 0) normalizations.push(`${eolCount} line ending(s) normalized`);
    if (normalizations.length > 0) output += ` (${normalizations.join(", ")})`;
    return {
      output,
      render: buildScriptAddRender(parsed as unknown as Record<string, unknown>, output, addedGuid),
      metadata: { method: "script.add", guid: addedGuid, name: parsed.name, class: parsed.class },
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
