---
id: P072-HANDOFF
parent: P068
created: 2026-07-10
status: active
---

# P072 Hand-off: Toolify the OVERDARE Procedural Runtime for the Studio Agent

## Why this hand-off exists

P068 built a procedural Luau → scene-JSON runtime, but only **half of it is wired to the Studio agent**. This document captures the design decisions from the 2026-07-10 design session so the next session can implement the tool surface without re-deriving the architecture.

Read alongside:

- `docs/plan/feature/P068-procedural-script-dummy-json-runtime.md`
- `docs/plan/feature/P068-procedural-script-dummy-json-runtime-handoff.md`
- `.diligent/skills/procedural-luau-json/SKILL.md`

**Branch note:** all P068 procedural code lives on the local `hello` branch (rebased onto latest `origin/main` on 2026-07-09; backup at `hello-pre-rebase-backup`). It is **not** on origin. Do this work on `hello`.

## Current state (what exists vs what is missing)

Two halves; only Apply is exposed as an agent tool.

| Stage | Implementation | Agent tool? | Notes |
|---|---|---|---|
| Generate | `src/procedural-model/runtime.ts` → `generateProceduralDummyJson({scriptSource, parameters, scriptName})` | **NO** | Spawns vendored Luau, runs `luau/runner.lua` via `ovdr-shim`, returns validated `ProceduralDummyJson` tree. Only called by the runtime test. |
| Apply | `src/tools/studiorpc/tools/procedural-json-apply-tool.ts` → `studiorpc_procedural_json_apply` | YES | Reads a JSON file, recursively upserts under `targetParentGuid` (parent-first, live GUID). Batch 100, approval + writeLock + snapshot rollback. **ADD-ONLY.** |

Core gaps:

1. **No tool runs the Luau script** — the agent cannot execute a script to produce the JSON; generation is orphaned.
2. **Apply is add-only** — it cannot express updates or deletes of existing objects.
3. **Runtime input transport is argv** — `generateProceduralDummyJson` passes the entire script source via `luau runner.lua --program-args '<json>'`. Large scripts overflow `ARG_MAX`.
4. **No subprocess guardrails** — no timeout / max-node / max-output limit on the Luau child.
5. **`ovdr-shim` builds fresh models only** — it cannot inject the *current scene* as iterable instances (needed for transform scripts).

## Design decisions locked in this session

### The axis that matters is script LIFETIME, not what the script does

The user identified two use cases:

- **Transform** — a script that edits existing scene objects (e.g. "move all objects 1px right"). Reads current scene, emits update/delete (± add) ops.
- **Generate** — a script that builds a model from parameters (e.g. colosseum with `archCount`).

Key insight: **transform vs generate is script *content*, not tool identity.** They are orthogonal to lifetime:

|  | generate | transform |
|---|---|---|
| **one-shot** | quick throwaway build | "move all 1px" |
| **persistent** | colosseum model | "grid-align selection (spacing param)" |

Therefore we do **not** create a `procedural_transform` tool. We split tools by **lifetime**: one-shot vs persist vs run-persisted. The same execution+apply engine serves all four cells.

### Final agent tool surface (3 tools by lifetime)

| # | Tool name | Method id | File | Behavior |
|---|---|---|---|---|
| 1 | `studiorpc_procedural_run` | `procedural.run` | `procedural-run-tool.ts` | **One-shot.** Run a script (inline `script` for small edits, or `scriptPath` for large), current scene injected + optional `parameters` → ops → apply. No persistence. |
| 2 | `studiorpc_procedural_model_save` | `procedural.model.save` | `procedural-model-save-tool.ts` | **Persist.** Write script to canonical location + create/update manifest + validate (dry-run). Does not touch the scene. |
| 3 | `studiorpc_procedural_model_run` | `procedural.model.run` | `procedural-model-run-tool.ts` | **Run persisted.** Look up model by `id` + `parameters`, run, **delete prior generation via manifest, re-apply (idempotent), update manifest rootGuid.** |
| (4) | `studiorpc_procedural_model_list` | `procedural.model.list` | `procedural-model-list-tool.ts` | Optional: list saved models so tool 3 can discover `id`s. Include a minimal version. |

