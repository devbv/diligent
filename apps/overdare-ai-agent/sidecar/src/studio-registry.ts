// @summary Per-Studio sidecar registration records the Rust MCP router discovers instances from
// (P071 Task 2): atomic write + heartbeat under <storage>/mcp/studios/<id>.json, with stale
// filtering by heartbeat age and PID liveness.

import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PACKAGED_STORAGE_NAMESPACE = "overdare";

/** How long a record stays trusted after its last heartbeat. */
export const DEFAULT_STALE_AFTER_MS = 15_000;
/** Heartbeat cadence — comfortably inside DEFAULT_STALE_AFTER_MS so one missed tick is not fatal. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** One MCP tool as the router re-advertises it, mirroring MCP's `tools/list` entry shape. */
export interface StudioToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One MCP prompt as the router re-advertises it. */
export interface StudioPromptDescriptor {
  name: string;
  description: string;
}

/**
 * Snapshot of what this sidecar's MCP surface exposes.
 *
 * Carried in the record (rather than fetched over HTTP on every `tools/list`) so the router can
 * answer `tools/list` and `initialize` with zero round-trips — and, using the newest record on
 * disk, even when no Studio is currently live. The snapshot is accurate because the sidecar builds
 * its registries once at startup.
 */
export interface StudioCatalogSnapshot {
  tools: StudioToolDescriptor[];
  prompts: StudioPromptDescriptor[];
  /** Server-level guidance the router forwards on `initialize`. */
  instructions?: string;
}

export interface StudioInstanceRecord {
  /** Generated per sidecar process — never derived from the mutable cwd. */
  id: string;
  displayName: string;
  cwd: string;
  projectId?: string;
  /** Hub base URL associated with this Studio session. */
  hubEndpoint?: string;
  studioHost: string;
  studioPort: number;
  sidecarUrl: string;
  /** Bearer token the router must present on the router-callable endpoint. */
  sidecarToken: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  catalog?: StudioCatalogSnapshot;
}

export interface ListOptions {
  now?: Date;
  staleAfterMs?: number;
}

export interface StudioRegistry {
  register(record: StudioInstanceRecord): Promise<void>;
  heartbeat(id: string): Promise<void>;
  unregister(id: string): Promise<void>;
  /**
   * Synchronous variant for `process.on("exit")` and signal handlers, where the loop is already
   * gone and an awaited unlink would silently never run.
   */
  unregisterSync(id: string): void;
  /** Live records only (fresh heartbeat + running PID), newest heartbeat first. */
  list(options?: ListOptions): Promise<StudioInstanceRecord[]>;
  /** Every parseable record including stale ones, newest heartbeat first. */
  listAll(): Promise<StudioInstanceRecord[]>;
  /** Deletes records whose owning process is gone. Best-effort. */
  sweepStale(options?: ListOptions): Promise<number>;
}

function storageNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DILIGENT_STORAGE_NAMESPACE?.trim();
  return value || PACKAGED_STORAGE_NAMESPACE;
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE ?? env.HOME ?? homedir();
}

/**
 * Registry directory. Must stay byte-identical to the Rust router's
 * `studio_registry::registry_dir` (see apps/overdare-ai-agent/src/studio_registry.rs) — the two
 * sides only agree through this path.
 */
export function resolveRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHomeDir(env), `.${storageNamespace(env)}`, "mcp", "studios");
}

/**
 * Whether `pid` is still running. A live process owned by another user answers EPERM, which is
 * still "alive" — treating it as dead would drop a valid sibling Studio from the router's list.
 */
export function isProcessAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isFresh(record: StudioInstanceRecord, now: Date, staleAfterMs: number): boolean {
  const beat = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(beat)) return false;
  const age = now.getTime() - beat;
  // A clock that jumped backwards yields a negative age; that is skew, not staleness.
  return age <= staleAfterMs;
}

function isRecordLive(record: StudioInstanceRecord, now: Date, staleAfterMs: number): boolean {
  return isFresh(record, now, staleAfterMs) && isProcessAlive(record.pid);
}

function byHeartbeatDesc(a: StudioInstanceRecord, b: StudioInstanceRecord): number {
  return (Date.parse(b.heartbeatAt) || 0) - (Date.parse(a.heartbeatAt) || 0);
}

/** Records are only ever trusted when they carry the fields the router needs to route a call. */
function parseRecord(raw: string): StudioInstanceRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StudioInstanceRecord>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.sidecarUrl !== "string" || !record.sidecarUrl) return null;
  if (typeof record.sidecarToken !== "string" || !record.sidecarToken) return null;
  if (typeof record.pid !== "number") return null;
  if (typeof record.heartbeatAt !== "string") return null;
  return record as StudioInstanceRecord;
}

/** Generates the bearer token the router presents back to this sidecar. */
export function createSidecarToken(): string {
  return randomBytes(32).toString("hex");
}

export function createStudioInstanceId(): string {
  return randomUUID();
}

/**
 * Human-facing label for a Studio instance. The project folder name is what a user recognizes in a
 * "which Studio?" prompt; the project ID disambiguates two folders with the same name.
 */
export function describeStudioInstance(cwd: string, projectId?: string): string {
  const folder = basename(cwd) || cwd;
  return projectId ? `${folder} (${projectId})` : folder;
}

