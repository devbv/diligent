// @summary Derives scene-mutation ops by diffing a snapshot against runner output.

import type { ProceduralInstanceRef, ProceduralOp, ProceduralSceneNode, ProceduralSerializedNode } from "./types";

/** Scene properties are projected from the canonical class schemas before reaching this generic diff layer. */
const NUMERIC_EPSILON = 1e-6;

/** Deep equality with a small tolerance on numeric leaves (float-noise safe). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= NUMERIC_EPSILON;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!valuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** The subset of `next`'s schema-projected properties that differ from `prev`. */
function changedProps(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    const nextValue = next[key];
    if (nextValue === undefined) continue;
    if (!valuesEqual(prev[key], nextValue)) changed[key] = nextValue;
  }
  return changed;
}

interface SnapshotEntry {
  name: string;
  props: Record<string, unknown>;
  depth: number;
  parentGuid: string;
}

/** Flattens a scene subtree into a `guid -> entry` map. The root is the target parent and is excluded. */
function buildSnapshotMap(root: ProceduralSceneNode | undefined): Map<string, SnapshotEntry> {
  const map = new Map<string, SnapshotEntry>();
  if (!root) return map;
  const walk = (node: ProceduralSceneNode, depth: number, parentGuid: string): void => {
    map.set(node.guid, { name: node.name, props: node.properties, depth, parentGuid });
    for (const child of node.children ?? []) walk(child, depth + 1, node.guid);
  };
  for (const child of root.children ?? []) walk(child, 1, root.guid);
  return map;
}

function sameRef(a: ProceduralInstanceRef, b: ProceduralInstanceRef): boolean {
  if (a.kind === "existing") return b.kind === "existing" && a.guid === b.guid;
  return b.kind === "generated" && a.localId === b.localId;
}

function requireTargetRef(
  scene: ProceduralSceneNode | undefined,
  targetGuid: string | undefined,
): ProceduralInstanceRef {
  const guid = targetGuid ?? scene?.guid;
  if (typeof guid !== "string" || guid.length === 0) {
    throw new Error("Procedural operation planning requires a non-empty targetGuid.");
  }
  return { kind: "existing", guid };
}

function validateIdentity(node: ProceduralSerializedNode): void {
  const hasGuid = typeof node.guid === "string" && node.guid.length > 0;
  const hasLocalId = typeof node.localId === "string" && node.localId.length > 0;
  if (hasGuid === hasLocalId) {
    throw new Error(
      `Serialized procedural node "${node.name}" must have exactly one non-empty identity: guid or localId.`,
    );
  }
}

/**
 * Diffs the runner's final tree against the injected snapshot to produce ops:
 * - guid in both, schema-projected props/name differ -> `update` (changed keys only)
 * - guid in both, parent guid differs -> `move`
 * - guid in snapshot, absent from output -> `delete`
 * - node with a localId -> flat `add`
 *
 * With no scene (pure generate), every top-level node is a fresh `add`.
 */
export function deriveProceduralOps(
  finalChildren: ProceduralSerializedNode[],
  scene: ProceduralSceneNode | undefined,
  targetGuid: string | undefined,
  finalSceneRoot?: ProceduralSerializedNode,
): ProceduralOp[] {
  const snapshot = buildSnapshotMap(scene);
  const ops: ProceduralOp[] = [];
  const seen = new Set<string>();
  const seenLocalIds = new Set<string>();
  const targetRef = requireTargetRef(scene, targetGuid);

  if (finalSceneRoot) {
    validateIdentity(finalSceneRoot);
    if (!scene) throw new Error("Generate-only procedural output must not include an injected scene root.");
    if (finalSceneRoot.guid !== scene.guid) {
      throw new Error(
        `Procedural target root identity changed from ${scene.guid} to ${finalSceneRoot.guid ?? "generated"}.`,
      );
    }
    const changed = changedProps(scene.properties, finalSceneRoot.properties ?? {});
    const nameChanged = finalSceneRoot.name !== scene.name;
    if (Object.keys(changed).length > 0 || nameChanged) {
      ops.push({
        kind: "update",
        guid: scene.guid,
        class: finalSceneRoot.class,
        ...(nameChanged ? { name: finalSceneRoot.name } : {}),
        properties: changed,
      });
    }
  }

  const walk = (nodes: ProceduralSerializedNode[], parent: ProceduralInstanceRef): void => {
    for (const node of nodes) {
      validateIdentity(node);
      if (node.guid) {
        if (seen.has(node.guid)) throw new Error(`Duplicate existing guid in procedural output: ${node.guid}`);
        seen.add(node.guid);
        const snap = snapshot.get(node.guid);
        if (!snap) throw new Error(`Procedural output references unknown existing guid: ${node.guid}`);
        const snapshotParent: ProceduralInstanceRef = { kind: "existing", guid: snap.parentGuid };
        if (!sameRef(snapshotParent, parent)) {
          ops.push({ kind: "move", guid: node.guid, parent });
        }
        const changed = changedProps(snap.props, node.properties ?? {});
        const nameChanged = node.name !== snap.name;
        if (Object.keys(changed).length > 0 || nameChanged) {
          ops.push({
            kind: "update",
            guid: node.guid,
            class: node.class,
            ...(nameChanged ? { name: node.name } : {}),
            properties: changed,
          });
        }
        walk(node.children ?? [], { kind: "existing", guid: node.guid });
      } else {
        const localId = node.localId as string;
        if (seenLocalIds.has(localId)) throw new Error(`Duplicate procedural localId: ${localId}`);
        seenLocalIds.add(localId);
        ops.push({
          kind: "add",
          localId,
          parent,
          class: node.class,
          name: node.name,
          properties: node.properties ?? {},
        });
        walk(node.children ?? [], { kind: "generated", localId });
      }
    }
  };
  walk(finalChildren, targetRef);

  for (const [guid, entry] of snapshot) {
    if (!seen.has(guid)) ops.push({ kind: "delete", guid, depth: entry.depth });
  }
  return ops;
}
