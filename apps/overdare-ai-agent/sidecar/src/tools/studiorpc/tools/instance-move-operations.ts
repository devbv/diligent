// @summary Validates and applies hierarchy-only instance moves inside an ovdrjm document.

import { serviceClassEnum } from "../methods/instance.params";
import { invalidInstanceOperationError, missingGuidError } from "./instance-status";
import {
  clearStaleWorldTransforms,
  findNodeByActorGuid,
  isRecord,
  type OvdrjmNode,
  removeNodeByActorGuid,
} from "./ovdrjm-utils";

export interface InstanceMoveItem {
  guid: string;
  parentGuid: string;
}

export interface ValidateInstanceMovesOptions {
  unavailableGuids?: ReadonlySet<string>;
}

const serviceClasses = new Set<string>(serviceClassEnum.options);

function hierarchyParents(root: OvdrjmNode): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>();
  const walk = (node: OvdrjmNode, parentGuid: string | undefined): void => {
    const guid = typeof node.ActorGuid === "string" ? node.ActorGuid : undefined;
    if (guid) parents.set(guid, parentGuid);
    if (!Array.isArray(node.LuaChildren)) return;
    for (const child of node.LuaChildren) {
      if (isRecord(child)) walk(child as OvdrjmNode, guid);
    }
  };
  walk(root, undefined);
  return parents;
}

function invalidMove(
  guid: string,
  code: "hierarchy_cycle" | "duplicate_move" | "conflicting_operation",
  message: string,
) {
  return invalidInstanceOperationError({
    operation: "instance.move",
    code,
    guid,
    role: "target",
    message,
  });
}

/** Validates the final parent graph for a complete batch without mutating it. */
export function validateInstanceMoves(
  root: OvdrjmNode,
  items: readonly InstanceMoveItem[],
  options: ValidateInstanceMovesOptions = {},
): void {
  const finalParents = hierarchyParents(root);
  const seenTargets = new Set<string>();

  for (const item of items) {
    if (seenTargets.has(item.guid)) {
      throw invalidMove(item.guid, "duplicate_move", `Instance ${item.guid} is moved more than once in one batch.`);
    }
    seenTargets.add(item.guid);

    const target = findNodeByActorGuid(root, item.guid);
    if (!target) throw missingGuidError({ operation: "instance.move", guid: item.guid, role: "target" });
    const targetClass = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
    if (targetClass && serviceClasses.has(targetClass)) {
      throw invalidInstanceOperationError({
        operation: "instance.move",
        code: "protected_service_class",
        guid: item.guid,
        role: "target",
        class: targetClass,
        message: `"${targetClass}" is a Service and cannot be moved.`,
      });
    }

    if (!findNodeByActorGuid(root, item.parentGuid)) {
      throw missingGuidError({ operation: "instance.move", guid: item.parentGuid, role: "new_parent" });
    }
    if (options.unavailableGuids?.has(item.guid) || options.unavailableGuids?.has(item.parentGuid)) {
      throw invalidMove(
        item.guid,
        "conflicting_operation",
        `Move ${item.guid} -> ${item.parentGuid} conflicts with a delete in the same operation set.`,
      );
    }
    finalParents.set(item.guid, item.parentGuid);
  }

  for (const item of items) {
    const visited = new Set<string>();
    let cursor: string | undefined = item.guid;
    while (cursor !== undefined) {
      if (visited.has(cursor)) {
        throw invalidMove(
          item.guid,
          "hierarchy_cycle",
          `Moving ${item.guid} under ${item.parentGuid} would create a hierarchy cycle through itself or a descendant.`,
        );
      }
      visited.add(cursor);
      cursor = finalParents.get(cursor);
    }
  }
}

/** Applies a previously validated batch to an in-memory ovdrjm root. */
export function moveInstancesInDocument(root: OvdrjmNode, items: readonly InstanceMoveItem[]): string[] {
  const resolved = items.map((item) => {
    const target = findNodeByActorGuid(root, item.guid);
    const parent = findNodeByActorGuid(root, item.parentGuid);
    if (!target || !parent)
      throw new Error(`Validated move references disappeared: ${item.guid} -> ${item.parentGuid}`);
    return { item, target, parent };
  });

  for (const { item, target, parent } of resolved) {
    if (!removeNodeByActorGuid(root, item.guid)) {
      throw new Error(`Failed to detach ActorGuid from .ovdrjm: ${item.guid}`);
    }
    const children = Array.isArray(parent.LuaChildren) ? parent.LuaChildren : [];
    parent.LuaChildren = children;
    children.push(target);
    delete target.WorldTransform;
    clearStaleWorldTransforms(target);
  }
  return items.map((item) => item.guid);
}
