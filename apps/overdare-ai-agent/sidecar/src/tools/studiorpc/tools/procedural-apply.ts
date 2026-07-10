// @summary Shared L1 applier: applies procedural ops (add/update/delete) to the level.

import type { ProceduralAddNode, ProceduralOp } from "../../../procedural/types";
import * as instanceUpsert from "../methods/instance.upsert";
import { applyLevelChanges } from "../rpc";
import { executeInstanceUpsertInner } from "./instance-upsert-tool";
import { isRecord, type OvdrjmNode, readAndWriteOvdrjm, removeNodeByActorGuid } from "./ovdrjm-utils";

/** Instances created/updated per level write; batching keeps single writes bounded. */
export const PROCEDURAL_APPLY_BATCH_SIZE = 100;

export interface ApplyProceduralOpsResult {
  addCount: number;
  updateCount: number;
  deleteCount: number;
  batches: number;
  addedGuids: string[];
  updatedGuids: string[];
  deletedGuids: string[];
  /** Delete targets that were already missing (e.g. a parent removed first). */
  skippedDeletes: string[];
  /** GUIDs of nodes added directly under the run's target (the model roots). */
  rootGuids: string[];
}

type UpsertParsedArgs = ReturnType<typeof instanceUpsert.parseArgs>;

interface ApplyAccumulator {
  addCount: number;
  batches: number;
  addedGuids: string[];
}

/**
 * Creates a fresh subtree parent-first, reusing the live GUID returned for each
 * parent as its children's `parentGuid`. Mirrors the add-only apply path.
 */
async function createSubtrees(
  nodes: ProceduralAddNode[],
  parentGuid: string,
  cwd: string,
  acc: ApplyAccumulator,
  directGuids?: string[],
): Promise<void> {
  for (let start = 0; start < nodes.length; start += PROCEDURAL_APPLY_BATCH_SIZE) {
    const batch = nodes.slice(start, start + PROCEDURAL_APPLY_BATCH_SIZE);
    // Adds route through parseArgs so class-schema defaults (Anchored, CanCollide, …) are applied.
    const parsed = instanceUpsert.parseArgs({
      items: batch.map((node) => ({
        class: node.class,
        parentGuid,
        name: node.name,
        properties: node.properties ?? {},
      })),
    });
    const result = await executeInstanceUpsertInner(parsed, cwd, { applyAndSaveChanges: false });
    const added = (result.metadata as { added?: { guid: string }[] } | undefined)?.added ?? [];
    if (added.length !== batch.length) {
      throw new Error(`Studio returned ${added.length} GUIDs for ${batch.length} generated nodes.`);
    }
    acc.batches += 1;
    acc.addCount += batch.length;
    for (let index = 0; index < batch.length; index++) {
      const addedGuid = added[index]?.guid;
      if (!addedGuid) {
        throw new Error(`Studio did not return a GUID for generated node ${batch[index].name}.`);
      }
      acc.addedGuids.push(addedGuid);
      directGuids?.push(addedGuid);
      await createSubtrees(batch[index].children ?? [], addedGuid, cwd, acc);
    }
  }
}

/**
 * Applies procedural ops in the order delete -> update -> add, then applies the
 * level once. Deletes run deepest-first and silently skip already-missing GUIDs
 * (removing a parent orphans its subtree). Updates apply only their changed
 * whitelisted properties — they deliberately bypass `parseArgs` so class-schema
 * defaults are not written onto existing instances.
 */
export async function applyProceduralOps(
  ops: ProceduralOp[],
  options: { targetGuid: string; cwd: string },
): Promise<ApplyProceduralOpsResult> {
  const { targetGuid, cwd } = options;
  const result: ApplyProceduralOpsResult = {
    addCount: 0,
    updateCount: 0,
    deleteCount: 0,
    batches: 0,
    addedGuids: [],
    updatedGuids: [],
    deletedGuids: [],
    skippedDeletes: [],
    rootGuids: [],
  };

  // 1. Deletes, deepest-first, skipping guids already orphaned by an earlier removal.
  const deletes = ops
    .filter((op): op is Extract<ProceduralOp, { kind: "delete" }> => op.kind === "delete")
    .sort((a, b) => b.depth - a.depth);
  if (deletes.length > 0) {
    readAndWriteOvdrjm(cwd, (rootDoc) => {
      const root = rootDoc.Root;
      if (!isRecord(root)) {
        throw new Error("Invalid .ovdrjm format: Root object is missing.");
      }
      for (const op of deletes) {
        if (removeNodeByActorGuid(root as OvdrjmNode, op.guid)) {
          result.deletedGuids.push(op.guid);
        } else {
          result.skippedDeletes.push(op.guid);
        }
      }
      return {};
    });
    result.deleteCount = result.deletedGuids.length;
  }

  // 2. Updates — minimal changed-property writes, no schema defaults.
  const updates = ops.filter((op): op is Extract<ProceduralOp, { kind: "update" }> => op.kind === "update");
  for (let start = 0; start < updates.length; start += PROCEDURAL_APPLY_BATCH_SIZE) {
    const batch = updates.slice(start, start + PROCEDURAL_APPLY_BATCH_SIZE);
    const parsed = {
      items: batch.map((op) => ({
        guid: op.guid,
        ...(op.name !== undefined ? { name: op.name } : {}),
        properties: op.properties,
      })),
    } as UpsertParsedArgs;
    await executeInstanceUpsertInner(parsed, cwd, { applyAndSaveChanges: false });
    result.batches += 1;
    result.updateCount += batch.length;
    result.updatedGuids.push(...batch.map((op) => op.guid));
  }

  // 3. Adds — grouped by resolved parent so siblings batch together.
  const addGroups = new Map<string, ProceduralAddNode[]>();
  for (const op of ops) {
    if (op.kind !== "add") continue;
    const parentGuid = op.parentGuid ?? targetGuid;
    const group = addGroups.get(parentGuid) ?? [];
    group.push(op.node);
    addGroups.set(parentGuid, group);
  }
  const addAcc: ApplyAccumulator = { addCount: 0, batches: 0, addedGuids: [] };
  for (const [parentGuid, nodes] of addGroups) {
    // Direct children of the run's target are the model roots (recorded for idempotent replace).
    const directGuids = parentGuid === targetGuid ? result.rootGuids : undefined;
    await createSubtrees(nodes, parentGuid, cwd, addAcc, directGuids);
  }
  result.addCount = addAcc.addCount;
  result.batches += addAcc.batches;
  result.addedGuids.push(...addAcc.addedGuids);

  await applyLevelChanges();
  return result;
}
