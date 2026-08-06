// @summary App-server e2e tests for plugin hook blocking, context, errors, and Stop notification
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import { createSimpleStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

const PLUGIN_NAME = "hook-test-plugin";
const ERROR_HOOK_PLUGIN_NAME = "error-hook-plugin";

let tmpDir: string;
let client: ProtocolTestClient;

async function installPlugin(cwd: string, pluginName: string): Promise<void> {
  const pluginDir = join(cwd, "node_modules", pluginName);
  await mkdir(pluginDir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  const fixtureDir = join(import.meta.dir, "fixtures", pluginName);
  await copyFile(join(fixtureDir, "package.json"), join(pluginDir, "package.json"));
  await copyFile(join(fixtureDir, "index.js"), join(pluginDir, "index.js"));
}

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-hooks-"));
  await installPlugin(tmpDir, PLUGIN_NAME);

  const server = createTestServer({
    cwd: tmpDir,
    streamFunction: createSimpleStream("ok"),
    runtimeToolsConfig: {
      plugins: [{ package: PLUGIN_NAME, enabled: true }],
    },
  });
  client = createProtocolClient(server);
  return { server, client };
}

async function setupWithPlugin(pluginName: string) {
  tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-hooks-"));
  await installPlugin(tmpDir, pluginName);

  const server = createTestServer({
    cwd: tmpDir,
    streamFunction: createSimpleStream("ok"),
    runtimeToolsConfig: {
      plugins: [{ package: pluginName, enabled: true }],
    },
  });
  client = createProtocolClient(server);
  return { server, client };
}

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("plugin-hooks", () => {
  test("UserPromptSubmit hook blocks a prompt and emits error notification", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    // Send a prompt that triggers the blocking hook
    await client.request("thread/subscribe", { threadId });
    const startIndex = client.notifications.length;
    const turnStart = (await client.request("turn/start", {
      threadId,
      message: "BLOCK this prompt please",
    })) as { accepted: true; userMessageId?: string };
    const turnNotifs = client.notifications.slice(startIndex);

    expect(turnStart.userMessageId).toBeUndefined();
    const history = (await client.request("thread/read", { threadId })) as { items: Array<{ type: string }> };
    expect(history.items.some((item) => item.type === "userMessage")).toBe(false);

    // The hook should have blocked the prompt: expect an error notification with HookBlocked
    const errorNotif = turnNotifs.find((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR);
    expect(errorNotif).toBeTruthy();
    const errorParams = errorNotif?.params as { error?: { name?: string; message?: string } } | undefined;
    expect(errorParams?.error?.name).toBe("HookBlocked");
    expect(errorParams?.error?.message).toContain("hook-test-plugin");

    // A TURN_COMPLETED should still arrive (the server completes the turn even when blocked)
    const turnCompleted = turnNotifs.find((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);
    expect(turnCompleted).toBeTruthy();
  });

  test("UserPromptSubmit hook allows a normal prompt and injects additionalContext", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    // Send a normal prompt (not starting with "BLOCK")
    const turnNotifs = await client.sendTurnAndWait(threadId, "hello world");

    // Should not have a HookBlocked error
    const errorNotif = turnNotifs.find((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR);
    expect(errorNotif).toBeUndefined();

    // Turn should complete normally
    const turnCompleted = turnNotifs.find((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);
    expect(turnCompleted).toBeTruthy();
  });

  test("additionalContext from hook is prepended to persisted user message content", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "hello world");

    // The hook injects "hook-test-plugin:UserPromptSubmit" as additionalContext.
    // Verify that thread/read persists the augmented user message content.
    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{
        type: string;
        message?: { content?: string };
      }>;
    };
    const userMessage = result.items.find((item) => item.type === "userMessage");
    expect(userMessage).toBeTruthy();

    const msgContent = userMessage?.message?.content;
    expect(typeof msgContent).toBe("string");
    expect(msgContent).toContain("hook-test-plugin:UserPromptSubmit");
    expect(msgContent).toContain("hello world");
  });

  test("UserPromptSubmit hook that throws is non-blocking — turn completes normally", async () => {
    await setupWithPlugin(ERROR_HOOK_PLUGIN_NAME);
    const threadId = await client.initAndStartThread(tmpDir);

    // The error-hook-plugin always throws in onUserPromptSubmit.
    // The error must be swallowed (non-blocking path) so the turn proceeds.
    const turnNotifs = await client.sendTurnAndWait(threadId, "hello despite error");

    const hookBlockedNotif = turnNotifs.find(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR &&
        (n.params as { error?: { name?: string } }).error?.name === "HookBlocked",
    );
    expect(hookBlockedNotif).toBeUndefined();

    const turnCompleted = turnNotifs.find((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED);
    expect(turnCompleted).toBeTruthy();
  });

  test("Stop hook fires after turn completion and writes marker file", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "hello");

    // Wait briefly for the Stop hook to complete (it runs asynchronously after turn)
    await client.waitFor(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        (n.params as { status: string }).status === "idle",
      3000,
    );

    // The Stop hook should have written a marker file to tmpDir
    const markerPath = join(tmpDir, "hook-stop-fired");
    await expect(access(markerPath)).resolves.toBeNull();

    const markerContent = JSON.parse(await readFile(markerPath, "utf8")) as { hook_event_name?: string };
    expect(markerContent.hook_event_name).toBe("Stop");
  });
});
