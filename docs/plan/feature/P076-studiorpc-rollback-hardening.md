# StudioRPC Rollback Hardening & Point-in-Time Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the studiorpc rollback failure paths (silent capture failure, non-atomic restore, no undo) and add breakpoint-style point-in-time rollback: every snapshot carries a label derived from the user prompt, a new `studiorpc_snapshot_list` tool exposes them, and `studiorpc_rollback` accepts a `snapshotId` to restore any point.

**Architecture:** Keep the existing snapshot design (lazy capture before the turn's first map edit, raw `.ovdrjm` byte copy, filesystem as source of truth). Add a per-snapshot metadata sidecar (`{sessionId}_{index}.json`) holding label/kind/createdAt. Rollback captures a `pre-rollback` safety snapshot before restoring (enables undo), wraps `level.apply` in recovery logic (restores the safety copy on failure so disk and editor stay consistent), and reports which point it restored. Snapshots are pruned to a per-session cap after each capture.

**Tech Stack:** Bun + TypeScript, `bun:test`, zod. No new dependencies.

## Global Constraints

- All code, comments, tests, and docs in English (repo AGENTS.md convention).
- File header comments use the existing `// @summary ...` style.
- Base branch: `feat/studiorpc-human-edits`; working branch: `feat/studiorpc-rollback-hardening`.
- Run tests from `apps/overdare-ai-agent/sidecar/`: `bun test test/tools/studiorpc-rollback.test.ts`.
- Existing public helper signatures may gain optional params but must not break existing callers.
- Snapshot filename format `{sessionId}_{index}.ovdrjm` is unchanged (backward compatible: old snapshots without a `.json` sidecar must still list and restore).

## Improvement Coverage Map

| Analysis item | Where in this plan |
|---|---|
| (1) Non-atomic restore (`level.apply` failure silently undone by onStop save) | Task 6 |
| (2) Silent capture failure → rollback jumps further back than expected | Task 4 (warning surfaced in tool output) + Task 6 (rollback output names the restored point) |
| (3) No rollback-of-rollback | Task 6 (`pre-rollback` safety snapshot) |
| (4) One-step rollback only | Task 5 (list tool) + Task 6 (`snapshotId` param) |
| (5) Unbounded snapshot growth | Task 3 (prune) + Task 4 (wired into capture) |
| (6) Concurrent-session races on shared `turnState` | **Descoped.** Tools cannot identify their session (`ToolContext` has no session id); a real fix needs runtime-wide plumbing. Single-user local tool, low risk. Follow-up: plumb session id into `ToolContext`, key `turnState` by session, and scope `findLatestSnapshot` to the calling session. |
| (7) Agent context diverges from rolled-back map | Task 6 (rollback output instructs re-reading; names discarded scope) |
| Breakpoint / summary-based point-in-time rollback | Tasks 1, 4, 5, 6 (prompt-derived labels + list + targeted restore) |

**Label design note:** the "summary" attached to each snapshot is the user prompt that started the editing turn (available as `input.prompt` in the `UserPromptSubmit` hook — see `packages/runtime/src/app-server/turn-handlers.ts:171`), stored up to 2000 chars in the sidecar and truncated to 120 chars in human-facing output (list tool, approval prompt, rollback result). Storing the full text locally keeps the snapshots dir self-contained — no lookups into session transcripts, whose line numbers and entries do not survive compaction. No LLM summarization. `// ponytail: prompt-prefix label; LLM summarization if labels prove too noisy`.

## File Structure

- Modify: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/snapshot.ts` — metadata write, `listSnapshots`, `findSnapshotById`, kind-aware `findLatestSnapshot`, `pruneSnapshots`.
- Modify: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/rollback-tool.ts` — `snapshotId` param, safety snapshot, apply-failure recovery, enriched output.
- Create: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/snapshot-list-tool.ts` — read-only `studiorpc_snapshot_list` tool.
- Modify: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts` — prompt label in `turnState`, capture-failure warning, prune wiring, register list tool.
- Modify: `apps/overdare-ai-agent/sidecar/test/tools/studiorpc-rollback.test.ts` — extend; one existing test's assertion changes (see Task 6).

All tasks below use these paths; relative paths are from `apps/overdare-ai-agent/sidecar/`.

---

### Task 1: Snapshot metadata sidecar + `listSnapshots`

**Files:**
- Modify: `src/tools/studiorpc/tools/snapshot.ts`
- Test: `test/tools/studiorpc-rollback.test.ts`

**Interfaces:**
- Consumes: existing `snapshotsDir(cwd)`, `resolveOvdrjmPathFromUmap(cwd)`.
- Produces (later tasks rely on these exact shapes):

```typescript
export type SnapshotKind = "turn" | "pre-rollback";

export interface SnapshotMeta {
  id: string;          // "{sessionId}_{index}"
  sessionId: string;
  index: number;
  createdAt: string;   // ISO timestamp
  label?: string;      // truncated user prompt, or "state before rollback"
  kind: SnapshotKind;
}

export interface SnapshotEntry extends SnapshotMeta {
  path: string;        // absolute path to the .ovdrjm copy
}

export interface CaptureOptions {
  label?: string;
  kind?: SnapshotKind; // default "turn"
}

export function captureSnapshot(cwd: string, sessionId: string, index: number, options?: CaptureOptions): string;
export function listSnapshots(cwd: string): SnapshotEntry[]; // newest first (mtime desc)
```

- [ ] **Step 1: Write the failing tests**

Append to `test/tools/studiorpc-rollback.test.ts` (inside the existing file; `listSnapshots` gets a new `describe` block, the metadata test goes inside the existing `describe("captureSnapshot", ...)`):

```typescript
// Inside describe("captureSnapshot", ...):
  test("writes a metadata sidecar with label and kind", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess1", 0, { label: "make the tree bigger", kind: "turn" });
    const meta = JSON.parse(readFileSync(join(snapshotsDir(cwd), "sess1_0.json"), "utf-8"));
    expect(meta).toMatchObject({
      id: "sess1_0",
      sessionId: "sess1",
      index: 0,
      label: "make the tree bigger",
      kind: "turn",
    });
    expect(typeof meta.createdAt).toBe("string");
  });

  test("defaults kind to 'turn' and omits label when not given", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess1", 0);
    const meta = JSON.parse(readFileSync(join(snapshotsDir(cwd), "sess1_0.json"), "utf-8"));
    expect(meta.kind).toBe("turn");
    expect("label" in meta).toBe(false);
  });

// New top-level describe:
describe("listSnapshots", () => {
  test("returns entries newest-first with metadata merged in", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "first edit" });
    captureSnapshot(cwd, "sess", 1, { label: "second edit", kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    const entries = listSnapshots(cwd);
    expect(entries.map((e) => e.id)).toEqual(["sess_1", "sess_0"]);
    expect(entries[0]).toMatchObject({ label: "second edit", kind: "pre-rollback", index: 1 });
    expect(entries[1]).toMatchObject({ label: "first edit", kind: "turn", sessionId: "sess" });
  });

  test("legacy snapshots without a metadata file get kind 'turn' and mtime-based createdAt", () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old_3.ovdrjm"), "{}"); // pre-metadata snapshot
    const entries = listSnapshots(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "old_3", sessionId: "old", index: 3, kind: "turn" });
    expect(entries[0].label).toBeUndefined();
    expect(typeof entries[0].createdAt).toBe("string");
  });

  test("returns an empty array when the snapshots dir does not exist", () => {
    const cwd = projectDir();
    expect(listSnapshots(cwd)).toEqual([]);
  });
});
```

Add `listSnapshots` to the import from `../../src/tools/studiorpc/tools/snapshot` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: FAIL — `listSnapshots` is not exported; metadata sidecar files do not exist.

- [ ] **Step 3: Implement in `snapshot.ts`**

Update the imports and add the types + implementations. Full new content of the changed regions:

```typescript
// @summary Rollback snapshot helpers: capture/restore .ovdrjm level snapshots with metadata.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@diligent/runtime";
import { resolveOvdrjmPathFromUmap } from "./ovdrjm-utils";

export type SnapshotKind = "turn" | "pre-rollback";

/** Metadata stored in the `{id}.json` sidecar next to each snapshot. */
export interface SnapshotMeta {
  id: string;
  sessionId: string;
  index: number;
  createdAt: string;
  label?: string;
  kind: SnapshotKind;
}

/** A snapshot on disk: sidecar metadata plus the path to the .ovdrjm copy. */
export interface SnapshotEntry extends SnapshotMeta {
  path: string;
}

export interface CaptureOptions {
  label?: string;
  kind?: SnapshotKind;
}
```

Replace `captureSnapshot` with:

```typescript
/**
 * Copy the project's current .ovdrjm into the snapshots dir as
 * `{sessionId}_{index}.ovdrjm` and write a `{sessionId}_{index}.json` metadata
 * sidecar (label, kind, createdAt). Raw byte copy preserves the original
 * UTF-16/UTF-8 encoding. Caller must ensure the level was saved to file first.
 * Returns the snapshot path.
 */
export function captureSnapshot(cwd: string, sessionId: string, index: number, options: CaptureOptions = {}): string {
  const { ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  const dir = snapshotsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const id = `${sessionId}_${index}`;
  const dest = join(dir, `${id}.ovdrjm`);
  copyFileSync(ovdrjmPath, dest);
  const meta: SnapshotMeta = {
    id,
    sessionId,
    index,
    createdAt: new Date().toISOString(),
    ...(options.label !== undefined ? { label: options.label } : {}),
    kind: options.kind ?? "turn",
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta));
  return dest;
}
```

Add below it:

```typescript
/** Parse `{sessionId}_{index}` from a snapshot filename; sessionId may itself contain underscores. */
function parseSnapshotName(name: string): { sessionId: string; index: number } | undefined {
  const stem = name.slice(0, -".ovdrjm".length);
  const sep = stem.lastIndexOf("_");
  if (sep <= 0) return undefined;
  const index = Number(stem.slice(sep + 1));
  if (!Number.isInteger(index)) return undefined;
  return { sessionId: stem.slice(0, sep), index };
}

/**
 * All snapshots in the project, newest first (by file mtime). Snapshots
 * predating the metadata sidecar are listed with kind "turn", no label, and an
 * mtime-derived createdAt so old projects keep working.
 */
export function listSnapshots(cwd: string): SnapshotEntry[] {
  const dir = snapshotsDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: Array<SnapshotEntry & { mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".ovdrjm")) continue;
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const path = join(dir, name);
    const mtimeMs = statSync(path).mtimeMs;
    const id = name.slice(0, -".ovdrjm".length);
    let meta: SnapshotMeta | undefined;
    try {
      meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8")) as SnapshotMeta;
    } catch {
      // legacy snapshot without metadata sidecar
    }
    entries.push({
      id,
      path,
      sessionId: parsed.sessionId,
      index: parsed.index,
      createdAt: meta?.createdAt ?? new Date(mtimeMs).toISOString(),
      ...(meta?.label !== undefined ? { label: meta.label } : {}),
      kind: meta?.kind ?? "turn",
      mtimeMs,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: PASS (all existing tests too — `captureSnapshot`'s return value and copy behavior are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/tools/studiorpc/tools/snapshot.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): add snapshot metadata sidecar and listSnapshots"
```

---

### Task 2: Kind-aware `findLatestSnapshot` + `findSnapshotById`

**Files:**
- Modify: `src/tools/studiorpc/tools/snapshot.ts`
- Test: `test/tools/studiorpc-rollback.test.ts`

**Interfaces:**
- Consumes: `listSnapshots(cwd)` from Task 1.
- Produces:

```typescript
export function findLatestSnapshot(cwd: string): SnapshotEntry; // newest with kind !== "pre-rollback"; throws if none
export function findSnapshotById(cwd: string, id: string): SnapshotEntry; // throws if missing
```

`findLatestSnapshot`'s return type widens from `{ id, path }` to `SnapshotEntry` — a superset, so existing callers/tests keep working.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("findLatestSnapshot", ...)` block and a new block:

```typescript
// Inside describe("findLatestSnapshot", ...):
  test("skips pre-rollback snapshots so repeated default rollback stays idempotent", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "edit" });
    captureSnapshot(cwd, "sess", 1, { kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    expect(findLatestSnapshot(cwd).id).toBe("sess_0"); // newest non-pre-rollback
  });

// New top-level describe:
describe("findSnapshotById", () => {
  test("returns the entry for an existing id", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "edit" });
    const entry = findSnapshotById(cwd, "sess_0");
    expect(entry.id).toBe("sess_0");
    expect(entry.path).toBe(join(snapshotsDir(cwd), "sess_0.ovdrjm"));
  });

  test("throws with a helpful message for an unknown id", () => {
    const cwd = projectDir();
    expect(() => findSnapshotById(cwd, "nope_9")).toThrow(/not found/);
  });
});
```

Add `findSnapshotById` to the test file's snapshot import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: FAIL — `findSnapshotById` not exported; the skip-pre-rollback test picks `sess_1`.

- [ ] **Step 3: Implement**

Replace `findLatestSnapshot` in `snapshot.ts` with:

```typescript
/**
 * Most recent restorable snapshot: the newest entry whose kind is not
 * "pre-rollback". Pre-rollback safety snapshots are excluded so a
 * parameterless rollback stays idempotent (calling it twice restores the same
 * baseline instead of undoing itself); they remain reachable via
 * findSnapshotById. Throws if no snapshot exists.
 */
export function findLatestSnapshot(cwd: string): SnapshotEntry {
  const latest = listSnapshots(cwd).find((entry) => entry.kind !== "pre-rollback");
  if (!latest) {
    throw new Error("No rollback snapshot found. Nothing to roll back.");
  }
  return latest;
}

/** Snapshot with the given id. Throws when it does not exist. */
export function findSnapshotById(cwd: string, id: string): SnapshotEntry {
  const entry = listSnapshots(cwd).find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Snapshot "${id}" not found. Use studiorpc_snapshot_list to see available snapshots.`);
  }
  return entry;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: PASS. Note the pre-existing test "picks the most recently modified snapshot" writes bare `.ovdrjm` files with no sidecar — they resolve to kind "turn" via the legacy fallback and still pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/studiorpc/tools/snapshot.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): targeted snapshot lookup and pre-rollback-aware latest"
