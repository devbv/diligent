// @summary Derives scene-mutation ops by diffing a snapshot against runner output.

import type { ProceduralAddNode, ProceduralOp, ProceduralSceneNode, ProceduralSerializedNode } from "./types";

/**
 * Properties a transform script may read and mutate. Anything outside this set
 * is neither injected into the runner nor diffed — it stays untouched in the
 * scene. `WorldPivot` is the Model analog of a Part's `CFrame`.
 */
export const DIFF_PROPERTY_WHITELIST = ["CFrame", "Size", "Color", "Material", "WorldPivot"] as const;

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

function pickWhitelisted(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const key of DIFF_PROPERTY_WHITELIST) {
    if (props[key] !== undefined) out[key] = props[key];
  }
  return out;
}

/** The subset of `next`'s whitelisted props that differ from `prev`. */
function changedProps(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of DIFF_PROPERTY_WHITELIST) {
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
}

/** Flattens a scene subtree into a `guid -> entry` map. The root is the target parent and is excluded. */
function buildSnapshotMap(root: ProceduralSceneNode | undefined): Map<string, SnapshotEntry> {
  const map = new Map<string, SnapshotEntry>();
  if (!root) return map;
  const walk = (node: ProceduralSceneNode, depth: number): void => {
    map.set(node.guid, { name: node.name, props: pickWhitelisted(node.properties), depth });
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const child of root.children ?? []) walk(child, 1);
  return map;
}

function toAddNode(node: ProceduralSerializedNode): ProceduralAddNode {
  const children = node.children?.map(toAddNode) ?? [];
  return {
    class: node.class,
    name: node.name,
    properties: node.properties ?? {},
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Diffs the runner's final tree against the injected snapshot to produce ops:
 * - guid in both, whitelisted props/name differ -> `update` (changed keys only)
 * - guid in snapshot, absent from output -> `delete`
 * - node without a guid -> `add` (whole fresh subtree)
 *
 * With no scene (pure generate), every top-level node is a fresh `add`.
 */
export function deriveProceduralOps(
  finalChildren: ProceduralSerializedNode[],
  scene: ProceduralSceneNode | undefined,
  targetGuid: string | undefined,
): ProceduralOp[] {
  const snapshot = buildSnapshotMap(scene);
  const ops: ProceduralOp[] = [];
  const seen = new Set<string>();

  const walk = (nodes: ProceduralSerializedNode[], parentGuid: string | undefined): void => {
    for (const node of nodes) {
      if (node.guid) {
        seen.add(node.guid);
        const snap = snapshot.get(node.guid);
        if (snap) {
          const changed = changedProps(snap.props, pickWhitelisted(node.properties));
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
        }
        // A guid absent from the snapshot means a reparent into a fresh subtree
        // (unsupported in MVP); recurse so its own descendants still diff.
        walk(node.children ?? [], node.guid);
      } else {
        ops.push({ kind: "add", parentGuid, node: toAddNode(node) });
      }
    }
  };
  walk(finalChildren, targetGuid);

  for (const [guid, entry] of snapshot) {
    if (!seen.has(guid)) ops.push({ kind: "delete", guid, depth: entry.depth });
  }
  return ops;
}
