---
id: P075-HANDOFF
parent: P074
created: 2026-07-12
status: active
---

# P075 Hand-off: Symbolic Instance References and Atomic Procedural Apply

## Why this hand-off exists

P074 now supports end-state-diffed procedural add, update, move, and delete operations. An existing scene instance can
be reparented under another existing scene instance with normal Luau syntax:

```lua
local child = workspace:FindFirstChild("Child", true)
local destination = workspace:FindFirstChild("Destination", true)
child.Parent = destination
```

The remaining hierarchy gap is moving an existing instance below a parent created in the same procedural run:

```lua
local folder = Instance.new("Folder")
folder.Name = "GeneratedFolder"
folder.Parent = workspace

local child = workspace:FindFirstChild("Child", true)
child.Parent = folder
```

The generated folder has no Studio GUID until apply time. The current op model assumes every move parent already has
a GUID, so the runtime deliberately rejects this case instead of incorrectly converting the existing child into a
delete plus add.

This hand-off locks the structural solution: preserve the end-state diff, introduce symbolic existing/generated
instance references, flatten generated adds into a plan, and apply the complete plan in one document transaction.

Read alongside:

- `docs/plan/feature/P074-procedural-toolification-handoff.md`
- `.diligent/skills/procedural-luau-json/SKILL.md`
- `apps/overdare-ai-agent/sidecar/src/procedural/types.ts`
- `apps/overdare-ai-agent/sidecar/src/procedural/ops.ts`
- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/procedural-apply.ts`

## Worktree and verification baseline

As of 2026-07-12:

- Branch: `p072-procedural-toolification`
- HEAD: `e080d2a8 add movable`
- The worktree is intentionally dirty and contains the P074 follow-up implementation. Do not reset or discard it.
- Full TypeScript typecheck passes.
- All sidecar tests pass: 148 tests, 489 expectations.
- Biome checks on touched files and `git diff --check` pass.

The dirty worktree includes both user-authored procedural geometry work and the property/move work summarized below.
Preserve unrelated changes, especially in `GeometryPrimitives.lua`, `MathUtils.lua`, the procedural examples/tests, and
the procedural geometry guide.

## Current implemented state

### Canonical property support

- `instance.params.ts` remains the source of truth for class/property schemas.
- `instance-properties.ts` provides class-bound create validation, patch validation without default injection, and
  schema-derived scene projection.
- The Luau shim uses a generic property bag. New upsert-supported classes do not need per-property Lua mappings.
- The fixed procedural property whitelist has been removed.
- The injected target root is also diffed, so updates such as `workspace.Gravity = 750` are applied.

### Existing-to-existing reparenting

- `ProceduralOp` includes `{ kind: "move", guid, parentGuid }`.
- The snapshot stores each existing node's `parentGuid`.
- The final tree diff emits a move when an existing node's parent GUID changes.
- `instance-move-operations.ts` is shared by direct `instance.move` and procedural apply.
- Move validation rejects missing references, protected services, duplicate move targets, delete conflicts, self-parent
  moves, descendant moves, and batch cycles.
- Procedural apply runs moves before deletes so a child can escape a subtree deleted by the same script.
- Tool output includes `moveCount` and `movedGuids`.

### Current explicit limitation

`ops.ts:toAddNode()` throws when it encounters an existing GUID inside a fresh subtree:

```text
Cannot move existing instance <guid> below a newly generated parent in this procedural runtime version.
```

This rejection is required until generated parents have a symbolic identity that can be resolved to a live GUID.
Do not remove the rejection without implementing the complete resolution/apply path described below.

## Design decisions locked for P075

### 1. Keep end-state diffing; do not add a Luau mutation event log

The script remains a pure scene transformation: snapshot in, final mock tree out. Parent assignment should mutate the
mock hierarchy, and TypeScript should derive the minimal final operation plan.

For example:

```lua
child.Parent = firstFolder
child.Parent = finalFolder
```

must produce one move to `finalFolder`, not two recorded moves that require compaction. The same rule handles a move
followed by `Destroy()`, repeated property assignments, and arbitrary helper/control flow without source analysis.

### 2. Give every fresh mock instance an execution-local symbolic identity

`ovdr-shim.lua` already assigns an opaque `Id` such as `node-42` in `Ovdr.createInstance()`. Serialize that value as
`localId` for fresh nodes. Injected nodes continue to serialize their real `guid`.

`localId` is:

- unique only within one Luau execution;
- never persisted in the level or model manifest;
- never treated as a stable regeneration identity;
- used only to connect operations before Studio GUID allocation.

A serialized node must have exactly one identity:

```ts
type ProceduralSerializedNode = {
  class: string;
  name: string;
  guid?: string; // injected/existing
  localId?: string; // freshly generated
  properties?: Record<string, unknown>;
  children?: ProceduralSerializedNode[];
};
```

Validate the XOR invariant: exactly one of `guid` or `localId` must be present in transform mode. Generate-only output
contains `localId` on every node.

### 3. Represent parents with a discriminated symbolic reference

Do not add loosely coupled optional fields such as `parentGuid?` plus `parentLocalId?`. Use one discriminated union so
invalid both/neither states are unrepresentable:

```ts
export type ProceduralInstanceRef =
  | { kind: "existing"; guid: string }
  | { kind: "generated"; localId: string };
