// @summary Tests app-server thread request handlers

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleThreadList, type ThreadHandlersContext } from "@diligent/runtime/app-server/thread-handlers";
import { ensureDiligentDir } from "@diligent/runtime/infrastructure";
import { appendEntry, createSessionFile, generateEntryId, type SessionMessageEntry } from "@diligent/runtime/session";

const TEST_ROOT = join(tmpdir(), `diligent-thread-handlers-test-${Date.now()}`);

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

async function setupDir(): Promise<string> {
  const dir = join(TEST_ROOT, `run-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeUserEntry(): SessionMessageEntry {
  return {
    type: "message",
    id: generateEntryId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello", timestamp: Date.now() },
  };
}

describe("handleThreadList", () => {
  it("dedupes a session reached through real and symlinked cwd entries", async () => {
    const repoDir = await setupDir();
    const aliasDir = join(TEST_ROOT, `alias-${Date.now()}`);
    await symlink(repoDir, aliasDir, "dir");

    const paths = await ensureDiligentDir(repoDir);
    const { header, path } = await createSessionFile(paths.sessions, repoDir);
    await appendEntry(path, makeUserEntry());

    const ctx = {
      knownCwds: new Set([repoDir, aliasDir]),
      resolvePaths: async (cwd: string) => ensureDiligentDir(cwd),
    } as ThreadHandlersContext;

    const result = await handleThreadList(ctx, 100);

    expect(result.data.map((thread) => thread.id)).toEqual([header.id]);
  });
});
