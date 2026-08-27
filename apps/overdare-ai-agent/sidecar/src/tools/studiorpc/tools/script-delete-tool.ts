// @summary Deletes a script instance from the .ovdrjm level file.

import { resolveApiVersion } from "../config";
import * as scriptDelete from "../methods/script.delete";
import { buildDeleteRender } from "../render";
import { applyLevelChanges } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  findNodeByActorGuid,
  isRecord,
  type OvdrjmNode,
  readAndWriteOvdrjm,
  removeNodeByActorGuid,
} from "./ovdrjm-utils";
import { deleteScriptViaRpc } from "./v2/script-delete";

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

async function executeScriptDelete(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = toToolName(scriptDelete.method);
  const parsed = scriptDelete.params.parse(args);

  const approval = await ctx.approve({
    permission: "write",
    toolName,
    description: `Delete script ${parsed.guid}`,
    details: parsed,
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  const release = await writeLock.acquire();
  try {
    if (resolveApiVersion() === "v2") return await deleteScriptViaRpc(parsed);
    readAndWriteOvdrjm(cwd, (rootDoc) => {
      const root = rootDoc.Root;
      if (!isRecord(root)) {
        throw new Error("Invalid .ovdrjm format: Root object is missing.");
      }

      const target = findNodeByActorGuid(root as OvdrjmNode, parsed.guid);
      if (!target) {
        throw new Error(`ActorGuid not found in .ovdrjm: ${parsed.guid}`);
      }

      const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
      if (!instanceType || !SCRIPT_CLASSES.has(instanceType)) {
        throw new Error(
          `Instance ${parsed.guid} is ${instanceType ?? "unknown"}, not a script. ` +
            "Use studiorpc_instance_delete to delete non-script instances.",
        );
      }

      const removed = removeNodeByActorGuid(root as OvdrjmNode, parsed.guid);
      if (!removed) {
        throw new Error(`Failed to remove ActorGuid from .ovdrjm: ${parsed.guid}`);
      }
    });

    await applyLevelChanges();

    const output = "Deleted.";
    return {
      output,
      render: buildDeleteRender("Studio script delete", parsed.guid, output),
      metadata: { method: "script.delete", targetGuid: parsed.guid },
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

export function createScriptDeleteTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: toToolName(scriptDelete.method),
    description: scriptDelete.description,
    parameters: scriptDelete.params,
    async execute(args, ctx) {
      return executeScriptDelete(args, ctx, cwd, writeLock);
    },
  };
}
