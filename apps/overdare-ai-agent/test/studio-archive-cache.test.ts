// @summary Verify that the Windows Studio smoke archive cache reuses only an unchanged, validated S3 object.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStudioArchiveCache } from "./studio-smoke/archive-cache";

const ARCHIVE = new TextEncoder().encode("studio archive");
const DESCRIPTOR = {
  bucket: "ovdr-build-binary",
  region: "ap-northeast-2",
  key: "Sandbox/Windows/37.1.0-release_Sandbox_Shipping.zip",
  lastModified: "2026-07-23T05:56:07.000Z",
  size: ARCHIVE.byteLength,
};

describe("Studio archive cache", () => {
  test("downloads once and reuses the validated archive while the S3 object is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-archive-cache-"));
    let downloads = 0;
    const download = async (path: string) => {
      downloads += 1;
      await writeFile(path, ARCHIVE);
    };

    try {
      const first = await resolveStudioArchiveCache({
        cacheRoot: root,
        descriptor: DESCRIPTOR,
        download,
      });
      const second = await resolveStudioArchiveCache({
        cacheRoot: root,
        descriptor: DESCRIPTOR,
        download,
      });

      expect(first.cacheHit).toBe(false);
      expect(second.cacheHit).toBe(true);
      expect(downloads).toBe(1);
      expect(await readFile(second.archivePath)).toEqual(ARCHIVE);
      expect(second.sha256).toBe(first.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redownloads when object metadata changes or the cached archive is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-archive-cache-"));
    let downloads = 0;
    const download = async (path: string) => {
      downloads += 1;
      await writeFile(path, ARCHIVE);
    };

    try {
      const first = await resolveStudioArchiveCache({
        cacheRoot: root,
        descriptor: DESCRIPTOR,
        download,
      });
      await writeFile(first.archivePath, "corrupt");
      const repaired = await resolveStudioArchiveCache({
        cacheRoot: root,
        descriptor: DESCRIPTOR,
        download,
      });
      const changed = await resolveStudioArchiveCache({
        cacheRoot: root,
        descriptor: { ...DESCRIPTOR, key: DESCRIPTOR.key.replace("37.1.0", "38.0.0") },
        download,
      });

      expect(repaired.cacheHit).toBe(false);
      expect(changed.cacheHit).toBe(false);
      expect(downloads).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an expected checksum mismatch without replacing the valid cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-archive-cache-"));
    try {
      await expect(
        resolveStudioArchiveCache({
          cacheRoot: root,
          descriptor: DESCRIPTOR,
          expectedSha256: "a".repeat(64),
          download: (path) => writeFile(path, ARCHIVE),
        }),
      ).rejects.toThrow("SHA-256 mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
