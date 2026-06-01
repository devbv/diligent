// @summary Externalize tool_result image blobs to a sidecar directory so JSONL session files stay small.
//
// On write, ImageBlock.source.data (base64) is hashed, written to {sessionsDir}/blobs/{sha256}.bin
// as raw bytes, and replaced in the entry with a sentinel `blob:{sha256}` reference. On read,
// blob refs are restored back to base64 by reading the sidecar file. Sessions written before
// this change continue to work — entries with literal base64 are passed through untouched on read.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "./types";

const BLOB_REF_PREFIX = "blob:";
const BLOBS_SUBDIR = "blobs";

function isBlobRef(data: string): boolean {
  return data.startsWith(BLOB_REF_PREFIX);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function blobsDir(sessionsDir: string): string {
  return join(sessionsDir, BLOBS_SUBDIR);
}

function blobPath(sessionsDir: string, hash: string): string {
  return join(blobsDir(sessionsDir), `${hash}.bin`);
}

/**
 * Walk an entry and return a deep-cloned copy with all ImageBlock.source.data
 * base64 strings replaced by `blob:{sha256}` refs. The referenced blobs are
 * written to disk under {sessionsDir}/blobs/ as raw bytes (de-base64). Idempotent
 * for already-externalized entries.
 */
export async function externalizeEntryImages(sessionsDir: string, entry: SessionEntry): Promise<SessionEntry> {
  if (entry.type !== "message") return entry;
  if (entry.message.role !== "tool_result") return entry;
  const images = entry.message.outputImages;
  if (!images || images.length === 0) return entry;

  let dirEnsured = false;
  const externalizedImages = await Promise.all(
    images.map(async (img) => {
      if (isBlobRef(img.source.data)) return img;
      const hash = await sha256Hex(img.source.data);
      if (!dirEnsured) {
        await mkdir(blobsDir(sessionsDir), { recursive: true });
        dirEnsured = true;
      }
      const path = blobPath(sessionsDir, hash);
      // Avoid re-writing identical blobs; treat any error as "must write".
      const existing = Bun.file(path);
      if (!(await existing.exists())) {
        const bytes = Buffer.from(img.source.data, "base64");
        await writeFile(path, bytes);
      }
      return { ...img, source: { ...img.source, data: `${BLOB_REF_PREFIX}${hash}` } };
    }),
  );

  return {
    ...entry,
    message: { ...entry.message, outputImages: externalizedImages },
  };
}

/**
 * Reverse of externalizeEntryImages — replaces `blob:{sha256}` refs with the
 * full base64 string read from the sidecar. Entries already containing literal
 * base64 pass through untouched (backward compatibility with pre-sidecar sessions).
 */
export async function materializeEntryImages(sessionsDir: string, entry: SessionEntry): Promise<SessionEntry> {
  if (entry.type !== "message") return entry;
  if (entry.message.role !== "tool_result") return entry;
  const images = entry.message.outputImages;
  if (!images || images.length === 0) return entry;

  const materializedImages = await Promise.all(
    images.map(async (img) => {
      if (!isBlobRef(img.source.data)) return img;
      const hash = img.source.data.slice(BLOB_REF_PREFIX.length);
      try {
        const bytes = await readFile(blobPath(sessionsDir, hash));
        return { ...img, source: { ...img.source, data: bytes.toString("base64") } };
      } catch {
        // Blob missing on disk — return a 1px transparent PNG placeholder so the
        // session still loads and the model sees a clear marker that something is
        // off, rather than an opaque API error from sending an invalid base64.
        const placeholder =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        return { ...img, source: { ...img.source, data: placeholder } };
      }
    }),
  );

  return {
    ...entry,
    message: { ...entry.message, outputImages: materializedImages },
  };
}
