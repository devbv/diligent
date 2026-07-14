// @summary Tests Studio rollback snapshot helpers and the (full-restore) rollback tool.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import { createRollbackTool } from "../../src/tools/studiorpc/tools/rollback-tool";
import {
  captureSnapshot,
  findLatestSnapshot,
  findSnapshotById,
  listSnapshots,
  nextRequestIndex,
  pruneSnapshots,
  restoreSnapshot,
  snapshotsDir,
} from "../../src/tools/studiorpc/tools/snapshot";
import { createSnapshotListTool } from "../../src/tools/studiorpc/tools/snapshot-list-tool";

function projectDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(cwd, "world.umap"), "umap");
  writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":1}}');
  return cwd;
}

function toolCtx() {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    abort: () => {},
    approve: async () => "once" as const,
  };
}

describe("nextRequestIndex", () => {
  test("returns 0 when no snapshots exist for the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    expect(nextRequestIndex(dir, "sess1")).toBe(0);
  });

  test("returns max index + 1 for the given session only", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    writeFileSync(join(dir, "sess1_0.ovdrjm"), "{}");
    writeFileSync(join(dir, "sess1_1.ovdrjm"), "{}");
    writeFileSync(join(dir, "other_5.ovdrjm"), "{}"); // different session ignored
    expect(nextRequestIndex(dir, "sess1")).toBe(2);
  });
});

describe("captureSnapshot", () => {
  test("copies the current ovdrjm into the snapshots dir with the snapshot name", () => {
    const cwd = projectDir();
    const path = captureSnapshot(cwd, "sess1", 2);
    expect(path).toBe(join(snapshotsDir(cwd), "sess1_2.ovdrjm"));
    expect(readFileSync(path, "utf-8")).toBe('{"Root":{"x":1}}');
  });

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
});

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

describe("findLatestSnapshot", () => {
  test("picks the most recently modified snapshot", () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), "old");
    writeFileSync(join(dir, "sess_1.ovdrjm"), "new");
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    const latest = findLatestSnapshot(cwd);
    expect(latest.path).toBe(join(dir, "sess_1.ovdrjm"));
    expect(latest.id).toBe("sess_1");
  });

  test("throws when no snapshot exists", () => {
    const cwd = projectDir();
    expect(() => findLatestSnapshot(cwd)).toThrow();
  });

  test("skips pre-rollback snapshots so repeated default rollback stays idempotent", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "edit" });
    captureSnapshot(cwd, "sess", 1, { kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    expect(findLatestSnapshot(cwd).id).toBe("sess_0"); // newest non-pre-rollback
  });
});

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

describe("restoreSnapshot", () => {
  test("overwrites the project ovdrjm with the snapshot bytes", () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    const snap = join(dir, "sess_0.ovdrjm");
    writeFileSync(snap, '{"Root":{"restored":true}}');
    restoreSnapshot(cwd, snap);
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"restored":true}}');
  });
});

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

