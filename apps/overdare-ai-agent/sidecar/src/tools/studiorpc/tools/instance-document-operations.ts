// @summary Mutates instances inside one already-loaded .ovdrjm document.

import { parseInstancePatchProperties } from "../methods/instance-properties";
import { invalidInstanceOperationError, missingGuidError } from "./instance-status";
import {
  clearStaleWorldTransforms,
  findNodeByActorGuid,
  isRecord,
  type OvdrjmNode,
  removeNodeByActorGuid,
} from "./ovdrjm-utils";

export interface InstanceDocumentAddItem {
  class: string;
  parentGuid: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface InstanceDocumentUpdateItem {
  guid: string;
  name?: string;
  properties: Record<string, unknown>;
}

export interface AddedInstanceMetadata {
  guid: string;
  name: string;
  class: string;
}

export function requireDocumentRoot(document: Record<string, unknown>): OvdrjmNode {
  const root = document.Root;
  if (!isRecord(root)) throw new Error("Invalid .ovdrjm format: Root object is missing.");
  return root as OvdrjmNode;
}

function makeActorGuid(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16)
      .toString(16)
      .toUpperCase(),
  ).join("");
}

function nextObjectKey(document: Record<string, unknown>): number {
  const current = document.MapObjectKeyIndex;
  const numeric = typeof current === "number" && Number.isFinite(current) ? Math.floor(current) : 0;
  const next = numeric + 1;
  document.MapObjectKeyIndex = next;
  return next;
}

function validateAddParent(item: InstanceDocumentAddItem, parent: OvdrjmNode): void {
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
}

/** Adds items in order, so later items may use GUIDs returned for earlier items. */
export function addInstancesInDocument(
  document: Record<string, unknown>,
  items: readonly InstanceDocumentAddItem[],
): AddedInstanceMetadata[] {
  const root = requireDocumentRoot(document);
  const added: AddedInstanceMetadata[] = [];
  for (const item of items) {
    const parent = findNodeByActorGuid(root, item.parentGuid);
    if (!parent) throw missingGuidError({ operation: "instance.upsert", guid: item.parentGuid, role: "parent" });
    validateAddParent(item, parent);

    const children = Array.isArray(parent.LuaChildren) ? parent.LuaChildren : [];
    parent.LuaChildren = children;
    const node: OvdrjmNode = {
      InstanceType: item.class,
      ActorGuid: makeActorGuid(),
      ObjectKey: nextObjectKey(document),
      Name: item.name,
      ...item.properties,
    };
    children.push(node);
    added.push({ guid: String(node.ActorGuid), name: item.name, class: item.class });
  }
  return added;
}

/** Applies name/property patches without injecting create defaults. */
export function updateInstancesInDocument(root: OvdrjmNode, items: readonly InstanceDocumentUpdateItem[]): string[] {
  for (const item of items) {
    const target = findNodeByActorGuid(root, item.guid);
    if (!target) throw missingGuidError({ operation: "instance.upsert", guid: item.guid, role: "target" });
    const targetClass = typeof target.InstanceType === "string" ? target.InstanceType : "Instance";
    const properties = parseInstancePatchProperties(targetClass, item.properties);
    Object.assign(target, properties);
    if (typeof item.name === "string") target.Name = item.name;
    if ("CFrame" in properties) clearStaleWorldTransforms(target);
  }
  return items.map((item) => item.guid);
}

/** Deletes requested GUIDs and optionally records already-missing targets. */
export function deleteInstancesInDocument(
  root: OvdrjmNode,
  guids: readonly string[],
  options: { skipMissing?: boolean } = {},
): { deletedGuids: string[]; skippedGuids: string[] } {
  const deletedGuids: string[] = [];
  const skippedGuids: string[] = [];
  for (const guid of guids) {
    if (removeNodeByActorGuid(root, guid)) {
      deletedGuids.push(guid);
    } else if (options.skipMissing) {
      skippedGuids.push(guid);
    } else {
      throw missingGuidError({ operation: "instance.delete", guid, role: "target" });
    }
  }
  return { deletedGuids, skippedGuids };
}