```

---

### Task 3: Snapshot pruning

**Files:**
- Modify: `src/tools/studiorpc/tools/snapshot.ts`
- Test: `test/tools/studiorpc-rollback.test.ts`

**Interfaces:**
- Produces:

```typescript
export const MAX_SNAPSHOTS_PER_SESSION = 20;
export function pruneSnapshots(cwd: string, sessionId: string, keep?: number): void;
```

- [ ] **Step 1: Write the failing tests**

```typescript
describe("pruneSnapshots", () => {
  test("keeps only the newest N snapshots for the session, removing files and sidecars", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0);
    captureSnapshot(cwd, "sess", 1);
    captureSnapshot(cwd, "sess", 2);
    captureSnapshot(cwd, "other", 0); // different session untouched

    pruneSnapshots(cwd, "sess", 2);

    const dir = snapshotsDir(cwd);
    expect(existsSync(join(dir, "sess_0.ovdrjm"))).toBe(false);
    expect(existsSync(join(dir, "sess_0.json"))).toBe(false);
    expect(existsSync(join(dir, "sess_1.ovdrjm"))).toBe(true);
    expect(existsSync(join(dir, "sess_2.ovdrjm"))).toBe(true);
    expect(existsSync(join(dir, "other_0.ovdrjm"))).toBe(true);
  });

  test("is a no-op when under the cap or when the dir does not exist", () => {
    const cwd = projectDir();
    expect(() => pruneSnapshots(cwd, "sess", 2)).not.toThrow(); // no dir yet
    captureSnapshot(cwd, "sess", 0);
    pruneSnapshots(cwd, "sess", 2);
    expect(existsSync(join(snapshotsDir(cwd), "sess_0.ovdrjm"))).toBe(true);
  });
});
```

Add `pruneSnapshots` to the test file's snapshot import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: FAIL with "pruneSnapshots is not exported".

- [ ] **Step 3: Implement**

Add `rmSync` to the `node:fs` import in `snapshot.ts`, then append:

```typescript
// ponytail: fixed cap; make configurable only if a real project needs it.
export const MAX_SNAPSHOTS_PER_SESSION = 20;

