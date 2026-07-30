// @summary Tests the Studio instance registry the MCP router discovers instances from (P071):
// record semantics, heartbeat expiry, PID liveness, atomic writes, and malformed-file tolerance.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSidecarToken,
  createStudioRegistry,
  DEFAULT_STALE_AFTER_MS,
  describeStudioInstance,
  isProcessAlive,
  resolveRegistryDir,
  type StudioInstanceRecord,
  startStudioRegistration,
} from "../src/studio-registry";

async function registryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "overdare-studios-"));
}

/**
 * A pid that is guaranteed not to be running: a process we started and reaped.
 * Spawns the current runtime rather than a shell so this works on Windows too.
 */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

function record(overrides: Partial<StudioInstanceRecord> = {}): StudioInstanceRecord {
  const now = new Date().toISOString();
  return {
    id: "studio-1",
    displayName: "proj",
    cwd: "/projects/proj",
    studioHost: "localhost",
    studioPort: 13377,
    sidecarUrl: "http://127.0.0.1:7433",
    sidecarToken: "token",
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

describe("studio registry paths", () => {
  test("registry dir is namespaced so prod and dev never share instances", () => {
    const prod = resolveRegistryDir({ HOME: "/home/u", DILIGENT_STORAGE_NAMESPACE: "overdare" } as NodeJS.ProcessEnv);
    const dev = resolveRegistryDir({
      HOME: "/home/u",
      DILIGENT_STORAGE_NAMESPACE: "overdare-dev",
    } as NodeJS.ProcessEnv);
    // This path is the only contract between the TypeScript writer and the Rust reader
    // (src/studio_registry.rs registry_dir) — a change here must be mirrored there. Built with
    // join() rather than a literal so the separator matches on Windows.
    expect(prod).toBe(join("/home/u", ".overdare", "mcp", "studios"));
    expect(dev).toBe(join("/home/u", ".overdare-dev", "mcp", "studios"));
    expect(prod).not.toBe(dev);
  });

  test("registry dir falls back to the packaged namespace when none is set", () => {
    expect(resolveRegistryDir({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe(
      join("/home/u", ".overdare", "mcp", "studios"),
    );
  });

  test("display name shows the project folder, disambiguated by project id", () => {
    expect(describeStudioInstance("/games/dungeon")).toBe("dungeon");
    expect(describeStudioInstance("/games/dungeon", "abc123")).toBe("dungeon (abc123)");
  });

  test("sidecar tokens are long and unguessable", () => {
    const first = createSidecarToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(createSidecarToken());
  });
});

describe("process liveness", () => {
  test("our own pid is alive and a reaped pid is not", async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(await deadPid())).toBe(false);
  });

  test("a pid owned by another user counts as alive", () => {
    // kill(pid, 0) answers EPERM for a live process we may not signal. Reading that as "dead"
    // would drop a healthy sibling Studio from the router's list.
    const eperm = () => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    };
    expect(isProcessAlive(1234, eperm)).toBe(true);
  });

  test("nonsense pids are never alive", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe("register / list / heartbeat / unregister", () => {
  test("a registered record round-trips and is listed as live", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record());

    const live = await registry.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe("studio-1");
    expect(live[0]?.sidecarToken).toBe("token");
  });

  test("the record file is written atomically and left private", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record());

    const entries = await readdir(dir);
    // A leftover temp file would be read by the router as a second (bogus) Studio.
    expect(entries).toEqual(["studio-1.json"]);

    if (process.platform !== "win32") {
      const stat = await Bun.file(join(dir, "studio-1.json")).stat();
      // The record carries a bearer token, so it must not be group/world readable.
      expect(stat.mode & 0o077).toBe(0);
    }
    // On Windows chmod is a no-op and POSIX mode bits are not meaningful; the record's privacy
    // rests on the user-profile ACL instead. Verifying that is a manual step — see
    // docs/plan/feature/P071-overdare-mcp-router-handoff.md.
  });

  test("heartbeat advances the timestamp without disturbing the rest of the record", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const original = record({ heartbeatAt: new Date(Date.now() - 5_000).toISOString() });
    await registry.register(original);

    await registry.heartbeat("studio-1");
    const [refreshed] = await registry.list();
    expect(Date.parse(refreshed?.heartbeatAt ?? "")).toBeGreaterThan(Date.parse(original.heartbeatAt));
    expect(refreshed?.sidecarUrl).toBe(original.sidecarUrl);
    expect(refreshed?.startedAt).toBe(original.startedAt);
  });

  test("heartbeat for an unknown id is a no-op rather than an error", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.heartbeat("never-registered");
    expect(await registry.listAll()).toHaveLength(0);
  });

  test("unregister removes the record", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record());
    await registry.unregister("studio-1");
    expect(await registry.listAll()).toHaveLength(0);
    // Idempotent: a double shutdown must not throw.
    await registry.unregister("studio-1");
  });

  test("unregisterSync removes the record from an exit handler", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record());
    registry.unregisterSync("studio-1");
    expect(await registry.listAll()).toHaveLength(0);
  });
});

