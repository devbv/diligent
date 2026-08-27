// @summary Moves instances to a new parent in the level file.

import { resolveApiVersion } from "../config";
import * as instanceMove from "../methods/instance.move";
import { buildInstanceMoveRender } from "../render";
import { applyLevelChanges as applyLevelChangesDefault } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { normalizeWorkspaceMobility } from "./instance-document-operations";
import { moveInstancesInDocument, validateInstanceMoves } from "./instance-move-operations";
import { resultFromInstanceToolStatusError } from "./instance-status";
import { isRecord, type OvdrjmNode, readAndWriteOvdrjm } from "./ovdrjm-utils";
import { moveInstancesViaRpc } from "./v2/instance-move";

async function executeInstanceMove(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: () => Promise<unknown>,
): Promise<ToolResult> {
  const toolName = "studiorpc_instance_move";
  const parsedArgs = instanceMove.parseArgs(args);

  const writeApproval = await ctx.approve({
    permission: "write",
    toolName,
    description: "Update .ovdrjm world file",
    details: parsedArgs,
  });
  if (writeApproval === "reject") {
    return {
      output: "[Rejected by user]",
      metadata: { error: true, method: "instance.move" },
    };
  }

  const release = await writeLock.acquire();
  try {
    if (resolveApiVersion() === "v2") return await moveInstancesViaRpc(parsedArgs);
    return await executeInstanceMoveInner(parsedArgs, cwd, applyLevelChanges);
  } finally {
    release();
  }
}

async function executeInstanceMoveInner(
  parsedArgs: ReturnType<typeof instanceMove.parseArgs>,
  cwd: string,
  applyLevelChanges: () => Promise<unknown>,
): Promise<ToolResult> {
  const fileResult = (() => {
    try {
      return readAndWriteOvdrjm(cwd, (rootDoc) => {
        const root = rootDoc.Root;
        if (!isRecord(root)) {
          throw new Error("Invalid .ovdrjm format: Root object is missing.");
        }

        validateInstanceMoves(root as OvdrjmNode, parsedArgs.items);
        const movedGuids = moveInstancesInDocument(root as OvdrjmNode, parsedArgs.items);
        // Reparenting can change a node's top-level Workspace ancestor, so its
        // assembly must re-follow the new ancestor's Mobility (same as upsert).
        normalizeWorkspaceMobility(root as OvdrjmNode);

        return { added: movedGuids.map((g) => ({ guid: g, name: "", class: "" })) };
      });
    } catch (error) {
      const result = resultFromInstanceToolStatusError(error);
      if (result) return result;
      throw error;
    }
  })();

  if ("output" in fileResult) {
    return fileResult;
  }

  const result = await applyLevelChanges();
  const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);

  return {
    output,
    render: buildInstanceMoveRender(parsedArgs as unknown as Record<string, unknown>, output),
    metadata: {
      method: "instance.move",
      umapPath: fileResult.umapPath,
      ovdrjmPath: fileResult.ovdrjmPath,
      targetGuids: fileResult.added.map((a) => a.guid),
      moveCount: parsedArgs.items.length,
      levelApplyResult: result,
    },
  };
}

export function createInstanceMoveTool(
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: () => Promise<unknown> = applyLevelChangesDefault,
): Tool {
  return {
    name: "studiorpc_instance_move",
    description: instanceMove.description,
    parameters: instanceMove.params,
    async execute(args, ctx) {
      return executeInstanceMove(args, ctx, cwd, writeLock, applyLevelChanges);
    },
  };
}