```

The target root is an existing reference. A fresh node is a generated reference once its `localId` is known.

### 4. Flatten generated adds; stop treating every fresh subtree as an indivisible add

The current recursive `ProceduralAddNode.children` contract cannot safely represent a fresh parent containing both
fresh and existing children. Replace it with flat symbolic operations:

```ts
export type ProceduralAddOp = {
  kind: "add";
  localId: string;
  parent: ProceduralInstanceRef;
  class: string;
  name: string;
  properties: Record<string, unknown>;
};

export type ProceduralMoveOp = {
  kind: "move";
  guid: string;
  parent: ProceduralInstanceRef;
};

export type ProceduralOp =
  | ProceduralAddOp
  | { kind: "update"; guid: string; class: string; name?: string; properties: Record<string, unknown> }
  | ProceduralMoveOp
  | { kind: "delete"; guid: string; depth: number };
```

Hierarchy is expressed by `parent`, not by nested add children. This supports all mixtures:

- fresh child under existing parent;
- fresh child under fresh parent;
- existing child moved under existing parent;
- existing child moved under fresh parent;
- fresh descendants below an existing node that is itself moved.

### 5. Resolve local IDs during apply

Maintain one execution-local resolution map:

```ts
const generatedGuids = new Map<string, string>();
```

When an add succeeds:

```ts
generatedGuids.set(op.localId, liveGuid);
```

Resolve a parent reference with one function:

```ts
function resolveInstanceRef(ref: ProceduralInstanceRef): string {
  if (ref.kind === "existing") return ref.guid;
  const guid = generatedGuids.get(ref.localId);
  if (!guid) throw new Error(`Unresolved generated instance: ${ref.localId}`);
  return guid;
}
```

### 6. Apply the complete plan in one document transaction

Do not extend the current multi-write `createSubtrees()` loop as the final architecture. It reads/writes the level for
add batches and uses separate writes for move/delete/update. A late resolution or validation failure could otherwise
leave a partially applied file.

Extract document-level mutation primitives from the instance tools and run the complete procedural plan inside one
`readAndWriteOvdrjm()` callback:

```ts
const fileResult = readAndWriteOvdrjm(cwd, (document) => {
  const root = requireRoot(document);
  const plan = preflightProceduralPlan(root, ops);
  const generatedGuids = applyGeneratedAdds(document, root, plan.adds);
  applyResolvedMoves(root, plan.moves, generatedGuids);
  applyDeletes(root, plan.deletes);
  applyUpdates(root, plan.updates);
  return buildApplyResult(plan, generatedGuids);
});

