// @summary Deletes instances through the Studio instance.delete RPC.

import type { InstanceDeleteArgs } from "../../methods/instance.delete";
import { serviceClassEnum } from "../../methods/instance.params";
import { buildInstanceDeleteRender } from "../../render";
import type { ToolResult } from "../../types";
import { invalidInstanceOperationError, missingGuidError, resultFromInstanceToolStatusError } from "../instance-status";
import { findNodeByActorGuid } from "../ovdrjm-utils";
import { callInstanceRpc, readLevelTreeLite, rpcOutput, saveLevelFile } from "./client";

const serviceClasses = new Set<string>(serviceClassEnum.options);

export async function deleteInstancesViaRpc(parsedArgs: InstanceDeleteArgs): Promise<ToolResult> {
  try {
    return await runDelete(parsedArgs);
  } catch (error) {
    const result = resultFromInstanceToolStatusError(error);
    if (result) return result;
    throw error;
  }
}

async function runDelete(parsedArgs: InstanceDeleteArgs): Promise<ToolResult> {
  const root = await readLevelTreeLite();

  const deletedGuids: string[] = [];
  for (const item of parsedArgs.items) {
    const target = findNodeByActorGuid(root, item.guid);
    if (!target) {
      throw missingGuidError({ operation: "instance.delete", guid: item.guid, role: "target" });
    }
    const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
    if (instanceType && serviceClasses.has(instanceType)) {
      throw invalidInstanceOperationError({
        operation: "instance.delete",
        code: "protected_service_class",
        guid: item.guid,
        role: "target",
        class: instanceType,
        message: `"${instanceType}" is a Service and cannot be deleted.`,
      });
    }
    deletedGuids.push(item.guid);
  }

  const result = await callInstanceRpc("instance.delete", { ActorGuids: deletedGuids });
  await saveLevelFile();

  const output = rpcOutput(result);
  return {
    output,
    render: buildInstanceDeleteRender(parsedArgs as unknown as Record<string, unknown>, output),
    metadata: {
      method: "instance.delete",
      targetGuids: deletedGuids,
      deleteCount: parsedArgs.items.length,
      levelApplyResult: result,
    },
  };
}