describe("staleness", () => {
  test("a record whose heartbeat has expired is not live", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const stale = new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 1_000).toISOString();
    await registry.register(record({ heartbeatAt: stale }));

    expect(await registry.list()).toHaveLength(0);
    expect(await registry.listAll()).toHaveLength(1);
  });

  test("a record whose process is gone is not live even with a fresh heartbeat", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record({ pid: await deadPid() }));
    expect(await registry.list()).toHaveLength(0);
  });

  test("a heartbeat in the future is skew, not staleness", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record({ heartbeatAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(await registry.list()).toHaveLength(1);
  });

  test("listAll sorts newest heartbeat first", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record({ id: "older", heartbeatAt: "2026-07-10T00:00:00.000Z" }));
    await registry.register(record({ id: "newer", heartbeatAt: "2026-07-10T00:00:10.000Z" }));
    expect((await registry.listAll()).map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});

describe("malformed records", () => {
  test("torn, incomplete, and non-JSON files are skipped without hiding good ones", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    await registry.register(record({ id: "good" }));
    await writeFile(join(dir, "torn.json"), '{"id":"torn","sidecarUr', "utf-8");
    // No sidecarToken: unroutable, so it must never be offered as a target.
    await writeFile(
      join(dir, "partial.json"),
      JSON.stringify({ id: "partial", sidecarUrl: "http://127.0.0.1:1", heartbeatAt: new Date().toISOString() }),
      "utf-8",
    );
    await writeFile(join(dir, "notes.txt"), "not a record", "utf-8");

    const all = await registry.listAll();
    expect(all.map((entry) => entry.id)).toEqual(["good"]);
  });

  test("a missing registry directory lists as empty rather than throwing", async () => {
    const registry = createStudioRegistry(join(tmpdir(), "overdare-registry-does-not-exist-12345"));
    expect(await registry.list()).toEqual([]);
    expect(await registry.listAll()).toEqual([]);
  });
});

describe("sweepStale", () => {
  test("removes records whose process is gone and whose heartbeat expired", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const expired = new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 1_000).toISOString();
    await registry.register(record({ id: "crashed", pid: await deadPid(), heartbeatAt: expired }));
    await registry.register(record({ id: "alive" }));

    expect(await registry.sweepStale()).toBe(1);
    expect((await registry.listAll()).map((entry) => entry.id)).toEqual(["alive"]);
  });

  test("keeps a stale record whose process is still running", async () => {
    // A suspended or heavily loaded machine makes every heartbeat look stale. Deleting a record
    // whose owner is alive would deregister a healthy Studio that is about to heartbeat again.
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const expired = new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 1_000).toISOString();
    await registry.register(record({ id: "sluggish", heartbeatAt: expired }));

    expect(await registry.sweepStale()).toBe(0);
    expect(await registry.listAll()).toHaveLength(1);
  });
});

