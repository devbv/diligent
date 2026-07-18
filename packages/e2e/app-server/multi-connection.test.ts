// @summary App-server multi-connection e2e tests over the in-memory JSON-RPC peer
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import { createSimpleStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir: string;
const clients: ProtocolTestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("multi-connection", () => {
  test("subscribed peers both receive turn notifications", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-multi-"));
    const server = createTestServer({ cwd: tmpDir, streamFunction: createSimpleStream("fanout") });

    const p1 = createProtocolClient(server);
    const p2 = createProtocolClient(server);
    clients.push(p1, p2);

    // p1 creates thread
    const threadId = await p1.initAndStartThread(tmpDir);

    // Initialize p2
    await p2.request("initialize", {
      clientName: "test-p2",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    });

    // Both subscribe
    await p1.request("thread/subscribe", { threadId });
    await p2.request("thread/subscribe", { threadId });

    // p1 starts a turn
    const turnStartIdx2 = p2.notifications.length;

    await p1.request("turn/start", { threadId, message: "hello from p1" });

    // Wait for turn/completed on both peers
    await p1.waitForNotification(DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);
    await p2.waitForNotification(DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);

    // p2 should also have received turn/started
    const p2TurnStarted = p2.notifications.find(
      (n, i) => i >= turnStartIdx2 && n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED,
    );
    expect(p2TurnStarted).toBeTruthy();

    // p2 should also have received turn/completed
    const p2TurnCompleted = p2.notifications.find(
      (n, i) => i >= turnStartIdx2 && n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
    );
    expect(p2TurnCompleted).toBeTruthy();
  });

  test("unsubscribed peer stops receiving notifications", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-unsub-"));
    const server = createTestServer({ cwd: tmpDir, streamFunction: createSimpleStream("ok") });

    const p1 = createProtocolClient(server);
    const p2 = createProtocolClient(server);
    clients.push(p1, p2);

    const threadId = await p1.initAndStartThread(tmpDir);
    await p2.request("initialize", {
      clientName: "test-p2",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    });

    await p1.request("thread/subscribe", { threadId });
    const subResult = (await p2.request("thread/subscribe", { threadId })) as {
      subscriptionId: string;
    };
    expect(subResult.subscriptionId).toBeTruthy();

    const unsubResult = (await p2.request("thread/unsubscribe", {
      subscriptionId: subResult.subscriptionId,
    })) as { ok: boolean };
    expect(unsubResult.ok).toBe(true);

    // p1 remains subscribed, so notification fanout must not use the
    // no-subscriber fallback that broadcasts to every connection.
    const p2StartIdx = p2.notifications.length;
    await p1.request("turn/start", { threadId, message: "after unsub" });
    await p1.waitFor(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED &&
        (notification.params as { threadId?: string }).threadId === threadId,
    );

    expect(p2.notifications.slice(p2StartIdx)).toEqual([]);
  });

  test("disconnect cleans up without error", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-disconnect-"));
    const server = createTestServer({ cwd: tmpDir, streamFunction: createSimpleStream("ok") });

    const p1 = createProtocolClient(server);
    const p2 = createProtocolClient(server);
    clients.push(p1, p2);

    const threadId = await p1.initAndStartThread(tmpDir);
    await p1.request("thread/subscribe", { threadId });

    // Disconnect p2 — should not throw
    p2.close();

    // p1 should still work fine
    await p1.sendTurnAndWait(threadId, "still works");

    const readResult = (await p1.request("thread/read", { threadId })) as {
      items: Array<{ type: string }>;
    };
    expect(readResult.items.length).toBeGreaterThan(0);
  });
});