/**
 * Delete the oldest snapshots (and their metadata sidecars) beyond `keep` for
 * one session. Ordered by index — within a session the index is monotonic, so
 * it is a more reliable age signal than mtime.
 */
export function pruneSnapshots(cwd: string, sessionId: string, keep = MAX_SNAPSHOTS_PER_SESSION): void {
  const dir = snapshotsDir(cwd);
  const sessionEntries = listSnapshots(cwd)
    .filter((entry) => entry.sessionId === sessionId)
    .sort((a, b) => b.index - a.index);
  for (const entry of sessionEntries.slice(keep)) {
    rmSync(entry.path, { force: true });
    rmSync(join(dir, `${entry.id}.json`), { force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/studiorpc/tools/snapshot.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): prune rollback snapshots to a per-session cap"
```

---

### Task 4: Prompt labels + visible capture failure in `index.ts`

**Files:**
- Modify: `src/tools/studiorpc/index.ts`
- Test: `test/tools/studiorpc-rollback.test.ts`

**Interfaces:**
- Consumes: `captureSnapshot(cwd, sessionId, index, { label, kind })`, `pruneSnapshots(cwd, sessionId)` from Tasks 1/3; `input.prompt` (string) on the `UserPromptSubmit` hook input.
- Produces: `TurnSnapshotState` gains `promptLabel?: string` and `captureError?: string`. `ensureSnapshot(): string | undefined` (returns a one-time warning message on capture failure). Wrapped edit tools prepend that warning to their output.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("snapshot capture on first edit", ...)` block (it already has `hookInput`/`setup`/`importArgs` helpers — reuse them; note `hookInput` already passes `prompt: "go"`):

```typescript
  test("stores the user prompt as the snapshot label", async () => {
    const cwd = projectDir();
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    await importTool.execute(importArgs as never, toolCtx());

    const meta = JSON.parse(readFileSync(join(snapshotsDir(cwd), "sess_0.json"), "utf-8"));
    expect(meta.label).toBe("go");
    expect(meta.kind).toBe("turn");
  });

  test("surfaces a warning in the tool output when baseline capture fails", async () => {
    // A cwd with a umap but no ovdrjm makes resolveOvdrjmPathFromUmap throw,
    // so captureSnapshot fails while the RPC tool itself still succeeds.
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, "world.umap"), "umap");
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    const first = await importTool.execute(importArgs as never, toolCtx());
    expect(first.output).toContain("[warning] Rollback baseline could not be captured");

    // Reported once per turn, not on every subsequent edit.
    const second = await importTool.execute(importArgs as never, toolCtx());
    expect(second.output).not.toContain("[warning]");
  });

  test("prunes old snapshots after capturing", async () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    // Pre-existing snapshots 0..20 for this session (21 files, cap is 20).
    for (let i = 0; i <= 20; i++) writeFileSync(join(dir, `sess_${i}.ovdrjm`), "{}");
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    await importTool.execute(importArgs as never, toolCtx()); // captures sess_21

    expect(existsSync(join(dir, "sess_21.ovdrjm"))).toBe(true);
    expect(existsSync(join(dir, "sess_0.ovdrjm"))).toBe(false); // pruned
    expect(existsSync(join(dir, "sess_1.ovdrjm"))).toBe(false); // pruned (22 - 20 = 2 oldest)
    expect(existsSync(join(dir, "sess_2.ovdrjm"))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: FAIL — no label in metadata, no warning in output, no pruning.

- [ ] **Step 3: Implement in `index.ts`**

Update the import from `./tools/snapshot`:

```typescript
import { captureSnapshot, nextRequestIndex, pruneSnapshots, snapshotsDir } from "./tools/snapshot";
```

Extend the state interface:

```typescript
/** Per-turn rollback-snapshot state shared between the provider hooks and tools. */
interface TurnSnapshotState {
  sessionId: string | undefined;
  taken: boolean;
  /** Truncated user prompt; becomes the snapshot's label (its rollback-point summary). */
  promptLabel?: string;
  /** First capture failure this turn; set so the warning is reported only once. */
  captureError?: string;
}
```

Update `beginTurn` (initialization line changes plus the two new fields):

```typescript
  const beginTurn: PluginHookFn = async (input: HookInput) => {
    await callRpc("level.save.file", {});
    turnState.sessionId = input.session_id;
    turnState.taken = false;
    // Store generously (2000 chars); display sites truncate to 120. Keeping the
    // full text local means no transcript lookups are ever needed.
    turnState.promptLabel = typeof input.prompt === "string" ? input.prompt.slice(0, 2000) : undefined;
    turnState.captureError = undefined;
    return { blocked: false };
  };
```

Replace `ensureSnapshot` and `withSnapshot` in `createStudioRpcTools`:

```typescript
  // Capture the pre-edit rollback baseline once per turn, lazily on the first
  // map-editing tool. On failure, returns a one-time warning for the wrapping
  // tool to surface — a silently missing baseline would make a later rollback
  // restore an older snapshot than the user expects.
  const ensureSnapshot = (): string | undefined => {
    const ts = ctx.turnState;
    if (!ts || ts.taken || !ts.sessionId) return undefined;
    try {
      const index = nextRequestIndex(snapshotsDir(ctx.cwd), ts.sessionId);
      captureSnapshot(ctx.cwd, ts.sessionId, index, { label: ts.promptLabel, kind: "turn" });
      pruneSnapshots(ctx.cwd, ts.sessionId);
      ts.taken = true;
      return undefined;
    } catch (error) {
      if (ts.captureError) return undefined; // already reported this turn
      ts.captureError = (error as Error).message;
      return (
        `[warning] Rollback baseline could not be captured (${ts.captureError}). ` +
        `studiorpc_rollback would restore an older snapshot; check studiorpc_snapshot_list before rolling back.`
      );
    }
  };
  // Wrap a map-editing tool so it snapshots the baseline before it runs and
  // surfaces a capture failure in its output.
  const withSnapshot = (tool: Tool): Tool => ({
    ...tool,
    execute: async (args, toolCtx) => {
      const warning = ensureSnapshot();
      const result = await tool.execute(args, toolCtx);
      return warning ? { ...result, output: `${warning}\n${result.output}` } : result;
    },
  });
```

In the raw-RPC tool loop, change the capture line and the success return to carry the warning:

```typescript
      async execute(args, toolCtx) {
        const warning = capturesBeforeRun ? ensureSnapshot() : undefined;
        // ... (approval, lock, callRpc, postProcess, save — unchanged) ...
          return {
            output: warning ? `${warning}\n${output}` : output,
            render,
            metadata: { method: rpcMethod, result },
          };
```

(Only the `const warning = ...` line replaces `if (capturesBeforeRun) ensureSnapshot();`, and the `output:` field gains the prefix — everything else in the loop stays as is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: PASS, including all pre-existing capture tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/studiorpc/index.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): label snapshots with the user prompt and surface capture failures"
```

---

### Task 5: `studiorpc_snapshot_list` tool

**Files:**
- Create: `src/tools/studiorpc/tools/snapshot-list-tool.ts`
- Modify: `src/tools/studiorpc/index.ts` (register the tool)
- Test: `test/tools/studiorpc-rollback.test.ts`

**Interfaces:**
- Consumes: `listSnapshots(cwd)` (Task 1).
- Produces: read-only tool `studiorpc_snapshot_list` returning a JSON array of `{ id, sessionId, index, createdAt, label?, kind }` (path omitted), newest first. Factory: `createSnapshotListTool(cwd: string): Tool`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("createSnapshotListTool", () => {
  test("lists snapshots newest-first without exposing paths", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "first edit" });
    captureSnapshot(cwd, "sess", 1, { label: "state before rollback", kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    const tool = createSnapshotListTool(cwd);
    const result = await tool.execute({} as never, toolCtx());

    const entries = JSON.parse(result.output);
    expect(entries.map((e: { id: string }) => e.id)).toEqual(["sess_1", "sess_0"]);
    expect(entries[0].kind).toBe("pre-rollback");
    expect(entries[0].path).toBeUndefined();
    expect(result.metadata?.count).toBe(2);
  });

  test("reports when no snapshots exist", async () => {
    const cwd = projectDir();
    const tool = createSnapshotListTool(cwd);
    const result = await tool.execute({} as never, toolCtx());
    expect(result.output).toBe("No snapshots found.");
  });

  test("is registered as a tool on the provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const tools = await provider.createTools({ cwd: "/tmp/project", host: { approve: async () => "once" } });
    expect(tools.map((tool) => tool.name)).toContain("studiorpc_snapshot_list");
  });
});
```

Add `import { createSnapshotListTool } from "../../src/tools/studiorpc/tools/snapshot-list-tool";` to the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add a display helper to `snapshot.ts`, then create `snapshot-list-tool.ts`**

Append to `snapshot.ts` (labels store the full prompt; human-facing output stays compact — the rollback tool in Task 6 reuses this):

```typescript
/** Labels store the full prompt (up to 2000 chars); keep human-facing output compact. */
export function truncateLabel(label: string): string {
  return label.length > 120 ? `${label.slice(0, 120)}…` : label;
}
```

Then create `snapshot-list-tool.ts`:

```typescript
// @summary Lists rollback snapshots with labels so a specific restore point can be chosen.

import { z } from "zod";
import type { Tool, ToolResult } from "../types";
import { listSnapshots, truncateLabel } from "./snapshot";

const params = z.object({});

const description =
  "List rollback snapshots for this Studio project, newest first. Each entry has an id (pass it to " +
  "studiorpc_rollback's snapshotId), a label (the user request captured with it), createdAt, and kind. " +
  "'turn' snapshots hold the map state right BEFORE the labeled request ran — restoring one undoes that " +
  "request and everything after it. To return to the state right AFTER a request completed, restore the " +
  "snapshot of the NEXT editing request instead. 'pre-rollback' is the state saved just before a rollback " +
  "ran — restore it to undo that rollback.";

export function createSnapshotListTool(cwd: string): Tool {
  return {
    name: "studiorpc_snapshot_list",
    description,
    parameters: params,
    async execute(): Promise<ToolResult> {
      const entries = listSnapshots(cwd).map(({ path: _path, ...entry }) => ({
        ...entry,
        ...(entry.label !== undefined ? { label: truncateLabel(entry.label) } : {}),
      }));
      return {
        output: entries.length > 0 ? JSON.stringify(entries, null, 2) : "No snapshots found.",
        metadata: { method: "snapshot.list", count: entries.length },
      };
    },
  };
}
```

- [ ] **Step 4: Register it in `index.ts`**

Add the import (alphabetical order with its siblings):

```typescript
import { createSnapshotListTool } from "./tools/snapshot-list-tool";
```

Add to the `tools` array right after the rollback tool line (read-only, no approval wrapper needed beyond the standard one):

```typescript
    wrapTool(createRollbackTool(ctx.cwd, callRpc), ctx.host),
    wrapTool(createSnapshotListTool(ctx.cwd), ctx.host),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/studiorpc/tools/snapshot-list-tool.ts src/tools/studiorpc/index.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): add snapshot list tool for point-in-time rollback"
```

---

### Task 6: Rollback tool — targeted restore, safety snapshot, apply-failure recovery

**Files:**
- Modify: `src/tools/studiorpc/tools/rollback-tool.ts` (full rewrite below)
- Test: `test/tools/studiorpc-rollback.test.ts` (new tests + one existing test's assertions change)

**Interfaces:**
- Consumes: `findLatestSnapshot`, `findSnapshotById`, `captureSnapshot`, `restoreSnapshot`, `nextRequestIndex`, `snapshotsDir`, `SnapshotEntry` (Tasks 1–3).
- Produces: `studiorpc_rollback` accepts optional `{ snapshotId: string }`. Behavior contract:
  1. Resolve target first: `snapshotId` given → `findSnapshotById`; else `findLatestSnapshot` (which skips `pre-rollback` kinds). Unknown id → error result before approval or any RPC.
  2. approve — the prompt names the target id and its truncated label, so the user sees what will be restored → reject returns error result.
  3. `level.save.file` (flush — after this the on-disk ovdrjm IS the pre-rollback state).
  4. Capture a `pre-rollback` safety snapshot of the flushed current state (best-effort; labeled "state before rollback"). This is what makes the rollback itself undoable.
  5. `restoreSnapshot(target)` → `level.apply`. If apply throws: restore the safety copy back over the ovdrjm (disk and editor agree again, so the turn-end save cannot silently clobber a half-applied rollback), return an error result.
  6. `level.save.file` (persist) → success output naming the restored id, label, createdAt, plus a context note that instances/scripts created after that point no longer exist.

- [ ] **Step 1: Update the changed existing test**

In `describe("snapshot capture on first edit", ...)`, the test `"the rollback tool does not create a snapshot of the state being rolled back"` asserted `sess_1.ovdrjm` does not exist after a rollback. The safety snapshot deliberately changes this. Replace that test with:

```typescript
  test("the rollback turn leaves no 'turn' snapshot but saves a pre-rollback safety snapshot", async () => {
    const cwd = projectDir(); // current ovdrjm = {"Root":{"x":1}}
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}'); // prior edit's baseline
    const { tools } = await setup(cwd, "sess"); // rollback turn begins
    const rollbackTool = tools.find((t) => t.name === "studiorpc_rollback")!;

    await rollbackTool.execute({} as never, toolCtx());

    // Baseline restored; the discarded state was preserved as a pre-rollback snapshot.
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"original":true}}');
    const safetyMeta = JSON.parse(readFileSync(join(dir, "sess_1.json"), "utf-8"));
    expect(safetyMeta.kind).toBe("pre-rollback");
    expect(readFileSync(join(dir, "sess_1.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
    // A second parameterless rollback still targets sess_0 (idempotent).
    await rollbackTool.execute({} as never, toolCtx());
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"original":true}}');
  });
