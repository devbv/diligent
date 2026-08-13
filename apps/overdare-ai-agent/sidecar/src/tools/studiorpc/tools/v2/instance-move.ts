// @summary Reparents instances through the Studio instance.move RPC.

import type { InstanceMoveArgs } from "../../methods/instance.move";
import { buildInstanceMoveRender } from "../../render";
import type { ToolResult } from "../../types";
import { type InstanceMoveItem, moveInstancesInDocument, validateInstanceMoves } from "../instance-move-operations";
import { resultFromInstanceToolStatusError } from "../instance-status";
import { callInstanceRpc, readLevelTreeLite, rpcOutput, saveLevelFile } from "./client";

/** instance.move takes one entry per parent, so items are grouped by their new parent. */
function groupMovesByParent(items: readonly InstanceMoveItem[]): { ParentActorGuid: string; ActorGuids: string[] }[] {
  const byParent = new Map<string, string[]>();
  for (const item of items) {
    const guids = byParent.get(item.parentGuid) ?? [];
    guids.push(item.guid);
    byParent.set(item.parentGuid, guids);
  }
  return [...byParent].map(([ParentActorGuid, ActorGuids]) => ({ ParentActorGuid, ActorGuids }));
}

export async function moveInstancesViaRpc(parsedArgs: InstanceMoveArgs): Promise<ToolResult> {
  try {
    return await runMove(parsedArgs);
  } catch (error) {
    const result = resultFromInstanceToolStatusError(error);
    if (result) return result;
    throw error;
  }
}

async function runMove(parsedArgs: InstanceMoveArgs): Promise<ToolResult> {
  const root = await readLevelTreeLite();
  validateInstanceMoves(root, parsedArgs.items);
  const movedGuids = moveInstancesInDocument(root, parsedArgs.items);

  const result = await callInstanceRpc("instance.move", { Moves: groupMovesByParent(parsedArgs.items) });
  await saveLevelFile();

  const output = rpcOutput(result);
  return {
    output,
    render: buildInstanceMoveRender(parsedArgs as unknown as Record<string, unknown>, output),
    metadata: {
      method: "instance.move",
      targetGuids: movedGuids,
      moveCount: parsedArgs.items.length,
      levelApplyResult: result,
    },
  };
}