await applyLevelChanges();
```

Throwing inside the callback must prevent the level file from being written. Verify this property of
`readAndWriteOvdrjm()` with a regression test before relying on it.

The outer procedural tool keeps its existing approval, write lock, and snapshot rollback wrapper. `applyLevelChanges()`
still runs once after the successful file transaction.

### 7. Public tool surface does not change

Do not add a `procedural_move` tool.

- Use `studiorpc_instance_move` for a few hand-picked instances.
- Use `studiorpc_procedural_run` for algorithmic/bulk hierarchy changes.
- Luau syntax remains normal `instance.Parent = parent` assignment.

## Target planner algorithm

Replace `toAddNode()` with a traversal that carries a symbolic parent reference.

```ts
function walk(nodes: ProceduralSerializedNode[], parent: ProceduralInstanceRef): void {
  for (const node of nodes) {
    if (node.guid) {
      const ownRef: ProceduralInstanceRef = { kind: "existing", guid: node.guid };
      seenExisting.add(node.guid);
      derivePropertyAndNameUpdate(node);
      if (!sameRef(snapshotParent(node.guid), parent)) {
        ops.push({ kind: "move", guid: node.guid, parent });
      }
      walk(node.children ?? [], ownRef);
    } else {
      const localId = requireLocalId(node);
      const ownRef: ProceduralInstanceRef = { kind: "generated", localId };
      ops.push({
        kind: "add",
        localId,
        parent,
        class: node.class,
        name: node.name,
        properties: node.properties ?? {},
      });
      walk(node.children ?? [], ownRef);
    }
  }
}
```

After traversal, every snapshot GUID not present in `seenExisting` becomes a delete. Keep the existing target-root
property/name diff as a separate update because the target itself is not one of the output children.

The planner must never inspect Luau source or assignment events.

## Target preflight

Preflight the complete symbolic final graph before the first mutation:

1. Every fresh serialized node has a non-empty `localId`.
2. Every `localId` is unique.
3. Every generated parent reference names an add op in the same plan.
4. Every existing reference names a current scene GUID.
5. Add classes/properties pass canonical create validation.
6. Update patches pass canonical patch validation against the actual current class.
7. Services and the protected scene root cannot be move targets.
8. No existing GUID is moved more than once.
9. No existing GUID is both moved and deleted.
10. No generated or existing parent is deleted by the final plan.
11. The combined existing/generated final parent graph is acyclic.
12. Parent-class restrictions are checked using existing node classes or generated add declarations.

Cycle validation must cover mixed identities. This script is invalid even though neither half alone forms an
existing-only cycle:

```lua
local folder = Instance.new("Folder")
folder.Parent = existingModel
existingModel.Parent = folder
```

Represent final graph keys with an internal tagged form such as `guid:<guid>` and `local:<localId>` to avoid string
collisions.

## Target apply order

Within the single in-memory document transaction:

1. Add generated nodes in dependency order and populate `localId -> liveGuid`.
2. Resolve and apply moves before deletes.
3. Delete absent existing nodes deepest-first.
4. Apply property/name updates without create defaults.
5. Compute diagnostics and result metadata from the final in-memory root.

Generated adds can be processed with a topological readiness loop:

- an add is ready when its parent is an existing GUID or a resolved local ID;
- group ready siblings by resolved parent where useful;
- preserve operation order within a group so returned GUIDs map to local IDs deterministically;
- if pending adds remain and no add becomes ready, report a missing-reference or cycle error.

The procedural runtime already limits generated node count. The public `instance_upsert` batch limit of 100 is a tool
surface constraint, not a reason to perform multiple file transactions internally.

## Document-level mutation extraction

The current code has useful but unevenly factored primitives:

- `instance-move-operations.ts` already validates and mutates an in-memory root.
- `instance-upsert-tool.ts` still owns GUID allocation, object-key allocation, node construction, file I/O, and update
  mutation together.
- `procedural-apply.ts` directly deletes nodes and calls `executeInstanceUpsertInner()` for add/update batches.

Recommended extraction:

```text
instance-document-operations.ts
  addInstancesInDocument(document, items) -> added nodes/live GUIDs
  updateInstancesInDocument(root, items)
  moveInstancesInDocument(root, items)       (reuse existing implementation)
  deleteInstancesInDocument(root, items)
