// @summary Persist and validate only the latest downloaded Studio ZIP for local Windows Sandbox runs.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface StudioArchiveDescriptor {
  bucket: string;
  region: string;
  key: string;
  lastModified: string;
  size: number;
}

interface StudioArchiveCacheManifest extends StudioArchiveDescriptor {
  sha256: string;
}

export interface ResolveStudioArchiveCacheOptions {
  cacheRoot: string;
  descriptor: StudioArchiveDescriptor;
  expectedSha256?: string;
  download: (path: string) => Promise<void>;
}

export interface ResolvedStudioArchiveCache {
  archivePath: string;
  sha256: string;
  cacheHit: boolean;
}

export async function hashStudioArchive(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

function isMatchingManifest(manifest: StudioArchiveCacheManifest, descriptor: StudioArchiveDescriptor): boolean {
  return (
    manifest.bucket === descriptor.bucket &&
    manifest.region === descriptor.region &&
    manifest.key === descriptor.key &&
    manifest.lastModified === descriptor.lastModified &&
    manifest.size === descriptor.size &&
    /^[a-f0-9]{64}$/.test(manifest.sha256)
  );
}

async function readManifest(path: string): Promise<StudioArchiveCacheManifest | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as StudioArchiveCacheManifest;
  } catch {
    return undefined;
  }
}

export async function resolveStudioArchiveCache(
  options: ResolveStudioArchiveCacheOptions,
): Promise<ResolvedStudioArchiveCache> {
  const cacheRoot = resolve(options.cacheRoot);
  const archivePath = resolve(cacheRoot, "studio.zip");
  const manifestPath = resolve(cacheRoot, "manifest.json");
  await mkdir(cacheRoot, { recursive: true });

  const manifest = await readManifest(manifestPath);
  if (manifest && isMatchingManifest(manifest, options.descriptor)) {
    try {
      const archiveStat = await stat(archivePath);
      if (archiveStat.isFile() && archiveStat.size === options.descriptor.size) {
        const actualSha256 = await hashStudioArchive(archivePath);
        if (actualSha256 === manifest.sha256 && (!options.expectedSha256 || actualSha256 === options.expectedSha256)) {
          return { archivePath, sha256: actualSha256, cacheHit: true };
        }
      }
    } catch {}
  }

  const operationId = randomUUID();
  const partialArchivePath = resolve(cacheRoot, `studio.zip.partial-${operationId}`);
  const partialManifestPath = resolve(cacheRoot, `manifest.json.partial-${operationId}`);
  try {
    await options.download(partialArchivePath);
    const archiveStat = await stat(partialArchivePath);
    if (!archiveStat.isFile() || archiveStat.size !== options.descriptor.size) {
      throw new Error(
        `Studio archive size mismatch: expected ${options.descriptor.size}, received ${archiveStat.size}`,
      );
    }
    const actualSha256 = await hashStudioArchive(partialArchivePath);
    if (options.expectedSha256 && actualSha256 !== options.expectedSha256) {
      throw new Error(`Studio SHA-256 mismatch: expected ${options.expectedSha256}, received ${actualSha256}`);
    }

    const nextManifest: StudioArchiveCacheManifest = {
      ...options.descriptor,
      sha256: actualSha256,
    };
    await writeFile(partialManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    await rm(archivePath, { force: true });
    await rename(partialArchivePath, archivePath);
    await rm(manifestPath, { force: true });
    await rename(partialManifestPath, manifestPath);
    return { archivePath, sha256: actualSha256, cacheHit: false };
  } finally {
    await Promise.all([
      rm(partialArchivePath, { force: true }).catch(() => {}),
      rm(partialManifestPath, { force: true }).catch(() => {}),
    ]);
  }
}