```

- [ ] **Step 2: Write the new failing tests**

Add to `describe("createRollbackTool", ...)`:

```typescript
  test("restores a specific snapshot when snapshotId is given", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "first edit" }); // {"Root":{"x":1}}
    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":2}}');
    captureSnapshot(cwd, "sess", 1, { label: "second edit" }); // {"Root":{"x":2}}
    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":3}}');
    const tool = createRollbackTool(cwd, async () => ({}));

    const result = await tool.execute({ snapshotId: "sess_0" } as never, toolCtx());

    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
    expect(result.metadata?.restored).toBe("sess_0");
    expect(result.output).toContain("first edit");
  });

  test("reports an error for an unknown snapshotId without touching the map", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0);
    const calls: string[] = [];
    const tool = createRollbackTool(cwd, async (method) => {
      calls.push(method);
      return {};
    });

    const result = await tool.execute({ snapshotId: "missing_1" } as never, toolCtx());

    expect(result.metadata?.error).toBe(true);
    expect(calls).not.toContain("level.apply");
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
  });

  test("restores the pre-rollback state when level.apply fails", async () => {
    const cwd = projectDir(); // current = {"Root":{"x":1}} — the pre-rollback state
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}');
    const calls: string[] = [];
    const tool = createRollbackTool(cwd, async (method) => {
      calls.push(method);
      if (method === "level.apply") throw new Error("editor busy");
      return {};
    });

    const result = await tool.execute({} as never, toolCtx());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("level.apply");
    // Disk was put back to the pre-rollback state, so it matches the editor again
    // and the turn-end save cannot silently clobber a half-applied rollback.
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
    expect(calls).toEqual(["level.save.file", "level.apply"]); // no final persist save
  });

  test("success output names the restored point and warns about stale references", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "build a castle" });
    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":9}}');
    const tool = createRollbackTool(cwd, async () => ({}));

    const result = await tool.execute({} as never, toolCtx());

    expect(result.output).toContain("sess_0");
    expect(result.output).toContain("build a castle");
    expect(result.output).toContain("no longer exist");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: FAIL — `snapshotId` is rejected by the empty zod schema, no safety snapshot, apply failure not handled.

