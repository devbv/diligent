// @summary Reads instance properties through the Studio instance.read RPC.

import type * as instanceRead from "../../methods/instance.read";
import { buildInstanceReadRender } from "../../render";
import type { ToolResult } from "../../types";
import { toReadableNode } from "../instance-read-tool";
import { missingGuidResult } from "../instance-status";
import { DEPTH_SELF, DEPTH_SUBTREE, readInstanceNode } from "./client";

type InstanceReadArgs = ReturnType<typeof instanceRead.params.parse>;

export async function readInstanceViaRpc(parsed: InstanceReadArgs): Promise<ToolResult> {
  const target = await readInstanceNode(parsed.guid, parsed.recursive ? DEPTH_SUBTREE : DEPTH_SELF);
  if (!target) {
    return missingGuidResult({ operation: "instance.read", guid: parsed.guid, role: "target" });
  }

  const readable = toReadableNode(target, parsed.recursive);
  if (!readable) {
    return {
      output: `Instance ${parsed.guid} has no InstanceType.`,
      metadata: { error: true, method: "instance.read" },
    };
  }

  const output = JSON.stringify(readable, null, 2);
  return {
    output,
    render: buildInstanceReadRender(parsed as unknown as Record<string, unknown>, output),
    metadata: { method: "instance.read", guid: parsed.guid, recursive: parsed.recursive },
  };
}
