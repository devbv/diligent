// @summary Reads instance properties from the .ovdrjm level file, filtered to known schemas.

import { classPropertyShapes, instanceClassEnum, type ShapeSpec, serviceClassEnum } from "../methods/instance.params";
import * as instanceRead from "../methods/instance.read";
import { buildInstanceReadRender } from "../render";
import type { Tool, ToolContext, ToolResult } from "../types";
import { findNodeByActorGuid, isRecord, type OvdrjmNode, readOvdrjmRoot } from "./ovdrjm-utils";

const knownClasses = new Set<string>([...instanceClassEnum.options, ...serviceClassEnum.options]);

type ReadableNode = {
  guid: string;
  name: string;
  class: string;
  properties: Record<string, unknown>;
  children?: ReadableNode[];
};

function stripByShape(value: unknown, shape: ShapeSpec): unknown {
  if (shape === true) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripByShape(item, shape));
  }
  if (typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, childShape] of Object.entries(shape)) {
    if (key in record) {
      result[key] = stripByShape(record[key], childShape);
    }
  }
  return result;
}

function pickKnownProperties(node: OvdrjmNode): Record<string, unknown> {
  const instanceType = typeof node.InstanceType === "string" ? node.InstanceType : undefined;
  const shapes = instanceType ? classPropertyShapes[instanceType] : undefined;
  if (!shapes) return {};

  const result: Record<string, unknown> = {};
  for (const [key, shape] of Object.entries(shapes)) {
    if (key in node) {
      result[key] = stripByShape(node[key], shape);
    }
  }
  return result;
}

function toReadableNode(node: OvdrjmNode, recursive: boolean): ReadableNode | undefined {
  const instanceType = typeof node.InstanceType === "string" ? node.InstanceType : undefined;
  if (!instanceType) return undefined;

  const isKnown = knownClasses.has(instanceType as typeof instanceClassEnum._type);

  const result: ReadableNode = {
    guid: typeof node.ActorGuid === "string" ? node.ActorGuid : "",
    name: typeof node.Name === "string" ? node.Name : "",
    class: instanceType,
    properties: isKnown ? pickKnownProperties(node) : {},
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

async function executeInstanceRead(args: Record<string, unknown>, _ctx: ToolContext, cwd: string): Promise<ToolResult> {
  const parsed = instanceRead.params.parse(args);
  const { root } = readOvdrjmRoot(cwd);

  const target = findNodeByActorGuid(root, parsed.guid);
  if (!target) {
    return {
      output: `Instance not found: ${parsed.guid}`,
      metadata: { error: true, method: "instance.read" },
    };
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

export function createInstanceReadTool(cwd: string): Tool {
  return {
    name: toToolName(instanceRead.method),
    description: instanceRead.description,
    parameters: instanceRead.params,
    async execute(args, ctx) {
      return executeInstanceRead(args, ctx, cwd);
    },
  };
}