describe("snapshot capture on first edit", () => {
  function hookInput(cwd: string, sessionId: string) {
    return {
      session_id: sessionId,
      transcript_path: "/tmp/s.jsonl",
      cwd,
      hook_event_name: "UserPromptSubmit",
      prompt: "go",
    };
  }

  // asset_drawer_import is a mutating Studio RPC tool that only calls callRpc,
  // so it exercises the "first edit" capture path without touching the ovdrjm.
  const importArgs = { assetid: "ovdrassetid://1", assetName: "Tree", assetType: "MODEL" };

  async function setup(cwd: string, sessionId: string) {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const p = provider as typeof provider & {
      onUserPromptSubmit: NonNullable<typeof provider.onUserPromptSubmit>;
    };
    await p.onUserPromptSubmit(hookInput(cwd, sessionId)); // begins the turn
    const tools = await provider.createTools({ cwd, host: { approve: async () => "once" } });
    return { provider: p, tools };
  }

  test("captures a snapshot right before the first edit tool runs", async () => {
    const cwd = projectDir();
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    expect(existsSync(join(snapshotsDir(cwd), "sess_0.ovdrjm"))).toBe(false); // not yet
    await importTool.execute(importArgs as never, toolCtx());
    expect(existsSync(join(snapshotsDir(cwd), "sess_0.ovdrjm"))).toBe(true); // captured
  });

  test("captures only once per turn even across multiple edits", async () => {
    const cwd = projectDir();
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    await importTool.execute(importArgs as never, toolCtx());
    await importTool.execute(importArgs as never, toolCtx());

    expect(existsSync(join(snapshotsDir(cwd), "sess_0.ovdrjm"))).toBe(true);
    expect(existsSync(join(snapshotsDir(cwd), "sess_1.ovdrjm"))).toBe(false); // no second snapshot
  });

  test("a turn with no edit tool produces no snapshot", async () => {
    const cwd = projectDir();
    await setup(cwd, "sess"); // turn began, but no edit tool runs
    expect(existsSync(join(snapshotsDir(cwd), "sess_0.ovdrjm"))).toBe(false);
  });

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
});

describe("createRollbackTool", () => {
  test("restores the latest snapshot and calls save -> apply -> save", async () => {
    const cwd = projectDir(); // current ovdrjm = {"Root":{"x":1}}
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}');
    const calls: string[] = [];
    const tool = createRollbackTool(cwd, async (method) => {
      calls.push(method);
      return {};
    });

    const result = await tool.execute({} as never, toolCtx());

    // Full restore regardless of any user edits in the current map.
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"original":true}}');
    expect(calls).toEqual(["level.save.file", "level.apply", "level.save.file"]);
    expect(result.metadata?.error).toBeUndefined();
  });

  test("reports an error when there is no snapshot to roll back to", async () => {
    const cwd = projectDir();
    const calls: string[] = [];
    const tool = createRollbackTool(cwd, async (method) => {
      calls.push(method);
      return {};
    });

    const result = await tool.execute({} as never, toolCtx());

    expect(result.metadata?.error).toBe(true);
    expect(calls).not.toContain("level.apply");
  });

  test("is registered as a tool on the provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const tools = await provider.createTools({
      cwd: "/tmp/project",
      host: { approve: async () => "once" },
    });
    expect(tools.map((tool) => tool.name)).toContain("studiorpc_rollback");
  });

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

  test("re-saves the editor state when both the safety snapshot and level.apply fail", async () => {
    const cwd = projectDir(); // current = {"Root":{"x":1}} — the pre-rollback state
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}');
    chmodSync(dir, 0o555); // safety snapshot capture fails: dir is read-only
    try {
      const calls: string[] = [];
      const tool = createRollbackTool(cwd, async (method) => {
        calls.push(method);
        if (method === "level.apply") throw new Error("editor busy");
        return {};
      });

      const result = await tool.execute({} as never, toolCtx());

      expect(result.metadata?.error).toBe(true);
      // No safety copy existed, so the recovery is an editor re-save.
      expect(calls).toEqual(["level.save.file", "level.apply", "level.save.file"]);
      expect(result.output).toContain("left unchanged");
    } finally {
      chmodSync(dir, 0o755); // let temp cleanup remove the dir
    }
  });

  test("reports the inconsistency honestly when safety snapshot, apply, and re-save all fail", async () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}');
    chmodSync(dir, 0o555); // safety snapshot capture fails: dir is read-only
    try {
      let saveCalls = 0;
      const tool = createRollbackTool(cwd, async (method) => {
        if (method === "level.apply") throw new Error("editor busy");
        if (method === "level.save.file" && ++saveCalls > 1) throw new Error("editor gone");
        return {};
      });

      const result = await tool.execute({} as never, toolCtx());

      expect(result.metadata?.error).toBe(true);
      expect(result.output).toContain("verify the map state");
      expect(result.output).not.toContain("left unchanged");
    } finally {
      chmodSync(dir, 0o755); // let temp cleanup remove the dir
    }
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
});

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