- [ ] **Step 4: Rewrite `rollback-tool.ts`**

```typescript
// @summary Rolls the Studio map back to a snapshot (the last pre-request baseline by default).
import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import {
  captureSnapshot,
  findLatestSnapshot,
  findSnapshotById,
  nextRequestIndex,
  restoreSnapshot,
  type SnapshotEntry,
  snapshotsDir,
  truncateLabel,
} from "./snapshot";

const params = z.object({
  snapshotId: z
    .string()
    .optional()
    .describe(
      "Snapshot to restore, from studiorpc_snapshot_list. Omit to restore the state right before " +
        "the agent's most recent editing request.",
    ),
});

const description =
  "Roll the Studio map back to a saved snapshot. Without snapshotId, restores the state right before the " +
  "agent's most recent editing request. Deterministic full restore: the entire map is reverted to the " +
  "snapshot, discarding any changes made since (including the user's own edits). The discarded state is " +
  "first saved as a 'pre-rollback' snapshot, so the rollback itself can be undone by restoring that " +
  "snapshot via studiorpc_snapshot_list + snapshotId. If the user's reference to a restore point is " +
  "ambiguous, call studiorpc_snapshot_list and confirm the target with the user before calling this tool.";

function errorResult(message: string): ToolResult {
  return { output: message, metadata: { error: true, method: "rollback" } };
}

/**
 * Restore flow (PRD 4.2, extended): resolve target -> approve (naming the
 * target) -> save (flush editor) -> capture pre-rollback safety snapshot ->
 * overwrite ovdrjm with the target snapshot -> apply (sync editor; on failure,
 * put the safety copy back so disk and editor agree) -> save (persist).
 */
export function createRollbackTool(cwd: string, callRpc: typeof call): Tool {
  return {
    name: "studiorpc_rollback",
    description,
    parameters: params,
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const { snapshotId } = params.parse(rawArgs ?? {});

      // Resolve the target before asking for approval so the prompt can say
      // what will be restored — a bare snapshot id means nothing to the user.
      let target: SnapshotEntry;
      try {
        target = snapshotId ? findSnapshotById(cwd, snapshotId) : findLatestSnapshot(cwd);
      } catch (error) {
        return errorResult((error as Error).message);
      }
      const shortLabel = target.label === undefined ? undefined : truncateLabel(target.label);

      const approval = await ctx.approve({
        permission: "execute",
        toolName: "studiorpc_rollback",
        description: `Roll back the Studio map to snapshot ${target.id}${shortLabel ? ` ("${shortLabel}")` : ""}`,
        details: snapshotId ? { snapshotId } : {},
      });
      if (approval === "reject") {
        return errorResult("[Rejected by user]");
      }

      // Flush the current editor state so the level files are consistent.
      // After this, the on-disk ovdrjm IS the pre-rollback state.
      await callRpc("level.save.file", {});

      // Preserve the state being discarded so this rollback can be undone.
      // Best-effort: without it the rollback still works, just without undo.
      let safetyPath: string | undefined;
      try {
        const index = nextRequestIndex(snapshotsDir(cwd), target.sessionId);
        safetyPath = captureSnapshot(cwd, target.sessionId, index, {
          label: "state before rollback",
          kind: "pre-rollback",
        });
      } catch {
        // not fatal — proceed without undo support
      }

      restoreSnapshot(cwd, target.path);
      try {
        await callRpc("level.apply", {});
      } catch (error) {
        // The editor was not synced. Put the file back to the pre-rollback
        // state so disk and editor agree; otherwise the turn-end save would
        // silently overwrite the restored file with the editor's state.
        if (safetyPath) restoreSnapshot(cwd, safetyPath);
        return errorResult(
          `Rollback failed: level.apply error (${(error as Error).message}). The map was left unchanged; ` +
            `fix the Studio connection and retry.`,
        );
      }
      await callRpc("level.save.file", {});

      const labelNote = shortLabel ? ` ("${shortLabel}")` : "";
      const undoNote = safetyPath
        ? " To undo this rollback, restore the pre-rollback snapshot listed by studiorpc_snapshot_list."
        : "";
      return {
        output:
          `Rolled back to snapshot ${target.id}${labelNote}, captured at ${target.createdAt}. ` +
          `Instances and scripts created after that point no longer exist — re-read the map before ` +
          `referencing them.${undoNote}`,
        metadata: { method: "rollback", restored: target.id },
      };
    },
  };
}
```

