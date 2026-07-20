// @summary Mutates instances inside one already-loaded .ovdrjm document.

import { parseInstancePatchProperties } from "../methods/instance-properties";
import { invalidInstanceOperationError, missingGuidError } from "./instance-status";
import {
  clearStaleWorldTransforms,
  findNodeByActorGuid,
  findWorkspaceNode,
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

export interface InstanceDocumentWriteOptions {
  mobilityPolicy?: "ignore-non-top-level" | "preserve-for-normalization";
  mobilityInfo?: string[];
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

type MobilityValue = "Static" | "Movable";

/** Engine default when a node carries no explicit Mobility. */
const DEFAULT_MOBILITY: MobilityValue = "Movable";

function readMobility(node: OvdrjmNode): MobilityValue | undefined {
  return node.Mobility === "Static" || node.Mobility === "Movable" ? node.Mobility : undefined;
}

function effectiveMobility(node: OvdrjmNode): MobilityValue {
  return readMobility(node) ?? DEFAULT_MOBILITY;
}

/**
 * Locates the top-level Workspace object (a direct child of Workspace) that
 * governs `guid`. Mobility is authoritative only on those top-level objects;
 * every deeper descendant follows theirs. Returns whether `guid` is itself the
 * top-level object, or undefined when `guid` is Workspace itself or lives
 * outside the Workspace subtree.
 */
function locateWorkspaceObject(
  root: OvdrjmNode,
  guid: string,
): { topLevel: OvdrjmNode; isTopLevel: boolean } | undefined {
  const workspace = findWorkspaceNode(root);
  if (!workspace || !Array.isArray(workspace.LuaChildren)) return undefined;
  for (const child of workspace.LuaChildren) {
    if (!isRecord(child)) continue;
    const topLevel = child as OvdrjmNode;
    if (topLevel.ActorGuid === guid) return { topLevel, isTopLevel: true };
    if (findNodeByActorGuid(topLevel, guid)) return { topLevel, isTopLevel: false };
  }
  return undefined;
}

/**
 * Forces every descendant's effective Mobility to match `mobility`. The engine
 * default is Movable, so an explicit key is written whenever a descendant's
 * effective value differs from the target: a Static top-level materializes
 * Static onto its (otherwise default-Movable) descendants, and a Movable
 * top-level rewrites any stale Static descendant back to Movable.
 */
function syncDescendantMobility(node: OvdrjmNode, mobility: MobilityValue): void {
  if (!Array.isArray(node.LuaChildren)) return;
  for (const child of node.LuaChildren) {
    if (!isRecord(child)) continue;
    const descendant = child as OvdrjmNode;
    if (effectiveMobility(descendant) !== mobility) descendant.Mobility = mobility;
    syncDescendantMobility(descendant, mobility);
  }
}

/**
 * Applies the Mobility policy for one property write. Regular upserts ignore a
 * Mobility value outside Workspace's direct children. Procedural JSON apply
 * preserves it until the completed hierarchy is normalized.
 */
function applyMobilityWritePolicy(
  root: OvdrjmNode,
  guid: string,
  properties: Record<string, unknown>,
  options: InstanceDocumentWriteOptions,
  isTopLevel = locateWorkspaceObject(root, guid)?.isTopLevel === true,
): Record<string, unknown> {
  if (!("Mobility" in properties) || options.mobilityPolicy === "preserve-for-normalization") return properties;
  if (isTopLevel) return properties;
  const filtered = { ...properties };
  delete filtered.Mobility;
  options.mobilityInfo?.push(
    `Ignored Mobility for ${guid}: Mobility can only be changed on a direct child of Workspace.`,
  );
  return filtered;
}

/**
 * Every Workspace top-level object (direct child of Workspace) governs the
 * Mobility of its whole assembly. Cascades each top-level object's effective
 * Mobility down to every descendant, so a Static top-level yields an all-Static
 * subtree and a Movable one an all-Movable subtree — regardless of whether the
 * descendants were created with an explicit Mobility.
 */
export function normalizeWorkspaceMobility(root: OvdrjmNode): void {
  const workspace = findWorkspaceNode(root);
  if (!workspace || !Array.isArray(workspace.LuaChildren)) return;
  for (const child of workspace.LuaChildren) {
    if (!isRecord(child)) continue;
    const topLevel = child as OvdrjmNode;
    syncDescendantMobility(topLevel, effectiveMobility(topLevel));
  }
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
  options: InstanceDocumentWriteOptions = {},
): AddedInstanceMetadata[] {
  const root = requireDocumentRoot(document);
  const added: AddedInstanceMetadata[] = [];
  for (const item of items) {
    const parent = findNodeByActorGuid(root, item.parentGuid);
    if (!parent) throw missingGuidError({ operation: "instance.upsert", guid: item.parentGuid, role: "parent" });
    validateAddParent(item, parent);

    const children = Array.isArray(parent.LuaChildren) ? parent.LuaChildren : [];
    parent.LuaChildren = children;
    const guid = makeActorGuid();
    const properties = applyMobilityWritePolicy(
      root,
      guid,
      item.properties,
      options,
      parent === findWorkspaceNode(root),
    );
    const node: OvdrjmNode = {
      InstanceType: item.class,
      ActorGuid: guid,
      ObjectKey: nextObjectKey(document),
      Name: item.name,
      ...properties,
    };
    children.push(node);
    added.push({ guid: String(node.ActorGuid), name: item.name, class: item.class });
  }
  return added;
}

/** Applies name/property patches without injecting create defaults. */
export function updateInstancesInDocument(
  root: OvdrjmNode,
  items: readonly InstanceDocumentUpdateItem[],
  options: InstanceDocumentWriteOptions = {},
): string[] {
  for (const item of items) {
    const target = findNodeByActorGuid(root, item.guid);
    if (!target) throw missingGuidError({ operation: "instance.upsert", guid: item.guid, role: "target" });
    const targetClass = typeof target.InstanceType === "string" ? target.InstanceType : "Instance";
    const parsedProperties = parseInstancePatchProperties(targetClass, item.properties);
    const properties = applyMobilityWritePolicy(root, item.guid, parsedProperties, options);
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
