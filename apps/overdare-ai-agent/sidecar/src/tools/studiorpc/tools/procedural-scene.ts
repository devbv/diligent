// @summary Reads a level subtree into an injectable procedural scene snapshot.

import type { ProceduralSceneNode } from "../../../procedural/types";
import { pickKnownInstanceProperties } from "../methods/instance-properties";
import { findNodeByActorGuid, isRecord, type OvdrjmNode, readOvdrjmRoot } from "./ovdrjm-utils";

function toSceneNode(node: OvdrjmNode): ProceduralSceneNode | undefined {
  const guid = typeof node.ActorGuid === "string" ? node.ActorGuid : undefined;
  if (!guid) return undefined;
  const children: ProceduralSceneNode[] = [];
  if (Array.isArray(node.LuaChildren)) {
    for (const child of node.LuaChildren) {
      if (!isRecord(child)) continue;
      const sceneChild = toSceneNode(child as OvdrjmNode);
      if (sceneChild) children.push(sceneChild);
    }
  }
  return {
    class: typeof node.InstanceType === "string" ? node.InstanceType : "Instance",
    name: typeof node.Name === "string" ? node.Name : "",
    guid,
    properties: pickKnownInstanceProperties(
      typeof node.InstanceType === "string" ? node.InstanceType : "Instance",
      node,
    ),
    children,
  };
}

/**
 * Reads the subtree rooted at `targetGuid` from the current level and returns it
 * as an injectable scene snapshot (canonical class properties only). The returned
 * root's `children` are the mutable scene contents; the root itself is the
 * target parent and carries `targetGuid`.
 */
export function readProceduralScene(cwd: string, targetGuid: string): ProceduralSceneNode {
  const { root } = readOvdrjmRoot(cwd);
  const target = findNodeByActorGuid(root, targetGuid);
  if (!target) {
    throw new Error(`Target GUID not found in the current level: ${targetGuid}`);
  }
  const scene = toSceneNode(target);
  if (!scene) {
    throw new Error(`Target GUID ${targetGuid} has no ActorGuid and cannot be used as a scene root.`);
  }
  return scene;
}

/** Returns the Workspace service GUID, the default scene root for one-shot runs. */
export function findWorkspaceGuid(cwd: string): string | undefined {
  const { root } = readOvdrjmRoot(cwd);
  if (root.InstanceType === "Workspace" && typeof root.ActorGuid === "string") {
    return root.ActorGuid;
  }
  const found = findByInstanceType(root, "Workspace");
  return found && typeof found.ActorGuid === "string" ? found.ActorGuid : undefined;
}

function findByInstanceType(node: OvdrjmNode, instanceType: string): OvdrjmNode | undefined {
  if (node.InstanceType === instanceType) return node;
  if (!Array.isArray(node.LuaChildren)) return undefined;
  for (const child of node.LuaChildren) {
    if (!isRecord(child)) continue;
    const found = findByInstanceType(child as OvdrjmNode, instanceType);
    if (found) return found;
  }
  return undefined;
}

/** Read-only check that a GUID still exists in the current level. */
export function guidExistsInScene(cwd: string, guid: string): boolean {
  const { root } = readOvdrjmRoot(cwd);
  return findNodeByActorGuid(root, guid) !== undefined;
}
