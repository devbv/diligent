// @summary Atomically validates and applies a complete symbolic procedural plan.

import type { ProceduralAddOp, ProceduralInstanceRef, ProceduralMoveOp, ProceduralOp } from "../../../procedural/types";
import { serviceClassEnum } from "../methods/instance.params";
import { collectUiDiagnostics } from "../methods/instance.upsert";
import { parseInstanceCreateProperties, parseInstancePatchProperties } from "../methods/instance-properties";
import { applyLevelChanges } from "../rpc";
import {
  addInstancesInDocument,
  deleteInstancesInDocument,
  requireDocumentRoot,
  updateInstancesInDocument,
} from "./instance-document-operations";
import { moveInstancesInDocument } from "./instance-move-operations";
import { isRecord, type OvdrjmNode, readAndWriteOvdrjm } from "./ovdrjm-utils";

export interface ApplyProceduralOpsResult {
  addCount: number;
  updateCount: number;
  moveCount: number;
  deleteCount: number;
  /** Number of .ovdrjm document transactions, now always zero or one. */
  batches: number;
  addedGuids: string[];
  updatedGuids: string[];
  movedGuids: string[];
  deletedGuids: string[];
  skippedDeletes: string[];
  rootGuids: string[];
  warnings: string[];
  info: string[];
}

interface ExistingEntry {
  className: string;
  parentGuid?: string;
}

interface ProceduralPlan {
  adds: ProceduralAddOp[];
  updates: Extract<ProceduralOp, { kind: "update" }>[];
  moves: ProceduralMoveOp[];
  deletes: Extract<ProceduralOp, { kind: "delete" }>[];
}

const serviceClasses = new Set<string>(serviceClassEnum.options);

function existingKey(guid: string): string {
  return `guid:${guid}`;
}

function generatedKey(localId: string): string {
  return `local:${localId}`;
}

function refKey(ref: ProceduralInstanceRef): string {
  return ref.kind === "existing" ? existingKey(ref.guid) : generatedKey(ref.localId);
}

