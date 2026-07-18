// @summary App-server e2e tests for modes, effort, and tool availability
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mode, ThinkingEffort } from "@diligent/protocol";
import { createSimpleStream, createToolUseStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir: string;
let client: ProtocolTestClient;
let fakeHome: string | undefined;
let originalHome: string | undefined;

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  originalHome = undefined;
  if (fakeHome) await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
  fakeHome = undefined;
});

describe("mode-and-config", () => {
  test("mode/set switches to plan mode", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-mode-"));
    const server = createTestServer({ cwd: tmpDir, streamFunction: createSimpleStream("ok") });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);

    const result = (await client.request("mode/set", {
      threadId,
      mode: "plan",
    })) as { mode: Mode };

    expect(result.mode).toBe("plan");
  });

  test("effort/set changes effort level", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-effort-"));
    const server = createTestServer({ cwd: tmpDir, streamFunction: createSimpleStream("ok") });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);

    const result = (await client.request("effort/set", {
      threadId,
      effort: "max",
    })) as { effort: ThinkingEffort };

    expect(result.effort).toBe("max");
  });

  test("plan mode is reflected in thread/read after mode/set", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-mode-persist-"));

    const server = createTestServer({
      cwd: tmpDir,
      streamFunction: createSimpleStream("plan response"),
    });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);

    // Set mode to plan
    await client.request("mode/set", { threadId, mode: "plan" });

    // Run a turn — the stream function should receive plan mode via buildAgentConfig
    await client.sendTurnAndWait(threadId, "plan something");

    // Verify the thread read shows the effort/state
    const readResult = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string }>;
      currentMode: Mode;
    };

    expect(readResult.currentMode).toBe("plan");
    expect(readResult.items.some((item) => item.type === "userMessage")).toBe(true);
    expect(readResult.items.some((item) => item.type === "agentMessage")).toBe(true);
  });

  test("effort/set max is reflected in thread/read currentEffort", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-effort-persist-"));
    const server = createTestServer({ cwd: tmpDir, streamFunction: createSimpleStream("ok") });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);

    await client.request("effort/set", { threadId, effort: "max" });

    const readResult = (await client.request("thread/read", { threadId })) as {
      currentEffort: ThinkingEffort;
    };

    expect(readResult.currentEffort).toBe("max");
  });

  test("tools/list and tools/set expose state and changed availability applies on the next turn", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-tools-"));
    fakeHome = await mkdtemp(join(tmpdir(), "diligent-e2e-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    const server = createTestServer({
      cwd: tmpDir,
      runtimeToolsConfig: { builtin: { bash: true } },
      streamFunction: createToolUseStream([{ id: "tc-1", name: "bash", input: { command: "printf hello" } }], "done"),
    });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);

    const listed = (await client.request("tools/list", { threadId })) as {
      appliesOnNextTurn: boolean;
      trustMode: string;
      tools: Array<{ name: string; enabled: boolean }>;
    };
    expect(listed.appliesOnNextTurn).toBe(true);
    expect(listed.trustMode).toBe("full_trust");
    expect(listed.tools.find((tool) => tool.name === "bash")).toMatchObject({ enabled: true });

    const saved = (await client.request("tools/set", {
      threadId,
      builtin: { bash: false },
    })) as {
      tools: Array<{ name: string; enabled: boolean; reason: string }>;
    };
    expect(saved.tools.find((tool) => tool.name === "bash")).toMatchObject({
      enabled: false,
      reason: "disabled_by_user",
    });

    const notifications = await client.sendTurnAndWait(threadId, "use the tool");
    expect(notifications.some((notification) => notification.method === "agent/event")).toBe(true);
    expect(notifications.some((notification) => notification.method === "turn/completed")).toBe(true);

    const readResult = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string; toolName?: string; output?: string; isError?: boolean }>;
    };
    expect(
      readResult.items.some(
        (item) =>
          item.type === "toolCall" &&
          item.toolName === "bash" &&
          item.isError === true &&
          (item.output ?? "").includes('Unknown tool "bash"'),
      ),
    ).toBe(true);
  });
});
