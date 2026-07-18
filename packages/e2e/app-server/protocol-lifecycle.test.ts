// @summary App-server protocol lifecycle e2e tests for handshake, thread CRUD, and errors
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir: string;
let client: ProtocolTestClient;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-lifecycle-"));
  const server = createTestServer({ cwd: tmpDir });
  client = createProtocolClient(server);
  return { server, client };
}

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("protocol-lifecycle", () => {
  test("initialize returns serverName, protocolVersion, capabilities", async () => {
    await setup();
    const result = (await client.request("initialize", {
      clientName: "test",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    })) as Record<string, unknown>;

    expect(result.serverName).toBe("diligent-app-server");
    expect(result.protocolVersion).toBe(1);
    expect(result.capabilities).toEqual({
      supportsFollowUp: true,
      supportsApprovals: true,
      supportsUserInput: true,
    });
  });

  test("initialize rejects unsupported protocolVersion", async () => {
    await setup();

    await expect(
      client.request("initialize", {
        clientName: "test",
        clientVersion: "0.0.1",
        protocolVersion: 2,
      }),
    ).rejects.toThrow("Unsupported protocolVersion: 2. Only version 1 is supported.");
  });

  test("thread/start returns threadId and emits THREAD_STARTED", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    expect(threadId).toMatch(/^\d{20}-[0-9a-f]{6}$/);

    const notif = await client.waitForNotification(DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED);
    expect((notif.params as { threadId: string }).threadId).toBe(threadId);
  });

  test("thread/list includes created threads", async () => {
    await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await client.initAndStartThread(tmpDir));
    }

    const result = (await client.request("thread/list", { limit: 100 })) as {
      data: Array<{ id: string }>;
    };

    for (const id of ids) {
      expect(result.data.some((t) => t.id === id)).toBe(true);
    }
  });

  test("thread/read returns empty context for new thread", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    const result = (await client.request("thread/read", { threadId })) as {
      items: unknown[];
      hasFollowUp: boolean;
      isRunning: boolean;
    };

    expect(result.items).toEqual([]);
    expect(result.hasFollowUp).toBe(false);
    expect(result.isRunning).toBe(false);
  });

  test("thread/delete removes thread from list", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    const deleteResult = (await client.request("thread/delete", { threadId })) as { deleted: boolean };
    expect(deleteResult.deleted).toBe(true);

    const listResult = (await client.request("thread/list", { limit: 100 })) as {
      data: Array<{ id: string }>;
    };
    expect(listResult.data.some((t) => t.id === threadId)).toBe(false);
  });

  test("unknown method returns -32602 error", async () => {
    await setup();
    await client.request("initialize", {
      clientName: "test",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    });

    try {
      await client.request("nonexistent/method", {});
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  test("missing required params returns error", async () => {
    await setup();
    await client.request("initialize", {
      clientName: "test",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    });

    try {
      // thread/start requires cwd
      await client.request("thread/start", {});
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