function indexExisting(root: OvdrjmNode): Map<string, ExistingEntry> {
  const entries = new Map<string, ExistingEntry>();
  const walk = (node: OvdrjmNode, parentGuid?: string): void => {
    const guid = typeof node.ActorGuid === "string" ? node.ActorGuid : undefined;
    const className = typeof node.InstanceType === "string" ? node.InstanceType : "Instance";
    if (guid) entries.set(guid, { className, parentGuid });
    if (!Array.isArray(node.LuaChildren)) return;
    for (const child of node.LuaChildren) {
      if (isRecord(child)) walk(child as OvdrjmNode, guid);
    }
  };
  walk(root);
  return entries;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must be non-empty.`);
}

function assertRefExists(
  ref: ProceduralInstanceRef,
  existing: ReadonlyMap<string, ExistingEntry>,
  addsByLocalId: ReadonlyMap<string, ProceduralAddOp>,
): void {
  if (ref.kind === "existing") {
    assertNonEmpty(ref.guid, "Existing instance guid");
    if (!existing.has(ref.guid)) throw new Error(`Procedural plan references missing existing instance: ${ref.guid}`);
    return;
  }
  assertNonEmpty(ref.localId, "Generated instance localId");
  if (!addsByLocalId.has(ref.localId)) {
    throw new Error(`Unresolved generated instance reference: ${ref.localId}`);
  }
}

function assertMaterialVariantParent(targetClass: string, parentClass: string, targetIdentity: string): void {
  if (targetClass === "MaterialVariant" && parentClass !== "MaterialService") {
    throw new Error(
      `MaterialVariant ${targetIdentity} can only be parented under MaterialService, but parent is ${parentClass}.`,
    );
  }
}

function validateAcyclicFinalGraph(finalParents: ReadonlyMap<string, string | undefined>): void {
  for (const start of finalParents.keys()) {
    const visited = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (visited.has(cursor)) throw new Error(`Procedural final hierarchy contains a cycle involving ${cursor}.`);
      visited.add(cursor);
      cursor = finalParents.get(cursor);
    }
  }
}

/** Validates and normalizes the complete symbolic graph before the first mutation. */
function preflightProceduralPlan(root: OvdrjmNode, ops: readonly ProceduralOp[], targetGuid: string): ProceduralPlan {
  const existing = indexExisting(root);
  if (!existing.has(targetGuid)) throw new Error(`Procedural target does not exist: ${targetGuid}`);

  const addsByLocalId = new Map<string, ProceduralAddOp>();
  for (const op of ops) {
    if (op.kind !== "add") continue;
    assertNonEmpty(op.localId, "Generated instance localId");
    if (addsByLocalId.has(op.localId)) throw new Error(`Duplicate procedural localId: ${op.localId}`);
    addsByLocalId.set(op.localId, op);
  }

  const deletes = ops
    .filter((op): op is Extract<ProceduralOp, { kind: "delete" }> => op.kind === "delete")
    .sort((a, b) => b.depth - a.depth);
  const deletedGuids = new Set(deletes.map((op) => op.guid));
  const moves: ProceduralMoveOp[] = [];
  const seenMoveTargets = new Set<string>();
  const updates: Extract<ProceduralOp, { kind: "update" }>[] = [];
  const adds: ProceduralAddOp[] = [];

  for (const op of ops) {
    if (op.kind === "add") {
      assertRefExists(op.parent, existing, addsByLocalId);
      adds.push({ ...op, properties: parseInstanceCreateProperties(op.class, op.properties) });
      continue;
    }
    if (op.kind === "update") {
      const target = existing.get(op.guid);
      if (!target) throw new Error(`Procedural update target does not exist: ${op.guid}`);
      if (deletedGuids.has(op.guid)) {
        throw new Error(`Procedural instance ${op.guid} cannot be both updated and deleted.`);
      }
      updates.push({
        ...op,
        class: target.className,
        properties: parseInstancePatchProperties(target.className, op.properties),
      });
      continue;
    }
    if (op.kind === "move") {
      const target = existing.get(op.guid);
      if (!target) throw new Error(`Procedural move target does not exist: ${op.guid}`);
      if (serviceClasses.has(target.className) || op.guid === root.ActorGuid) {
        throw new Error(`Protected scene instance ${op.guid} (${target.className}) cannot be moved.`);
      }
      if (seenMoveTargets.has(op.guid)) throw new Error(`Instance ${op.guid} is moved more than once.`);
      if (deletedGuids.has(op.guid)) throw new Error(`Instance ${op.guid} cannot be both moved and deleted.`);
      seenMoveTargets.add(op.guid);
      assertRefExists(op.parent, existing, addsByLocalId);
      moves.push(op);
    }
  }

  const finalParents = new Map<string, string | undefined>();
  for (const [guid, entry] of existing) {
    finalParents.set(existingKey(guid), entry.parentGuid ? existingKey(entry.parentGuid) : undefined);
  }
  for (const op of adds) finalParents.set(generatedKey(op.localId), refKey(op.parent));
  for (const op of moves) finalParents.set(existingKey(op.guid), refKey(op.parent));
  validateAcyclicFinalGraph(finalParents);

  const parentKeys = [...adds.map((op) => refKey(op.parent)), ...moves.map((op) => refKey(op.parent))];
  for (const parentKey of parentKeys) {
    let cursor: string | undefined = parentKey;
    const visited = new Set<string>();
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      if (cursor.startsWith("guid:") && deletedGuids.has(cursor.slice("guid:".length))) {
        throw new Error(`Procedural parent ${cursor.slice("guid:".length)} is deleted by the same plan.`);
      }
      cursor = finalParents.get(cursor);
    }
  }

  const classForRef = (ref: ProceduralInstanceRef): string => {
    if (ref.kind === "existing") return existing.get(ref.guid)?.className ?? "Instance";
    return addsByLocalId.get(ref.localId)?.class ?? "Instance";
  };
  for (const op of adds) assertMaterialVariantParent(op.class, classForRef(op.parent), op.localId);
  for (const op of moves) {
    assertMaterialVariantParent(existing.get(op.guid)?.className ?? "Instance", classForRef(op.parent), op.guid);
  }

  return { adds, updates, moves, deletes };
}

function resolveInstanceRef(ref: ProceduralInstanceRef, generatedGuids: ReadonlyMap<string, string>): string {
  if (ref.kind === "existing") return ref.guid;
  const guid = generatedGuids.get(ref.localId);
  if (!guid) throw new Error(`Unresolved generated instance: ${ref.localId}`);
  return guid;
}

function applyGeneratedAdds(document: Record<string, unknown>, adds: readonly ProceduralAddOp[]): Map<string, string> {
  const generatedGuids = new Map<string, string>();
  let pending = [...adds];
  while (pending.length > 0) {
    const ready = pending.filter((op) => op.parent.kind === "existing" || generatedGuids.has(op.parent.localId));
    if (ready.length === 0) {
      throw new Error(`Unresolved or cyclic generated add dependencies: ${pending.map((op) => op.localId).join(", ")}`);
    }
    const added = addInstancesInDocument(
      document,
      ready.map((op) => ({
        class: op.class,
        parentGuid: resolveInstanceRef(op.parent, generatedGuids),
        name: op.name,
        properties: op.properties,
      })),
    );
    if (added.length !== ready.length) {
      throw new Error(`Added ${added.length} generated instances for ${ready.length} ready operations.`);
    }
    for (let index = 0; index < ready.length; index++) {
      const guid = added[index]?.guid;
      if (!guid) throw new Error(`Studio did not allocate a GUID for generated instance ${ready[index].localId}.`);
      generatedGuids.set(ready[index].localId, guid);
    }
    const readyIds = new Set(ready.map((op) => op.localId));
    pending = pending.filter((op) => !readyIds.has(op.localId));
  }
  return generatedGuids;
}

/** Applies all operations in one file transaction and calls Studio exactly once afterward. */
export async function applyProceduralOps(
  ops: ProceduralOp[],
  options: { targetGuid: string; cwd: string },
): Promise<ApplyProceduralOpsResult> {
  const { targetGuid, cwd } = options;
  const fileResult = readAndWriteOvdrjm(cwd, (document) => {
    const root = requireDocumentRoot(document);
    const plan = preflightProceduralPlan(root, ops, targetGuid);
    const generatedGuids = applyGeneratedAdds(document, plan.adds);

    const resolvedMoves = plan.moves.map((op) => ({
      guid: op.guid,
      parentGuid: resolveInstanceRef(op.parent, generatedGuids),
    }));
    const movedGuids = moveInstancesInDocument(root, resolvedMoves);
    const { deletedGuids, skippedGuids } = deleteInstancesInDocument(
      root,
      plan.deletes.map((op) => op.guid),
      { skipMissing: true },
    );
    const updatedGuids = updateInstancesInDocument(root, plan.updates);
    const addedGuids = plan.adds.map((op) =>
      resolveInstanceRef({ kind: "generated", localId: op.localId }, generatedGuids),
    );
    const rootGuids = plan.adds.flatMap((op) =>
      op.parent.kind === "existing" && op.parent.guid === targetGuid
        ? [resolveInstanceRef({ kind: "generated", localId: op.localId }, generatedGuids)]
        : [],
    );
    const diagnostics = collectUiDiagnostics(root);

    return {
      result: {
        addCount: addedGuids.length,
        updateCount: updatedGuids.length,
        moveCount: movedGuids.length,
        deleteCount: deletedGuids.length,
        batches: ops.length > 0 ? 1 : 0,
        addedGuids,
        updatedGuids,
        movedGuids,
        deletedGuids,
        skippedDeletes: skippedGuids,
        rootGuids,
        warnings: diagnostics.warnings,
        info: diagnostics.info,
      } satisfies ApplyProceduralOpsResult,
    };
  });

  await applyLevelChanges();
  return fileResult.result;
}
