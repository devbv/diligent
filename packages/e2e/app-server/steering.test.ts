// @summary App-server e2e tests for steering injection and pending-steer management

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import { createSlowStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir = "";
let client: ProtocolTestClient;

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  tmpDir = "";
});

describe("steering", () => {
  test("turn/steer injects guidance into an active turn and persists it as a user message", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-steering-"));
    const server = createTestServer({
      cwd: tmpDir,
      streamFunction: createSlowStream("response remains active long enough for steering", 5),
    });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);
    await client.request("thread/subscribe", { threadId });
    const notificationStart = client.notifications.length;
    await client.request("turn/start", { threadId, message: "begin the task" });
    await client.waitFor(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        (notification.params as { event?: { type?: string } }).event?.type === "message_delta",
    );

    const steerResult = (await client.request("turn/steer", {
      threadId,
      steerId: "steer-e2e",
      content: "change approach",
      followUp: false,
    })) as { queued: true; steerId: string };
    expect(steerResult).toEqual({ queued: true, steerId: "steer-e2e" });

    await client.waitFor(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED &&
        (notification.params as { threadId?: string }).threadId === threadId,
      5_000,
    );

    const steeringEvent = client.notifications
      .slice(notificationStart)
      .find(
        (notification) =>
          notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
          (notification.params as { event?: { type?: string } }).event?.type === "steering_injected",
      );
    expect(steeringEvent).toBeDefined();
    expect(
      (steeringEvent?.params as { event?: { steerIds?: string[]; messages?: Array<{ content?: unknown }> } }).event,
    ).toMatchObject({
      steerIds: ["steer-e2e"],
      messages: [{ role: "user", content: "change approach" }],
    });

    const readResult = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string; message?: { content?: unknown } }>;
    };
    expect(
      readResult.items.some((item) => item.type === "userMessage" && item.message?.content === "change approach"),
    ).toBe(true);
  });

  test("pending steering can be updated and cancelled through JSON-RPC", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-steering-queue-"));
    const server = createTestServer({ cwd: tmpDir });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);
    const queued = (await client.request("turn/steer", {
      threadId,
      steerId: "steer-pending",
      content: "original guidance",
      followUp: false,
    })) as { queued: true; steerId: string };
    expect(queued).toEqual({ queued: true, steerId: "steer-pending" });

    const updated = (await client.request("turn/steer/update", {
      threadId,
      steerId: queued.steerId,
      content: "updated guidance",
    })) as { updated: boolean };
    expect(updated.updated).toBe(true);

    const afterUpdate = (await client.request("thread/read", { threadId })) as {
      pendingSteers?: Array<{ id: string; content: string }>;
    };
    expect(afterUpdate.pendingSteers).toEqual([{ id: "steer-pending", content: "updated guidance" }]);

    const cancelled = (await client.request("turn/steer/cancel", {
      threadId,
      steerId: queued.steerId,
    })) as { cancelled: boolean };
    expect(cancelled.cancelled).toBe(true);

    const afterCancel = (await client.request("thread/read", { threadId })) as {
      pendingSteers?: Array<{ id: string; content: string }>;
    };
    expect(afterCancel.pendingSteers).toEqual([]);
  });
});
