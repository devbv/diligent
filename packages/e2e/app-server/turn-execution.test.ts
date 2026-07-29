// @summary App-server turn e2e tests for notifications, tools, concurrency, persistence, and context
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import type { Tool } from "@diligent/runtime";
import { z } from "zod";
import { createSimpleStream, createSlowStream, createToolUseStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

const echoTool: Tool = {
  name: "test_tool",
  description: "Echo tool for testing",
  parameters: z.object({ arg: z.string() }),
  async execute(args) {
    return { output: `echo: ${args.arg}` };
  },
};

let tmpDir: string;
let client: ProtocolTestClient;

async function setup(opts?: { streamFunction?: ReturnType<typeof createSimpleStream>; tools?: Tool[] }) {
  tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-turn-"));
  const server = createTestServer({
    cwd: tmpDir,
    streamFunction: opts?.streamFunction,
    tools: opts?.tools,
  });
  client = createProtocolClient(server);
  return { server, client };
}

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("turn-execution", () => {
  test("text turn produces correct notification sequence", async () => {
    await setup({ streamFunction: createSimpleStream("hello world") });
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "say hello");

    // Wait for idle status (arrives after turn/completed in the finally block)
    await client.waitFor(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        (n.params as { status: string }).status === "idle",
    );

    const allNotifs = client.notifications;
    const methods = allNotifs.map((n) => n.method);

    // Expected sequence includes status/turn boundaries and agent/event stream payloads.
    expect(methods).toContain(DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED);
    expect(methods).toContain(DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED);
    expect(methods).toContain(DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT);
    expect(methods).toContain(DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);

    // Verify ordering: status(busy) before turn/started before turn/completed before status(idle)
    const busyIdx = allNotifs.findIndex(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        (n.params as { status: string }).status === "busy",
    );
    const turnStartedIdx = allNotifs.findIndex((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED);
    const turnCompletedIdx = allNotifs.findIndex(
      (n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
    );
    const idleIdx = allNotifs.findIndex(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        (n.params as { status: string }).status === "idle",
    );

    expect(busyIdx).toBeLessThan(turnStartedIdx);
    expect(turnStartedIdx).toBeLessThan(turnCompletedIdx);
    expect(turnCompletedIdx).toBeLessThan(idleIdx);
  });

  test("tool use turn includes tool agent events", async () => {
    const toolStream = createToolUseStream(
      [{ id: "tc-1", name: "test_tool", input: { arg: "value" } }],
      "done after tool",
    );
    await setup({ streamFunction: toolStream, tools: [echoTool] });
    const threadId = await client.initAndStartThread(tmpDir);

    const turnNotifs = await client.sendTurnAndWait(threadId, "use the tool");

    // Should have agent/event with tool_start
    const toolStarted = turnNotifs.find(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        (n.params as { event?: { type?: string } }).event?.type === "tool_start",
    );
    expect(toolStarted).toBeTruthy();

    // Should have agent/event with tool_end
    const toolCompleted = turnNotifs.find(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        (n.params as { event?: { type?: string } }).event?.type === "tool_end",
    );
    expect(toolCompleted).toBeTruthy();
  });

  test("duplicate turn/start while running returns error", async () => {
    await setup({ streamFunction: createSimpleStream("slow response") });
    const threadId = await client.initAndStartThread(tmpDir);

    // Subscribe and start first turn
    await client.request("thread/subscribe", { threadId });
    await client.request("turn/start", { threadId, message: "first" });

    // Try starting another turn immediately — should fail
    try {
      await client.request("turn/start", { threadId, message: "second" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("already running");
    }

    // Wait for first turn to finish
    await client.waitForNotification(DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);
  });

  test("turn/interrupt aborts an active turn and returns the thread to idle", async () => {
    await setup({ streamFunction: createSlowStream("a response that remains active", 20) });
    const threadId = await client.initAndStartThread(tmpDir);

    await client.request("thread/subscribe", { threadId });
    const notificationStart = client.notifications.length;
    await client.request("turn/start", { threadId, message: "start a long response" });
    await client.waitFor(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        (notification.params as { event?: { type?: string } }).event?.type === "message_delta",
    );

    const result = (await client.request("turn/interrupt", { threadId })) as { interrupted: boolean };
    expect(result.interrupted).toBe(true);

    await client.waitFor(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        (notification.params as { threadId?: string; status?: string }).threadId === threadId &&
        (notification.params as { threadId?: string; status?: string }).status === "idle",
    );

    const turnNotifications = client.notifications.slice(notificationStart);
    const interruptedIndex = turnNotifications.findIndex(
      (notification) => notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED,
    );
    const idleIndex = turnNotifications.findIndex(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        (notification.params as { status?: string }).status === "idle",
    );
    expect(interruptedIndex).toBeGreaterThanOrEqual(0);
    expect(interruptedIndex).toBeLessThan(idleIndex);

    const secondResult = (await client.request("turn/interrupt", { threadId })) as { interrupted: boolean };
    expect(secondResult.interrupted).toBe(false);
  });

  test("turn completion persists messages to thread/read", async () => {
    await setup({ streamFunction: createSimpleStream("persisted response") });
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "hello");

    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string }>;
    };

    const itemTypes = result.items.map((item) => item.type);
    expect(itemTypes).toContain("userMessage");
    expect(itemTypes).toContain("agentMessage");
  });

  test("live request and response ids match their persistent thread entries", async () => {
    await setup({ streamFunction: createSimpleStream("persisted response") });
    const threadId = await client.initAndStartThread(tmpDir);

    const notifications = await client.sendTurnAndWait(threadId, "hello");
    const liveEvents = notifications
      .filter((notification) => notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT)
      .map((notification) => (notification.params as { event?: { type?: string; itemId?: string } }).event);
    const liveUserId = liveEvents.find((event) => event?.type === "user_message")?.itemId;
    const liveAssistantId = liveEvents.find((event) => event?.type === "message_end")?.itemId;

    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string; itemId: string }>;
    };
    const persistedUserId = result.items.find((item) => item.type === "userMessage")?.itemId;
    const persistedAssistantId = result.items.find((item) => item.type === "agentMessage")?.itemId;

    expect(liveUserId).toBeDefined();
    expect(liveAssistantId).toBeDefined();
    expect(liveUserId).toBe(persistedUserId);
    expect(liveAssistantId).toBe(persistedAssistantId);
  });

  test("multi-turn accumulates context", async () => {
    await setup({ streamFunction: createSimpleStream("response") });
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "first message");
    await client.sendTurnAndWait(threadId, "second message");

    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string }>;
    };

    const visibleConversationItems = result.items.filter(
      (item) => item.type === "userMessage" || item.type === "agentMessage",
    );
    expect(visibleConversationItems.length).toBeGreaterThanOrEqual(4);
  });
});