Design note: the safety snapshot reuses `target.sessionId` for its filename so it groups (and prunes) with the session it undoes — the tool has no access to the current turn's session id and does not need it. `// ponytail: target session reused; plumb real session id only if per-session scoping ever lands`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/tools/studiorpc-rollback.test.ts`
Expected: PASS — including the pre-existing `createRollbackTool` tests: the "restores the latest snapshot" test's `calls` assertion still sees `["level.save.file", "level.apply", "level.save.file"]`, and the "no snapshot to roll back to" test still gets an error before `level.apply` (now even before the flush save — its only RPC assertion is `not.toContain("level.apply")`, which still holds).

- [ ] **Step 6: Commit**

```bash
git add src/tools/studiorpc/tools/rollback-tool.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): targeted rollback with pre-rollback safety snapshot and apply-failure recovery"
```

---

### Task 7: Full verification sweep

**Files:**
- No new code. Verification + any doc references.

- [ ] **Step 1: Run the whole sidecar test suite**

Run (from `apps/overdare-ai-agent/sidecar/`): `bun test`
Expected: PASS, zero failures. If unrelated pre-existing failures appear, note them and confirm they also fail on the base branch before proceeding.

- [ ] **Step 2: Typecheck**

Run (from repo root): `bun run typecheck` — if that script does not exist, run `bunx tsc --noEmit -p apps/overdare-ai-agent/sidecar` (check `package.json` scripts first and prefer the repo's own command).
Expected: no errors.

- [ ] **Step 3: Check doc/skill references to the rollback tool**

Run: `grep -rn "studiorpc_rollback\|studiorpc_snapshot" apps/overdare-ai-agent/bootstrap docs --include="*.md"`
If any hit describes the old parameterless-only behavior (e.g. `bootstrap/skills/overdare-debug-expert/SKILL.md`), update the sentence to mention `snapshotId` + `studiorpc_snapshot_list`. If no hits describe behavior, nothing to do.

- [ ] **Step 4: Commit (only if Step 3 changed docs)**

```bash
git add -A apps/overdare-ai-agent/bootstrap docs
git commit -m "docs(studiorpc): document point-in-time rollback and snapshot list tool"
```

---

## Self-Review Notes

- **Spec coverage:** improvements 1, 2, 3, 4, 5, 7 and the breakpoint feature each map to tasks (see coverage table); improvement 6 is explicitly descoped with rationale and a follow-up path.
- **Type consistency:** `SnapshotEntry`/`SnapshotMeta`/`CaptureOptions`/`SnapshotKind` are defined once in Task 1 and consumed by name in Tasks 2–6; `findLatestSnapshot` widening to `SnapshotEntry` is backward compatible with the existing `{ id, path }` consumers.
- **Behavioral compatibility:** legacy snapshots without sidecars list as kind `"turn"`; parameterless rollback remains idempotent because `findLatestSnapshot` skips `pre-rollback` entries; the one intentionally changed test is rewritten in Task 6 Step 1 with the new invariant spelled out.