```

Keep validation separate from mutation where possible:

```text
preflightProceduralPlan(root, ops) -> normalized symbolic plan
applyProceduralPlan(document, plan) -> result
```

The direct `instance_upsert`, `instance_move`, and `instance_delete` tools should progressively reuse the same
document primitives. Do not make procedural apply call public tools: that would duplicate approval, write locks,
file transactions, render payloads, and Studio apply RPCs.

## Result and manifest behavior

Preserve existing result fields:

- `addCount`, `addedGuids`
- `updateCount`, `updatedGuids`
- `moveCount`, `movedGuids`
- `deleteCount`, `deletedGuids`, `skippedDeletes`
- `rootGuids`

`rootGuids` are the live GUIDs for generated add ops whose final parent is the run's target existing reference. A
generated node below another generated node is not a root. A generated node below an existing node other than the run
target is not a model root.

Local IDs must not be written to the model manifest. Persist only live root GUIDs as today.

## Implementation order

### Phase 1: serialization and contracts

1. Add `localId` to `ProceduralSerializedNode`.
2. Serialize `node.Id` for every non-injected node in `ovdr-shim.lua`.
3. Add runtime validation for the `guid XOR localId` invariant.
4. Add `ProceduralInstanceRef` and flat add/move op types.

### Phase 2: symbolic end-state planner

1. Replace `toAddNode()` with ref-carrying flat traversal.
2. Derive add/move/update/delete ops for mixed existing/generated trees.
3. Build and validate the combined final parent graph.
4. Remove the current existing-under-generated rejection only after these tests pass.

### Phase 3: document transaction

1. Extract add/update/delete document mutations from the public tools.
2. Verify callback failure leaves the original level bytes unchanged.
3. Resolve generated parents and apply the complete plan in one `readAndWriteOvdrjm()` call.
4. Run `applyLevelChanges()` once.
5. Preserve current UI diagnostics and result metadata.

### Phase 4: integration and cleanup

1. Update procedural tool/skill text to remove the generated-parent limitation.
2. Remove recursive `ProceduralAddNode.children` and `createSubtrees()`.
3. Keep direct instance tool schemas and behavior stable.
4. Confirm model regeneration and root manifest behavior remain idempotent.

## Required tests

Write or strengthen tests first, under the existing package-level `test/` tree.

### Luau/runtime planner

- Fresh parent receives `localId` in serialized output.
- Fresh child under fresh parent produces two flat add ops with generated parent ref.
- Existing child under fresh parent produces add plus symbolic move, not delete plus add.
- Existing child moved twice produces only the final move.
- Move followed by destroy produces delete only.
- Missing/duplicate local IDs are rejected.
- Mixed existing/generated cycles are rejected.

### Atomic apply

- Existing child moves under a fresh Folder and retains the same GUID and subtree.
- Nested fresh parents resolve over multiple dependency levels.
- Fresh and existing siblings can coexist below one fresh parent.
- A child can move out before its old parent is deleted.
- Invalid late operation leaves the level file byte-for-byte unchanged.
- More than 100 generated nodes apply without exposing public tool batching constraints.
- Unresolved local ref fails before file write.
- Result counts, `movedGuids`, `addedGuids`, and `rootGuids` are correct.

### Direct tools and regression

- Existing-to-existing procedural move remains green.
- Direct `instance_move` missing GUID, service protection, self-parent, descendant, and batch-cycle behavior remains
  structured and unchanged.
- Property create defaults and patch-without-default behavior remain green.
- Procedural model run twice still replaces rather than duplicates the prior generation.

## Verification commands

```powershell
bun test ./apps/overdare-ai-agent/sidecar/test
bun run typecheck
bunx biome check <touched paths>
git diff --check
```

## Explicit non-goals

- Stable local IDs across separate procedural runs.
- Persisting local IDs in `.ovdrjm` or procedural manifests.
- Reordering siblings when the parent does not change.
- Reparenting Service instances or the protected scene root.
- Adding a new public procedural move tool.
- Replacing end-state diff with Luau source parsing or an assignment event log.
- General instance-valued property references. Hierarchy references are the P075 scope; property references can reuse
  `ProceduralInstanceRef` in a later feature if required.

## Completion criteria

P075 is complete when the following script succeeds without changing the existing child's GUID:

```lua
local generated = Instance.new("Folder")
generated.Name = "GeneratedParent"
generated.Parent = workspace

local existing = workspace:FindFirstChild("ExistingChild", true)
existing.Parent = generated
```

The final level must contain the generated Folder under the target, the original existing node under that Folder,
one Studio apply RPC, no intermediate partial file state, and no persisted procedural local IDs.
