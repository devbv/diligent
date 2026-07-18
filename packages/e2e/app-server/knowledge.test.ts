// @summary App-server e2e tests for knowledge CRUD and filesystem persistence

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDiligentDir } from "@diligent/runtime";
import { readKnowledge } from "@diligent/runtime/knowledge";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir = "";
let client: ProtocolTestClient;

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  tmpDir = "";
});

describe("knowledge", () => {
  test("knowledge entries can be added, updated, listed, deleted, and persisted through JSON-RPC", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-knowledge-"));
    const server = createTestServer({ cwd: tmpDir });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);
    const added = (await client.request("knowledge/update", {
      action: "upsert",
      threadId,
      type: "pattern",
      content: "Use focused tests before the full suite",
      tags: ["tests"],
    })) as {
      entry: { id: string; type: string; content: string; confidence: number };
    };
    expect(added.entry).toMatchObject({
      type: "pattern",
      content: "Use focused tests before the full suite",
      confidence: 0.8,
    });

    const updated = (await client.request("knowledge/update", {
      action: "upsert",
      threadId,
      id: added.entry.id,
      type: "backlog",
      content: "Run focused tests before the full suite",
      tags: ["tests", "workflow"],
    })) as {
      entry: { id: string; type: string; content: string };
    };
    expect(updated.entry).toMatchObject({
      id: added.entry.id,
      type: "backlog",
      content: "Run focused tests before the full suite",
    });

    const listed = (await client.request("knowledge/list", { threadId, limit: 10 })) as {
      data: Array<{ id: string; type: string }>;
    };
    expect(listed.data).toContainEqual(expect.objectContaining({ id: added.entry.id, type: "backlog" }));

    const deleted = (await client.request("knowledge/update", {
      action: "delete",
      threadId,
      id: added.entry.id,
    })) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    const paths = await ensureDiligentDir(tmpDir);
    const persisted = await readKnowledge(paths.knowledge);
    expect(persisted.some((entry) => entry.id === added.entry.id)).toBe(false);
  });
});