describe("startStudioRegistration", () => {
  test("registers this process, publishes a catalog, and cleans up on stop", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const registration = await startStudioRegistration({
      cwd: "/games/dungeon",
      projectId: "abc123",
      hubEndpoint: "https://release-qa.overdare.com",
      studioHost: "localhost",
      studioPort: 13377,
      sidecarPort: 51234,
      sidecarToken: "tok",
      registry,
    });

    expect(registration.record.displayName).toBe("dungeon (abc123)");
    expect(registration.record.hubEndpoint).toBe("https://release-qa.overdare.com");
    expect(registration.record.pid).toBe(process.pid);
    // The router reaches the sidecar over loopback only.
    expect(registration.record.sidecarUrl).toBe("http://127.0.0.1:51234");
    expect(registration.record.id).not.toBe("");

    let [live] = await registry.list();
    expect(live?.catalog).toBeUndefined();

    await registration.updateCatalog({
      tools: [{ name: "studiorpc_instance_read", description: "d", inputSchema: { type: "object" } }],
      prompts: [{ name: "agent-x", description: "p" }],
      instructions: "INSTRUCTIONS",
    });
    [live] = await registry.list();
    expect(live?.catalog?.tools.map((tool) => tool.name)).toEqual(["studiorpc_instance_read"]);
    expect(live?.catalog?.instructions).toBe("INSTRUCTIONS");
    // The id must survive the catalog update, or the router would see two Studios.
    expect(live?.id).toBe(registration.record.id);

    registration.stop();
    expect(await registry.listAll()).toHaveLength(0);
    registration.stop();
  });

  test("a heartbeat keeps the record live and stop halts it", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const registration = await startStudioRegistration({
      cwd: "/games/dungeon",
      studioHost: "localhost",
      studioPort: 13377,
      sidecarPort: 51234,
      sidecarToken: "tok",
      registry,
      heartbeatIntervalMs: 10,
    });
    const first = registration.record.heartbeatAt;

    await Bun.sleep(60);
    const [beating] = await registry.listAll();
    expect(Date.parse(beating?.heartbeatAt ?? "")).toBeGreaterThan(Date.parse(first));

    registration.stop();
    // After stop the record is gone, so a later heartbeat must not resurrect it.
    await Bun.sleep(40);
    expect(await registry.listAll()).toHaveLength(0);
  });

  test("a crashed predecessor is swept so it cannot look like a second Studio", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const expired = new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 1_000).toISOString();
    await registry.register(record({ id: "crashed", pid: await deadPid(), heartbeatAt: expired }));

    const registration = await startStudioRegistration({
      cwd: "/games/dungeon",
      studioHost: "localhost",
      studioPort: 13377,
      sidecarPort: 51234,
      sidecarToken: "tok",
      registry,
    });

    // Exactly one live Studio means the router auto-selects instead of refusing as ambiguous.
    expect(await registry.list()).toHaveLength(1);
    expect(await registry.listAll()).toHaveLength(1);
    registration.stop();
  });

  test("the record on disk is valid JSON with the field names the Rust reader expects", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const registration = await startStudioRegistration({
      cwd: "/games/dungeon",
      projectId: "abc123",
      hubEndpoint: "https://release-qa.overdare.com",
      studioHost: "localhost",
      studioPort: 13377,
      sidecarPort: 51234,
      sidecarToken: "tok",
      registry,
    });

    const raw = JSON.parse(await readFile(join(dir, `${registration.record.id}.json`), "utf-8"));
    // src/studio_registry.rs record_from_value() requires these four to parse a record at all.
    for (const key of ["id", "sidecarUrl", "sidecarToken", "heartbeatAt"]) {
      expect(raw[key]).toBeString();
    }
    expect(raw.studioPort).toBe(13377);
    expect(raw.projectId).toBe("abc123");
    expect(raw.hubEndpoint).toBe("https://release-qa.overdare.com");
    registration.stop();
  });

  test("missing optional session metadata leaves the fields off rather than writing null", async () => {
    const dir = await registryDir();
    const registry = createStudioRegistry(dir);
    const registration = await startStudioRegistration({
      cwd: "/games/dungeon",
      studioHost: "localhost",
      studioPort: 13377,
      sidecarPort: 51234,
      sidecarToken: "tok",
      registry,
    });
    const raw = JSON.parse(await readFile(join(dir, `${registration.record.id}.json`), "utf-8"));
    expect("projectId" in raw).toBe(false);
    expect("hubEndpoint" in raw).toBe(false);
    expect(registration.record.displayName).toBe("dungeon");
    registration.stop();
  });
});
