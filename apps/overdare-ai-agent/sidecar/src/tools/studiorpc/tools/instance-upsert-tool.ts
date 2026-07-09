// @summary Applies batched add or update instance changes to the level file.

import * as instanceUpsert from "../methods/instance.upsert";
import { collectUiDiagnostics } from "../methods/instance.upsert";
import { buildInstanceUpsertRender } from "../render";
import { applyLevelChanges } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  invalidInstanceOperationError,
  missingGuidError,
  normalizeLevelApplyResult,
  resultFromInstanceToolStatusError,
} from "./instance-status";
import { findNodeByActorGuid, isRecord, type OvdrjmNode, readAndWriteOvdrjm } from "./ovdrjm-utils";

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

function buildAddedNode(
  item: { class: string; name: string; properties: Record<string, unknown> },
  rootDoc: Record<string, unknown>,
): Record<string, unknown> {
  const newNode: Record<string, unknown> = {
    InstanceType: item.class,
    ActorGuid: makeActorGuid(),
    ObjectKey: nextObjectKey(rootDoc),
    Name: item.name,
    ...item.properties,
  };

  return newNode;
}

async function executeInstanceUpsert(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "studiorpc_instance_upsert";
  const parsedArgs = instanceUpsert.parseArgs(args);

  const writeApproval = await ctx.approve({
    permission: "write",
    toolName,
    description: "Update .ovdrjm world file",
    details: parsedArgs,
  });
  if (writeApproval === "reject") {
    return {
      output: "[Rejected by user]",
      metadata: { error: true, method: "instance.upsert" },
    };
  }

  const release = await writeLock.acquire();
  try {
    return await executeInstanceUpsertInner(parsedArgs, cwd);
  } finally {
    release();
  }
}

async function executeInstanceUpsertInner(
  parsedArgs: ReturnType<typeof instanceUpsert.parseArgs>,
  cwd: string,
): Promise<ToolResult> {
  let ovdrjmRoot: OvdrjmNode | undefined;

  const fileResult = (() => {
    try {
      return readAndWriteOvdrjm(cwd, (rootDoc) => {
        const root = rootDoc.Root;
        if (!isRecord(root)) {
          throw new Error("Invalid .ovdrjm format: Root object is missing.");
        }

        const added: { guid: string; name: string; class: string }[] = [];
        for (const item of parsedArgs.items) {
          if (instanceUpsert.isUpdateItem(item)) {
            const target = findNodeByActorGuid(root as OvdrjmNode, item.guid);
            if (!target) {
              throw missingGuidError({ operation: "instance.upsert", guid: item.guid, role: "target" });
            }
            Object.assign(target, item.properties);
            if (typeof item.name === "string") {
              target.Name = item.name;
            }
            continue;
          }

          const parent = findNodeByActorGuid(root as OvdrjmNode, item.parentGuid);
          if (!parent) {
            throw missingGuidError({ operation: "instance.upsert", guid: item.parentGuid, role: "parent" });
          }

          if (item.class === "MaterialVariant" && parent.InstanceType !== "MaterialService") {
            throw invalidInstanceOperationError({
              operation: "instance.upsert",
              code: "invalid_parent_class",
              guid: item.parentGuid,
              role: "parent",
              class: String(parent.InstanceType ?? "unknown"),
              message: `MaterialVariant can only be created under MaterialService, but parent is ${String(parent.InstanceType ?? "unknown")}.`,
            });
          }

          const childList = Array.isArray(parent.LuaChildren) ? parent.LuaChildren : [];
          parent.LuaChildren = childList;

          const newNode = buildAddedNode({ ...item, properties: item.properties ?? {} }, rootDoc);
          childList.push(newNode);
          added.push({ guid: String(newNode.ActorGuid), name: item.name, class: item.class });
        }

        ovdrjmRoot = root as OvdrjmNode;
        return { added };
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

  const applyResult = await applyLevelChanges();
  const levelApplyStatus = normalizeLevelApplyResult(applyResult);
  const diag = ovdrjmRoot ? collectUiDiagnostics(ovdrjmRoot) : { warnings: [], info: [] };
  const addedGuids = fileResult.added.map((item) => item.guid);
  const updatedGuids = parsedArgs.items.flatMap((item) => (instanceUpsert.isUpdateItem(item) ? [item.guid] : []));
  const targetGuids = [...updatedGuids, ...addedGuids];
  const addCount = fileResult.added.length;
  const updateCount = updatedGuids.length;

  const lines: string[] = [];
  if (fileResult.added.length > 0) {
    lines.push("<added-instances>");
    for (const a of fileResult.added) {
      lines.push(`<instance name="${a.name}" class="${a.class}" guid="${a.guid}" />`);
    }
    lines.push("</added-instances>");
  }
  if (diag.warnings.length > 0) {
    lines.push("<warnings>", ...diag.warnings, "</warnings>");
  }
  if (diag.info.length > 0) {
    lines.push("<suggestions>", ...diag.info, "</suggestions>");
  }

  return {
    output: lines.join("\n") || "OK",
    render: buildInstanceUpsertRender(parsedArgs as unknown as Record<string, unknown>, lines.join("\n") || "OK"),
    metadata: {
      method: "instance.upsert",
      targetGuids,
      addCount,
      updateCount,
      added: fileResult.added,
      ...(diag.warnings.length > 0 && { warnings: diag.warnings }),
      ...(diag.info.length > 0 && { info: diag.info }),
      levelApplyResult: applyResult,
      levelApplyStatus,
    },
  };
}

export function createInstanceUpsertTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: toToolName(instanceUpsert.method),
    description: instanceUpsert.description,
    parameters: instanceUpsert.params,
    parseArgs: (raw) => instanceUpsert.parseArgs(raw as Record<string, unknown>),
    async execute(args, ctx) {
      return executeInstanceUpsert(args, ctx, cwd, writeLock);
    },
  };
}
