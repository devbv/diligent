// @summary Applies batched instance adds and updates through the Studio instance RPCs.

import { collectUiDiagnostics, type InstanceUpsertArgs, isUpdateItem } from "../../methods/instance.upsert";
import { buildInstanceUpsertRender } from "../../render";
import type { ToolResult } from "../../types";
import { addInstancesInDocument, updateInstancesInDocument } from "../instance-document-operations";
import { resultFromInstanceToolStatusError } from "../instance-status";
import { findNodeByActorGuid, type OvdrjmNode } from "../ovdrjm-utils";
import { callInstanceRpc, createdActorGuids, readLevelRoot, saveLevelFile, takeWarnings } from "./client";
import { applyMobilityCascade } from "./mobility";

/** Studio issues ActorGuid and ObjectKey itself, and children arrive through their own calls. */
const LOCAL_ONLY_KEYS = new Set(["ActorGuid", "ObjectKey", "LuaChildren"]);

interface PendingAdd {
  node: OvdrjmNode;
  addedIndex: number;
}

function toCreatePayload(node: OvdrjmNode): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !LOCAL_ONLY_KEYS.has(key)));
}

/** Keys the local write replaced. Property values are objects, so identity is the comparison. */
function changedProperties(before: Record<string, unknown>, after: OvdrjmNode): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === "LuaChildren") continue;
    if (before[key] !== value) changed[key] = value;
  }
  return changed;
}

export async function upsertInstancesViaRpc(parsedArgs: InstanceUpsertArgs): Promise<ToolResult> {
  try {
    return await runUpsert(parsedArgs);
  } catch (error) {
    const result = resultFromInstanceToolStatusError(error);
    if (result) return result;
    throw error;
  }
}

async function runUpsert(parsedArgs: InstanceUpsertArgs): Promise<ToolResult> {
  const root = await readLevelRoot();
  const document: Record<string, unknown> = { Root: root };
  const mobilityInfo: string[] = [];
  const writeOptions = { mobilityPolicy: "ignore-non-top-level" as const, mobilityInfo };

  const updateInstances: Record<string, unknown>[] = [];
  const addsByParent = new Map<string, PendingAdd[]>();
  const added: { guid: string; name: string; class: string }[] = [];

  for (const item of parsedArgs.items) {
    if (isUpdateItem(item)) {
      const target = findNodeByActorGuid(root, item.guid);
      const before = target ? { ...target } : {};
      updateInstancesInDocument(root, [{ ...item, properties: item.properties ?? {} }], writeOptions);
      if (target) updateInstances.push({ ActorGuid: item.guid, ...changedProperties(before, target) });
      continue;
    }

    const [metadata] = addInstancesInDocument(document, [{ ...item, properties: item.properties ?? {} }], writeOptions);
    const node = findNodeByActorGuid(root, metadata.guid);
    if (!node) throw new Error(`Locally added instance disappeared: ${metadata.guid}`);
    added.push(metadata);
    const pending = addsByParent.get(item.parentGuid) ?? [];
    pending.push({ node, addedIndex: added.length - 1 });
    addsByParent.set(item.parentGuid, pending);
  }

  if (updateInstances.length > 0) {
    await callInstanceRpc("instance.update", { Instances: updateInstances });
  }

  // instance.create takes one parent per call, so adds are grouped by parentGuid.
  for (const [parentGuid, pending] of addsByParent) {
    const result = await callInstanceRpc("instance.create", {
      ParentActorGuid: parentGuid,
      Instances: pending.map((entry) => toCreatePayload(entry.node)),
    });
    const guids = createdActorGuids(result);
    pending.forEach((entry, position) => {
      const guid = guids[position] ?? "";
      entry.node.ActorGuid = guid;
      added[entry.addedIndex].guid = guid;
    });
  }

  applyMobilityCascade(root);
  await saveLevelFile();

  const diag = collectUiDiagnostics(root);
  diag.info.push(...mobilityInfo, ...takeWarnings());
  const addedGuids = added.map((item) => item.guid);
  const updatedGuids = parsedArgs.items.flatMap((item) => (isUpdateItem(item) ? [item.guid] : []));
  const targetGuids = [...updatedGuids, ...addedGuids];

  const lines: string[] = [];
  if (added.length > 0) {
    lines.push("<added-instances>");
    for (const a of added) {
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
      addCount: added.length,
      updateCount: updatedGuids.length,
      added,
      ...(diag.warnings.length > 0 && { warnings: diag.warnings }),
      ...(diag.info.length > 0 && { info: diag.info }),
    },
  };
}