Naming rationale: `procedural_run` (one-shot) ↔ `procedural_model_run` (persistent, idempotent replace) are symmetric; the only difference is the `model_` segment = "backed by a persisted model." Chose `run` over `build` for symmetry; the idempotent-replace meaning is carried in the approval/description text.

`studiorpc_procedural_json_apply` (the current tool) is **demoted from the top-level surface and absorbed into the internal L1 applier.** Keep it as an internal function; only re-expose as an escape hatch if a concrete need appears.

## Internal architecture (shared, not agent tools)

```
L0 runtime : runProceduralScript(script, {scene?, parameters?}) -> ProceduralOp[]     (guardrailed)
L1 applier : applyProceduralOps(ops, {targetGuid}) -> {added,updated,deleted, guids}   (add/update/delete)
─────────────────────────────────────────────────────────────────────
tool 1  procedural_run        -> L0 (+scene) -> L1
tool 2  procedural_model_save -> manifest.ts (persist + validate via L0 dry-run)
tool 3  procedural_model_run  -> manifest lookup -> L0 -> delete prior -> L1 -> manifest update
```

| Layer | Symbol / path | Status |
|---|---|---|
| L0 execution runtime | `src/procedural/runtime.ts` → `runProceduralScript()` | **new**, generalizes `generateProceduralDummyJson` |
| ├ Luau runner | `luau/runner.lua` | extend: argv → **file/stdin** transport (gap #3) |
| ├ compat shim | `luau/ovdr-shim.lua` | extend: **inject current scene** as iterable instances (gap #5) |
| └ guardrails | `src/procedural/limits.ts` (timeout / maxNodes / maxBytes) | **new** (gap #4) |
| L1 op model | type `ProceduralOp = {kind:"add"\|"update"\|"delete", ...}` | **new**, generalizes `ProceduralJsonNode` |
| L1 applier | `applyProceduralOps()` | **new**, generalizes `applyNodeTree` |
| └ reused primitives | `executeInstanceUpsertInner` (add **and** update — `instanceUpsert.isUpdateItem` already exists), `instance.delete` method, `withSnapshot`, `writeLock` | **reuse as-is** |

> Suggested rename: `src/procedural-model/` → `src/procedural/` since it now covers transform, not just models. Optional; update imports if done.

## #2 persistence layer (tools 2 & 3 only)

The critical unavoidable piece: to delete the *prior* generation on re-run, a `generationId ↔ applied rootGuid` link must persist in the project (scene `properties` are strict, so it cannot live there — limitation P068 #2).

| Item | Symbol / path | Status |
|---|---|---|
| Manifest module | `src/procedural/manifest.ts` | new |
| Manifest type | `ProceduralModelManifest { generationId, scriptPath, parameters, rootGuid, updatedAt }` | new |
| Storage | `<project>/.overdare/procedural/models/<generationId>.json` | new |
| Persistent scripts | `<project>/.overdare/procedural/scripts/*.lua` (NOT `/tmp`) | new |

`generationId` is already a required `-- generationId:` comment enforced by `extractProceduralScriptMetadata` — reuse it as the model identity/key.

One-shot `procedural_run` does **not** use this layer.

## Prerequisite fixes (do first, independent of tool count)

- **P1 — Input transport (gap #3):** change `runner.lua` to read script + input from a temp file or stdin instead of `--program-args`. Verify a large script (e.g. `roblox-example/colosseum.lua`) round-trips.
- **P2 — Guardrails (gap #4):** add timeout, max-node, max-output-bytes to the Luau spawn in `runtime.ts` before any tool exposes it.
- **P3 — Apply generalization (gap #2):** build `applyProceduralOps` handling `add` (upsert new), `update` (upsert by guid — `executeInstanceUpsertInner` already supports update items), `delete` (`instance.delete`). Keep the batch-100 + parent-first-live-GUID behavior for adds. Note: `applyNodeTree` cannot be extended in place — it is structurally coupled to add-only `ProceduralJsonNode` trees (class/parentGuid/children); write a new dispatcher that reuses the approval + writeLock + parent-first batching pieces. Apply order: delete → update → add; sort deletes deepest-first and skip already-missing guids (removing a parent orphans its subtree, so a child guid later in the batch would otherwise hard-fail).
- **P4 — Scene injection (gap #5):** extend `ovdr-shim.lua` so a script can enumerate the current scene (`GetDescendants`, `IsA`, read `CFrame`/props) — required for transform scripts. Feed the scene into `runProceduralScript` (read via level file `readOvdrjmRoot(cwd)` — simpler than RPC). See the design addendum below for the diff-based op derivation that this enables.

## Open questions (with recommended defaults)

1. **Scope of `procedural_run` scene injection** — whole scene vs a `targetGuid` subtree. **Default: accept optional `targetGuid`; inject that subtree (whole `Workspace` if omitted).** Safer than always whole-scene.
2. **`run` vs `build` verb for tool 3** — **default `run`** (symmetry with tool 1). Revisit if `build`/`regenerate` reads clearer to users.
3. **Include `procedural_model_list`?** — **default: yes, minimal** (tool 3 needs discoverable ids).
4. **Parameter schema** — script does not declare its params. **Default MVP: free-form** `{Size, Attributes}`; agent reads the script to learn knobs. Defer a declared `-- @param` schema (parsed by `manifest.ts`, surfaced by `model_list`) to a v1.1.
5. **Metadata channel (P068 #2)** — with regenerate-and-replace (#2) + manifest, we only need the single `generationId → rootGuid` link, which the manifest covers. No per-node construct mapping needed for MVP. Confirm we are not committing to partial per-instance editing of generated models.

## Design addendum — 2026-07-10 follow-up session

Decisions locked after reviewing the actual shim/runner/applier code. These refine (and in one case correct) the sections above.

### Transform ops come from an end-state diff, not mutation tracking

The Luau script is a pure function: scene snapshot in → final mock tree out. Nothing happens "live" during execution; script termination is the only observable point. Therefore the shim does **not** record ops as calls happen. Instead, L0 derives `ProceduralOp[]` on the TS side by diffing the injected snapshot against the serialized final tree:

| Final-tree state vs snapshot | Derived op |
|---|---|
| guid in both, whitelisted props equal | none (no-op filtering is built in) |
| guid in both, props differ | `update` |
| guid in snapshot, absent from output (`Destroy()`ed or detached) | `delete` |
| node without a guid (fresh mock) | `add` |

The shim's existing `Destroy()` semantics (mark `Destroyed`, drop at serialization — `ovdr-shim.lua:503,697`) are reused as-is. The Luau side has no op concept at all.

### Shim modifications (approved — modifying the shim is in scope)

- **Inject:** new `Ovdr.injectScene(snapshotJson)` deserializes the scene subtree into mock Instances that carry a `Guid` field (the real scene GUID). Expose the injected root to scripts as a `workspace` global in the runner environment; `OnGenerate(parameters, targetContainer)` signature is unchanged.
- **Serialize:** `serializeNode` passes `guid` through for injected nodes so the TS diff can identify them. The hard error for unsupported classes (`ovdr-shim.lua:716`) must not fire for injected nodes — pass through `class`/`name`/`guid` with a whitelisted property set instead.
- **Diff property whitelist:** start with `CFrame`, `Size`, `Color`, `Material`, `Name`. Properties outside the whitelist are neither injected nor diffed — they stay untouched in the scene.
- **Reparent is unsupported in MVP:** update items (`{guid, name, properties}`) cannot change `parentGuid`. Moving an existing object to a new parent is out of scope; document as a limitation. The primary transform use cases (move/scale/recolor/delete) are all covered.

### Script convention cleanup — Roblox-plugin boilerplate removed (DONE 2026-07-10)

The progress-timer pattern (`task.spawn` render-progress loop, `script.Destroying:Connect`, `script:IsDescendantOf(game)` checks, `tick()`-based elapsed logs) was only ever needed for long-running Roblox Studio plugin scripts. In this runner it was dead code: the `task.spawn` stub wrapped `coroutine.create` and never resumed it, so the timer loop never executed; `Destroying.Connect`/`task.wait`/`task.cancel` were no-ops.

Applied cleanup (all committed on `hello`):

- `runner.lua`: removed the `task`/`tick`/`game` environment stubs and trimmed the `script` object to `{ Dependencies }`. Scripts that reference these plugin APIs now fail fast instead of silently no-oping.
- `roblox-example/colosseum.lua`, `roblox-example/rabbit.lua`: stripped the timer boilerplate; they are now canonical examples of the supported convention (module + `OnGenerate(parameters, targetContainer)`, `require(script.Dependencies.*)` only).
- **`Instance:Destroy()` stays** — it is genuinely needed for the CSG scratch-part pattern (build cutters → subtract → destroy cutters; used by both examples and the mini-colosseum test) and it is how the future end-state diff detects deletes. Everything else plugin-flavored is gone.
- Vendored dependencies (`GeometryPrimitives`/`ConstructiveSolidGeometry`/`SmartObject`/`MathUtils`) never used any of the removed APIs — verified by grep.

### Other locked decisions

- **Manifest resilience:** store `parentGuid` alongside `rootGuid`. On `procedural_model_run`, if the prior `rootGuid` no longer exists in the scene (manual edit), warn in the tool output and create a fresh generation — idempotency degrades gracefully instead of failing. The approval prompt for tool 3 must state "deletes prior generation `<rootGuid>` + adds N nodes".
- **One-shot `procedural_run` relaxes `generationId`:** the `-- generationId:` comment stays required for tools 2/3 (it is the model identity), but for one-shot inline scripts the sidecar auto-generates a uuid when the comment is absent — requiring it for "move everything 1px" is pointless friction.

## Suggested implementation order

1. P1 + P2 (transport + guardrails) — unblocks safe execution.
2. P3 + P4 (op model/applier + scene injection) + `runProceduralScript`.
3. Tool 1 `studiorpc_procedural_run` (proves the whole L0+L1 path end-to-end). Register in `src/tools/studiorpc/index.ts` wrapped in `withSnapshot`.
4. `manifest.ts` + Tool 2 `procedural_model_save` + Tool 3 `procedural_model_run` (+ optional `model_list`).
5. Update `.diligent/skills/procedural-luau-json/SKILL.md` to the new 3-tool workflow (it currently even says the apply tool "does not exist yet").

## Validation plan

- Unit: extend `test/procedural-model/runtime.test.ts` and add `test/tools/` coverage for each new tool (mirror the existing `studiorpc.test.ts` procedural tests: arg parsing, node/op limits, approval rejection before touching Studio, batch size).
- Transport: large-script round-trip test (colosseum).
- Guardrails: timeout + max-node rejection tests.
- Idempotency: tool 3 run twice with same id produces one subtree, not two (prior deleted).
- `bun test ./apps/overdare-ai-agent/sidecar/...` green; `tsc --noEmit -p apps/overdare-ai-agent/sidecar/tsconfig.json` clean; `bunx biome check` on touched paths.

## Registration reminder

New tools go in `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts`, wrapped `wrapTool(withSnapshot(create...Tool(ctx.cwd, writeLock)), ctx.host)` for any tool that mutates the scene (tools 1 and 3; tool 2 does not mutate the scene so no snapshot needed). Keep imports alphabetical.
