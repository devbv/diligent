// @summary Reads instance properties from the .ovdrjm level file, filtered to known schemas.

import { resolveApiVersion } from "../config";
import { instanceClassEnum, serviceClassEnum } from "../methods/instance.params";
import * as instanceRead from "../methods/instance.read";
import { pickKnownInstanceProperties } from "../methods/instance-properties";
import { buildInstanceReadRender } from "../render";
import { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import { missingGuidResult } from "./instance-status";
import { findNodeByActorGuid, isRecord, type OvdrjmNode, readOvdrjmRoot } from "./ovdrjm-utils";
import { readInstanceViaRpc } from "./v2/instance-read";

const knownClasses = new Set<string>([...instanceClassEnum.options, ...serviceClassEnum.options]);

type ReadableNode = {
  guid: string;
  name: string;
  class: string;
  properties: Record<string, unknown>;
  children?: ReadableNode[];
};

function toReadableNode(node: OvdrjmNode, recursive: boolean): ReadableNode | undefined {
  const instanceType = typeof node.InstanceType === "string" ? node.InstanceType : undefined;
  if (!instanceType) return undefined;

  const isKnown = knownClasses.has(instanceType as typeof instanceClassEnum._type);

  const result: ReadableNode = {
    guid: typeof node.ActorGuid === "string" ? node.ActorGuid : "",
    name: typeof node.Name === "string" ? node.Name : "",
    class: instanceType,
    properties: isKnown ? pickKnownInstanceProperties(instanceType, node) : {},
  };

  if (recursive && Array.isArray(node.LuaChildren)) {
    const children: ReadableNode[] = [];
    for (const child of node.LuaChildren) {
      if (!isRecord(child)) continue;
      const readable = toReadableNode(child as OvdrjmNode, true);
      if (readable) children.push(readable);
    }
    if (children.length > 0) result.children = children;
  }

  return result;
}

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

/**
 * The .ovdrjm holds whatever this sidecar last wrote, not what Studio holds. Right
 * after a write that gap is wide: a freshly created Part reads back with four
 * properties instead of sixteen — no CFrame, no Size — and reports a CanQuery that
 * Studio does not have. Asking Studio to save first makes the file current.
 *
 * Best-effort on purpose. Reading the file is what this tool is for, and it worked
 * without a live Studio before; a failed flush costs freshness, not the answer.
 */
async function flushStudioToFile(callRpc: typeof call): Promise<void> {
  try {
    await callRpc("level.save.file", {});
  } catch {
    /* 파일이 낡을 뿐, 읽기는 계속한다 */
  }
}

async function executeInstanceRead(
  args: Record<string, unknown>,
  _ctx: ToolContext,
  cwd: string,
  callRpc: typeof call,
): Promise<ToolResult> {
  const parsed = instanceRead.params.parse(args);
  if (resolveApiVersion() === "v2") return await readInstanceViaRpc(parsed);
  await flushStudioToFile(callRpc);
  const { root } = readOvdrjmRoot(cwd);

  const target = findNodeByActorGuid(root, parsed.guid);
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

export function createInstanceReadTool(cwd: string, callRpc: typeof call = call): Tool {
  return {
    name: toToolName(instanceRead.method),
    description: instanceRead.description,
    parameters: instanceRead.params,
    async execute(args, ctx) {
      return executeInstanceRead(args, ctx, cwd, callRpc);
    },
  };
}

export { toReadableNode };