export function createStudioRegistry(dir: string = resolveRegistryDir()): StudioRegistry {
  const recordPath = (id: string): string => join(dir, `${id}.json`);

  const ensureDir = async (): Promise<void> => {
    await mkdir(dir, { recursive: true });
    // Records hold sidecar bearer tokens. Best-effort on Windows, where chmod is a no-op.
    await chmod(dir, 0o700).catch(() => {});
  };

  const readAll = async (): Promise<StudioInstanceRecord[]> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const records: StudioInstanceRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = await readFile(join(dir, entry), "utf-8");
      } catch {
        // Vanished between readdir and readFile (a sibling unregistering), or unreadable.
        continue;
      }
      const record = parseRecord(raw);
      if (record) records.push(record);
    }
    return records.sort(byHeartbeatDesc);
  };

  /**
   * Write via temp-then-rename so a concurrently listing router never observes partial JSON.
   * The temp name carries the pid so two writers cannot collide on it.
   */
  const writeRecord = async (record: StudioInstanceRecord): Promise<void> => {
    await ensureDir();
    const target = recordPath(record.id);
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, target);
  };

  let cached: StudioInstanceRecord | undefined;
  // A heartbeat may already be inside an async write when shutdown begins. Remember removals so
  // that in-flight work cannot recreate a record after unregisterSync() has deleted it.
  const unregistered = new Set<string>();

  return {
    async register(record) {
      unregistered.delete(record.id);
      cached = record;
      await writeRecord(record);
    },

    async heartbeat(id) {
      if (unregistered.has(id)) return;
      // Heartbeat from the in-memory record rather than re-reading: a partially written or
      // externally deleted file must not be able to corrupt or resurrect our own registration.
      const base = cached?.id === id ? cached : parseRecord(await readFile(recordPath(id), "utf-8").catch(() => ""));
      if (!base || unregistered.has(id)) return;
      const next = { ...base, heartbeatAt: new Date().toISOString() };
      cached = next;
      await writeRecord(next);
      if (unregistered.has(id)) {
        if (cached?.id === id) cached = undefined;
        await rm(recordPath(id), { force: true }).catch(() => {});
      }
    },

    async unregister(id) {
      unregistered.add(id);
      if (cached?.id === id) cached = undefined;
      await rm(recordPath(id), { force: true }).catch(() => {});
    },

    unregisterSync(id) {
      unregistered.add(id);
      if (cached?.id === id) cached = undefined;
      try {
        rmSync(recordPath(id), { force: true });
      } catch {
        // A record we cannot delete expires by heartbeat instead.
      }
    },

    async list(options = {}) {
      const now = options.now ?? new Date();
      const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
      return (await readAll()).filter((record) => isRecordLive(record, now, staleAfterMs));
    },

    listAll: readAll,

    async sweepStale(options = {}) {
      const now = options.now ?? new Date();
      const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
      let removed = 0;
      for (const record of await readAll()) {
        // Heartbeat age alone is not grounds for deletion — a suspended machine makes every
        // record look stale. Only a confirmed-dead PID proves the record can never be renewed.
        if (isProcessAlive(record.pid)) continue;
        if (isFresh(record, now, staleAfterMs)) continue;
        await rm(recordPath(record.id), { force: true }).catch(() => {});
        removed += 1;
      }
      return removed;
    },
  };
}

export interface StartRegistrationOptions {
  cwd: string;
  projectId?: string;
  hubEndpoint?: string;
  studioHost: string;
  studioPort: number;
  /** Port the sidecar web server (and thus the router-callable endpoint) listens on. */
  sidecarPort: number;
  sidecarToken: string;
  catalog?: StudioCatalogSnapshot;
  registry?: StudioRegistry;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

export interface StudioRegistration {
  record: StudioInstanceRecord;
  /**
   * Publishes the MCP catalog once it has been built.
   *
   * Registration happens as soon as the sidecar port is known so the router discovers the instance
   * immediately; the catalog lands a moment later rather than delaying the whole registration
   * behind building the tool registries.
   */
  updateCatalog: (catalog: StudioCatalogSnapshot) => Promise<void>;
  /**
   * Stops the heartbeat and deletes the record synchronously, so it works from `exit` and signal
   * handlers. Safe to call more than once.
   */
  stop: () => void;
}

/**
 * Registers this sidecar as one Studio instance and keeps the record fresh.
 *
 * Sweeping first keeps a crashed predecessor from making the router see a phantom second Studio
 * (which would make it refuse every Studio tool call as ambiguous).
 */
export async function startStudioRegistration(options: StartRegistrationOptions): Promise<StudioRegistration> {
  const registry = options.registry ?? createStudioRegistry();
  const now = options.now ?? (() => new Date());
  await registry.sweepStale().catch(() => 0);

  const startedAt = now().toISOString();
  const hubEndpoint = options.hubEndpoint?.trim();
  const record: StudioInstanceRecord = {
    id: createStudioInstanceId(),
    displayName: describeStudioInstance(options.cwd, options.projectId),
    cwd: options.cwd,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(hubEndpoint ? { hubEndpoint } : {}),
    studioHost: options.studioHost,
    studioPort: options.studioPort,
    sidecarUrl: `http://127.0.0.1:${options.sidecarPort}`,
    sidecarToken: options.sidecarToken,
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
    ...(options.catalog ? { catalog: options.catalog } : {}),
  };
  await registry.register(record);

  const interval = setInterval(() => {
    void registry.heartbeat(record.id).catch(() => {});
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  // Never hold the process open for a heartbeat.
  interval.unref?.();

  let stopped = false;
  let current = record;
  return {
    record,
    updateCatalog: async (catalog) => {
      if (stopped) return;
      current = { ...current, catalog, heartbeatAt: now().toISOString() };
      await registry.register(current);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      registry.unregisterSync(record.id);
    },
  };
}
