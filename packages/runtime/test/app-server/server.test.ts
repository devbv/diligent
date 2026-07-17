// @summary Tests for DiligentAppServer JSON-RPC request handling and event notifications

import { describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream } from "@diligent/core/event-stream";
import { resolveModel } from "@diligent/core/model-registry";
import { type Model, ProviderError, ProviderManager, type StreamFunction } from "@diligent/core/provider-contract";
import type {
  DiligentServerNotification,
  DiligentServerRequest,
  DiligentServerRequestResponse,
  JSONRPCMessage,
  ThinkingEffort,
} from "@diligent/protocol";

import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_SERVER_REQUEST_METHODS,
  type JSONRPCResponse,
} from "@diligent/protocol";
import {
  type AgentOptions,
  createCollabTools,
  createPermissionEngine,
  createRequestUserInputTool,
  createYoloPermissionEngine,
  getBuiltinAgentDefinitions,
  loadAuthStore,
  RuntimeAgent,
  saveOAuthTokens,
} from "@diligent/runtime";
import { createAppServerConfig, DiligentAppServer } from "@diligent/runtime/app-server";
import { handleImageUpload } from "@diligent/runtime/app-server/config-handlers";
import { ensureDiligentDir } from "@diligent/runtime/infrastructure";
import { SessionWriter } from "@diligent/runtime/session";
import { z } from "zod";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

function readResult(response: JSONRPCResponse): unknown {
  if ("error" in response) {
    throw new Error(response.error.message);
  }
  return response.result;
}

const FAKE_MODEL = {
  id: "fake-model" as const,
  provider: "fake" as const,
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  supportsThinking: false as const,
};

function fakeConfig(fn: StreamFunction): AgentOptions {
  return { llmMsgStreamFn: fn };
}

const TEST_CONNECTION_ID = "test";

setDefaultTimeout(5_000);

interface TestPeer {
  send(message: JSONRPCMessage): void;
  onMessage(listener: (message: JSONRPCMessage) => void | Promise<void>): void;
  onClose?(listener: (error?: Error) => void): void;
}

interface ConnectedTestServer {
  peer: TestPeer;
  notifications: DiligentServerNotification[];
  setNotificationListener: (
    listener: ((notification: DiligentServerNotification) => void | Promise<void>) | null,
  ) => void;
  setServerRequestHandler: (
    handler: ((request: DiligentServerRequest) => Promise<DiligentServerRequestResponse>) | null,
  ) => void;
  disconnect: () => void;
}

function connectTestPeer(server: DiligentAppServer, connectionId = TEST_CONNECTION_ID): ConnectedTestServer {
  const notifications: DiligentServerNotification[] = [];
  let notificationListener: ((notification: DiligentServerNotification) => void | Promise<void>) | null = null;
  let serverRequestHandler: ((request: DiligentServerRequest) => Promise<DiligentServerRequestResponse>) | null = null;
  let serverMessageListener: ((message: JSONRPCMessage) => void | Promise<void>) | null = null;

  const peer: TestPeer = {
    async send(message: JSONRPCMessage) {
      if (!("method" in message)) return;
      if (!("id" in message)) {
        const notification = message as DiligentServerNotification;
        notifications.push(notification);
        await notificationListener?.(notification);
        return;
      }
      if (typeof message.id !== "number") return;

      const request = {
        method: message.method as DiligentServerRequest["method"],
        params: message.params,
      } as DiligentServerRequest;

      const response = serverRequestHandler
        ? await serverRequestHandler(request)
        : defaultServerRequestResponse(message.method);
      await serverMessageListener?.({ id: message.id, result: response.result });
    },
    onMessage(listener) {
      serverMessageListener = listener;
    },
  };

  const disconnect = server.connect(connectionId, peer);

  return {
    peer,
    notifications,
    setNotificationListener(listener) {
      notificationListener = listener;
    },
    setServerRequestHandler(handler) {
      serverRequestHandler = handler;
    },
    disconnect,
  };
}

function defaultServerRequestResponse(method: DiligentServerRequest["method"]): DiligentServerRequestResponse {
  if (method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
    return {
      method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
      result: { decision: "once" },
    };
  }

  return {
    method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
    result: { answers: {} },
  };
}

function makeFactoryRuntimeConfig(overrides?: {
  tools?: Record<string, unknown>;
  effort?: ThinkingEffort;
  modelId?: string;
}) {
  const providerManager = new ProviderManager({});
  providerManager.setApiKey("anthropic", "test-key");
  providerManager.setApiKey("openai", "test-key");
  const model: Model =
    overrides?.modelId && overrides.modelId !== "gpt-5.6-terra"
      ? resolveModel(overrides.modelId)
      : overrides?.modelId === "gpt-5.6-terra"
        ? {
            id: "gpt-5.6-terra",
            provider: "openai",
            contextWindow: 400_000,
            maxOutputTokens: 128_000,
            supportsThinking: true,
          }
        : {
            id: TEST_ANTHROPIC_MODEL_ID,
            provider: "anthropic",
            contextWindow: 200_000,
            maxOutputTokens: 128_000,
            supportsThinking: true,
          };

  return {
    model,
    mode: "default" as const,
    effort: overrides?.effort ?? ("medium" as const),
    systemPrompt: [{ label: "base", content: "test" }],
    streamFunction: () => {
      const stream = new EventStream(
        (event) => event.type === "done",
        (event) => ({ message: (event as { message: unknown }).message }),
      );
      queueMicrotask(() => {
        stream.push({ type: "start" });
        stream.push({
          type: "done",
          stopReason: "end_turn",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: model.id,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "end_turn",
            timestamp: Date.now(),
          },
        });
      });
      return stream as never;
    },
    diligent: {
      ...(overrides?.tools ? { tools: overrides.tools as never } : {}),
    },
    sources: [],
    skills: [],
    compaction: {
      enabled: true,
      reservePercent: 16,
      keepRecentTokens: 20000,
    },
    permissionEngine: createPermissionEngine([]),
    providerManager,
  };
}

describe("DiligentAppServer", () => {
  it("passes ChatGPT provider plan type to Stop plugin hooks", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-plan-type-"));
    const capturePath = join(projectRoot, "stop-input.json");
    const pluginRoot = join(projectRoot, "node_modules", "@test", "plan-hook");
    const authStore = { path: join(projectRoot, "auth.jsonc"), mode: "file" as const };

    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await writeFile(
      join(pluginRoot, "index.js"),
      `export async function onStop(input) {
  await Bun.write(process.env.TEST_STOP_INPUT_PATH, JSON.stringify(input));
  return {};
}
`,
    );
    await saveOAuthTokens(
      {
        access_token: "at-test",
        refresh_token: "rt-test",
        id_token: "it-test",
        expires_at: Date.now() + 60_000,
        account_info: { chatgpt_plan_type: "pro" },
      },
      authStore,
    );

    const originalCapturePath = process.env.TEST_STOP_INPUT_PATH;
    process.env.TEST_STOP_INPUT_PATH = capturePath;

    try {
      const server = new DiligentAppServer({
        resolvePaths: (cwd) => ensureDiligentDir(cwd),
        createAgent: () => {
          throw new Error("not used");
        },
        toolConfig: {
          getTools: () => ({ plugins: [{ package: "@test/plan-hook" }] }),
          setTools: () => {},
        },
        authStore,
      });

      await (
        server as unknown as {
          runStopHooksFor(info: {
            sessionId: string;
            sessionPath: string;
            cwd: string;
            model: string;
            provider?: string;
            effort: "medium";
            userId?: string;
            context: Array<Record<string, unknown>>;
            isRerun: boolean;
          }): Promise<void>;
        }
      ).runStopHooksFor({
        sessionId: "session-1",
        sessionPath: join(projectRoot, "session.jsonl"),
        cwd: projectRoot,
        model: "chatgpt-5.1-codex-max",
        provider: "chatgpt",
        effort: "medium",
        userId: "user-1",
        context: [
          {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "chatgpt-5.1-codex-max",
            usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "end_turn",
            timestamp: Date.now(),
          },
        ],
        isRerun: false,
      });

      const input = JSON.parse(await readFile(capturePath, "utf-8")) as { provider_plan_type?: string };
      expect(input.provider_plan_type).toBe("pro");
    } finally {
      if (originalCapturePath === undefined) {
        delete process.env.TEST_STOP_INPUT_PATH;
      } else {
        process.env.TEST_STOP_INPUT_PATH = originalCapturePath;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("handles initialize/thread/start/turn/start and emits codex-like notifications", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      getInitializeResult: async () => ({
        cwd: projectRoot,
        mode: "default",
        effort: "medium",
        currentModel: "fake-model",
        availableModels: [],
      }),
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({ type: "text_delta", delta: "hello" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "hello" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);
    const notifications: DiligentServerNotification[] = [];
    let resolveTurnCompleted: (() => void) | null = null;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });

    connection.setNotificationListener((notification) => {
      notifications.push(notification);
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        resolveTurnCompleted?.();
      }
    });

    const init = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1,
      method: "initialize",
      params: { clientName: "tui", clientVersion: "0.0.1", protocolVersion: 1 },
    });
    const initResult = readResult(init) as {
      protocolVersion: number;
      cwd?: string;
      mode?: string;
      effort?: string;
      currentModel?: string;
    };
    expect(initResult.protocolVersion).toBe(1);
    expect(initResult.cwd).toBe(projectRoot);
    expect(initResult.mode).toBe("default");
    expect(initResult.effort).toBe("medium");
    expect(initResult.currentModel).toBe("fake-model");

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 2,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const startResult = readResult(start) as { threadId: string };
    // sessionId format: YYYYMMDDHHMMSSSSSCCC-xxxxxx (timestamp + counter + 6-char random)
    expect(startResult.threadId).toMatch(/^\d{20}-[0-9a-f]{6}$/);

    const turnStart = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 3,
      method: "turn/start",
      params: { threadId: startResult.threadId, message: "hi" },
    });
    const turnStartResult = readResult(turnStart) as { accepted: boolean };
    expect(turnStartResult.accepted).toBe(true);

    await turnCompleted;

    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED)).toBe(true);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED)).toBe(true);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT)).toBe(true);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_STARTED)).toBe(false);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_DELTA)).toBe(false);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_COMPLETED)).toBe(false);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED)).toBe(true);
  });

  it("accepts image-only turn content and emits userMessage item", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server, "observer");

    const notifications: DiligentServerNotification[] = [];
    let resolveTurnCompleted: (() => void) | null = null;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });

    connection.setNotificationListener((notification) => {
      notifications.push(notification);
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        resolveTurnCompleted?.();
      }
    });

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 100,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const startResult = readResult(start) as { threadId: string };

    const turnStart = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 101,
      method: "turn/start",
      params: {
        threadId: startResult.threadId,
        message: "",
        attachments: [
          {
            type: "local_image",
            path: "/tmp/example.png",
            mediaType: "image/png",
            fileName: "example.png",
          },
        ],
      },
    });
    expect((readResult(turnStart) as { accepted: boolean }).accepted).toBe(true);

    await turnCompleted;

    const userEvent = notifications.find(
      (n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT && n.params.event.type === "user_message",
    );
    expect(userEvent).toBeDefined();
    const message = (userEvent as { params: { event: { message: { content: unknown } } } }).params.event.message;
    expect(message.content).toEqual([
      {
        type: "local_image",
        path: "/tmp/example.png",
        mediaType: "image/png",
        fileName: "example.png",
      },
    ]);
  });

  it("keeps user-message echo suppression while routing structured context notices to the initiator", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
          loopHooks: [
            {
              id: "presented-context",
              beforeTurn({ messages }) {
                const latest = messages.at(-1);
                if (latest?.role !== "user" || latest.content !== "move it up") return;
                return [
                  {
                    source: "studiorpc-human-edits",
                    content: "Added: Ramp",
                    metadata: {
                      presentation: {
                        kind: "human-edits",
                        title: "Human edits detected",
                        content: "Added: Ramp",
                      },
                    },
                  },
                ];
              },
            },
          ],
        }),
    });

    const initiator = connectTestPeer(server, "initiator");
    const observer = connectTestPeer(server, "observer");

    const runTurn = async (id: number, threadId: string, message: string): Promise<void> => {
      // Wait for idle (emitted after turn-state cleanup) so a follow-up
      // turn/start on the same thread is not rejected as already running.
      const turnCompleted = new Promise<void>((resolve) => {
        initiator.setNotificationListener((notification) => {
          if (
            notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
            (notification.params as { status?: string }).status === "idle"
          ) {
            resolve();
          }
        });
      });
      const turnStart = await server.handleRequest("initiator", {
        id,
        method: "turn/start",
        params: { threadId, message },
      });
      expect((readResult(turnStart) as { accepted: boolean }).accepted).toBe(true);
      await turnCompleted;
    };

    const isUserMessage = (n: DiligentServerNotification) =>
      n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
      (n.params as { event?: { type?: string } }).event?.type === "user_message";
    const isContextNotice = (n: DiligentServerNotification) =>
      n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
      (n.params as { event?: { type?: string } }).event?.type === "context_notice";

    const start = await server.handleRequest("initiator", {
      id: 200,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const { threadId } = readResult(start) as { threadId: string };

    await runTurn(201, threadId, "plain message");
    expect(initiator.notifications.some(isUserMessage)).toBe(false); // echo skipped for initiator
    expect(observer.notifications.some(isUserMessage)).toBe(true); // other clients still receive it

    initiator.notifications.length = 0;
    await runTurn(202, threadId, "move it up");
    expect(initiator.notifications.some(isUserMessage)).toBe(false);
    expect(initiator.notifications.some(isContextNotice)).toBe(true);
    expect(observer.notifications.some(isContextNotice)).toBe(true);
  });

  it("restores thread effort from resumed sessions and uses it for new threads", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ effort }) =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort,
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 120,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const originalThreadId = (readResult(started) as { threadId: string }).threadId;

    const initialRead = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 121,
      method: "thread/read",
      params: { threadId: originalThreadId },
    });
    expect((readResult(initialRead) as { currentEffort: string }).currentEffort).toBe("medium");

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 122,
      method: "effort/set",
      params: { threadId: originalThreadId, effort: "max" },
    });

    let resolveTurnCompleted: (() => void) | null = null;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    connection.setNotificationListener((notification) => {
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        resolveTurnCompleted?.();
      }
    });

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 123,
      method: "turn/start",
      params: { threadId: originalThreadId, message: "remember this effort" },
    });
    await turnCompleted;

    const resumedServer = new DiligentAppServer({
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      cwd: projectRoot,
      createAgent: ({ effort }) =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort,
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          }),
        }),
    });

    const resumed = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 124,
      method: "thread/resume",
      params: { threadId: originalThreadId },
    });
    expect((readResult(resumed) as { found: boolean }).found).toBe(true);

    const resumedRead = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 125,
      method: "thread/read",
      params: { threadId: originalThreadId },
    });
    expect((readResult(resumedRead) as { currentEffort: string }).currentEffort).toBe("max");

    const newThread = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 126,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const newThreadId = (readResult(newThread) as { threadId: string }).threadId;
    const newThreadRead = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 127,
      method: "thread/read",
      params: { threadId: newThreadId },
    });
    expect((readResult(newThreadRead) as { currentEffort: string }).currentEffort).toBe("max");
  });

  it("keeps model changes thread-scoped and restores them on resume", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig(),
      }),
    );

    connectTestPeer(server);

    const startedA = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 600,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadA = (readResult(startedA) as { threadId: string }).threadId;

    const startedB = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 601,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadB = (readResult(startedB) as { threadId: string }).threadId;

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 602,
      method: "config/set",
      params: { threadId: threadA, model: "gpt-5.6-terra" },
    });

    const readA = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 603,
      method: "thread/read",
      params: { threadId: threadA },
    });
    expect((readResult(readA) as { currentModel?: string }).currentModel).toBe("gpt-5.6-terra");

    const readB = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 604,
      method: "thread/read",
      params: { threadId: threadB },
    });
    expect((readResult(readB) as { currentModel?: string }).currentModel).toBe(TEST_ANTHROPIC_MODEL_ID);

    const resumedServer = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig(),
      }),
    );
    connectTestPeer(resumedServer);

    const resumed = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 605,
      method: "thread/resume",
      params: { threadId: threadA },
    });
    expect((readResult(resumed) as { found: boolean }).found).toBe(true);

    const resumedRead = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 606,
      method: "thread/read",
      params: { threadId: threadA },
    });
    expect((readResult(resumedRead) as { currentModel?: string }).currentModel).toBe("gpt-5.6-terra");

    const newThread = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 607,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const newThreadId = (readResult(newThread) as { threadId: string }).threadId;

    const newThreadRead = await resumedServer.handleRequest(TEST_CONNECTION_ID, {
      id: 608,
      method: "thread/read",
      params: { threadId: newThreadId },
    });
    expect((readResult(newThreadRead) as { currentModel?: string }).currentModel).toBe("gpt-5.6-terra");
  });

  it("config/reload re-discovers skills and forces the next turn to rebuild its agent", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-app-server-reload-home-"));
    process.env.HOME = fakeHome;
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-reload-"));

    try {
      const server = new DiligentAppServer(
        createAppServerConfig({
          cwd: projectRoot,
          runtimeConfig: makeFactoryRuntimeConfig(),
        }),
      );
      connectTestPeer(server);

      const started = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 700,
        method: "thread/start",
        params: { cwd: projectRoot },
      });
      const threadId = (readResult(started) as { threadId: string }).threadId;

      // Drive one turn so the thread caches a built agent instance.
      await server.handleRequest(TEST_CONNECTION_ID, {
        id: 701,
        method: "turn/start",
        params: { threadId, message: "hi", content: [{ type: "text", text: "hi" }] },
      });

      const skillDir = join(projectRoot, ".diligent", "skills", "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        ["---", "name: my-skill", "description: Discovered on reload", "---", "", "Do the thing."].join("\n"),
      );

      const reloaded = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 702,
        method: "config/reload",
        params: {},
      });
      expect(readResult(reloaded)).toEqual({ skills: [{ name: "my-skill", description: "Discovered on reload" }] });
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("does not keep a failed Anthropic key path active after disconnecting it", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const paths = await ensureDiligentDir(projectRoot);
    const authStore = { path: join(projectRoot, "auth.jsonc"), mode: "file" as const };
    const providerManager = new ProviderManager({});
    providerManager.setApiKey("openai", "valid-openai-key");

    const server = new DiligentAppServer({
      cwd: projectRoot,
      defaultEffort: "medium",
      providerManager,
      authStore,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ modelId }) => {
        return new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            if (modelId.startsWith("claude") && providerManager.getApiKey("anthropic") !== "valid-anthropic-key") {
              throw new Error("invalid Anthropic key");
            }
            if (modelId.startsWith("gpt") && !providerManager.hasKeyFor("openai")) {
              throw new Error("missing OpenAI key");
            }
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: modelId }],
                  model: modelId,
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          }),
        });
      },
    });

    const connection = connectTestPeer(server);
    let resolveTurnOutcome: ((outcome: "completed" | "error") => void) | null = null;
    connection.setNotificationListener((notification) => {
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        resolveTurnOutcome?.("completed");
        resolveTurnOutcome = null;
      }
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR) {
        resolveTurnOutcome?.("error");
        resolveTurnOutcome = null;
      }
    });
    const waitForTurnOutcome = () =>
      new Promise<"completed" | "error">((resolve) => {
        resolveTurnOutcome = resolve;
      });

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 609,
      method: "auth/set",
      params: { provider: "anthropic", apiKey: "invalid-anthropic-key" },
    });

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 610,
      method: "thread/start",
      params: { cwd: projectRoot, model: TEST_ANTHROPIC_MODEL_ID },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const firstOutcome = waitForTurnOutcome();
    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 611,
      method: "turn/start",
      params: { threadId, message: "first" },
    });
    expect(await firstOutcome).toBe("completed");

    const firstRead = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 612,
      method: "thread/read",
      params: { threadId },
    });
    const firstThread = readResult(firstRead) as {
      errors?: Array<{ error: { message: string } }>;
    };
    expect(firstThread.errors?.at(-1)?.error.message).toContain("invalid Anthropic key");

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 613,
      method: "auth/remove",
      params: { provider: "anthropic" },
    });

    expect(providerManager.hasKeyFor("anthropic")).toBe(false);
    expect((await loadAuthStore(authStore)).anthropic).toBeUndefined();

    const secondOutcome = waitForTurnOutcome();
    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 614,
      method: "turn/start",
      params: { threadId, message: "second", model: "gpt-5.6-terra" },
    });
    expect(await secondOutcome).toBe("completed");

    const secondRead = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 615,
      method: "thread/read",
      params: { threadId },
    });
    const secondThread = readResult(secondRead) as {
      errors?: Array<{ error: { message: string } }>;
      items?: Array<{ type: string }>;
    };
    expect(secondThread.errors ?? []).toHaveLength(1);
    expect(secondThread.items?.some((item) => item.type === "agentMessage")).toBe(true);
    expect(secondThread.items?.every((item) => item.type !== "error")).toBe(true);

    const fileText = await readFile(join(paths.sessions, `${threadId}.jsonl`), "utf8");
    const entries = fileText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      type: string;
      message?: { role?: string; model?: string };
    }>;
    const assistantModels = entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
      .map((entry) => entry.message?.model);

    expect(assistantModels).toEqual(["gpt-5.6-terra"]);
  });

  it("uses runtime config default effort for new threads", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ effort: "high" }),
      }),
    );

    connectTestPeer(server);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1500,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1501,
      method: "thread/read",
      params: { threadId },
    });

    expect((readResult(read) as { currentEffort: string }).currentEffort).toBe("high");
  });

  it("uses explicit thread/start effort for new threads", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ effort: "medium" }),
      }),
    );

    connectTestPeer(server);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1502,
      method: "thread/start",
      params: { cwd: projectRoot, effort: "high" },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1503,
      method: "thread/read",
      params: { threadId },
    });

    expect((readResult(read) as { currentEffort: string }).currentEffort).toBe("high");
  });

  it("rejects minimal effort for models without none support", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig(),
      }),
    );

    connectTestPeer(server);
    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1510,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    await expect(
      server.handleRequest(TEST_CONNECTION_ID, {
        id: 1511,
        method: "effort/set",
        params: { threadId, effort: "none" },
      }),
    ).resolves.toMatchObject({ error: { message: "Minimal thinking is not supported for this model." } });
  });

  it("accepts and restores xhigh effort for GPT-5.6", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ modelId: "gpt-5.6-sol" }),
      }),
    );

    connectTestPeer(server);
    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1520,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const changed = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1521,
      method: "effort/set",
      params: { threadId, effort: "xhigh" },
    });
    expect(readResult(changed)).toEqual({ effort: "xhigh" });

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1522,
      method: "thread/read",
      params: { threadId },
    });
    expect((readResult(read) as { currentEffort: string }).currentEffort).toBe("xhigh");
  });

  it("accepts xhigh effort for GPT-5.5", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ modelId: "gpt-5.5" }),
      }),
    );

    connectTestPeer(server);
    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1530,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const changed = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1531,
      method: "effort/set",
      params: { threadId, effort: "xhigh" },
    });
    expect(readResult(changed)).toEqual({ effort: "xhigh" });
  });

  it("preserves existing effort/set behavior for non-thinking models", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ modelId: "vertex-gemma-4-26b-it" }),
      }),
    );

    connectTestPeer(server);
    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1532,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const changed = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1533,
      method: "effort/set",
      params: { threadId, effort: "high" },
    });

    expect(readResult(changed)).toEqual({ effort: "high" });
  });

  it("preserves xhigh when switching between OpenAI models", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ modelId: "gpt-5.6-sol" }),
      }),
    );

    connectTestPeer(server);
    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1540,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;
    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1541,
      method: "effort/set",
      params: { threadId, effort: "xhigh" },
    });
    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1542,
      method: "config/set",
      params: { threadId, model: "gpt-5.5" },
    });

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1543,
      method: "thread/read",
      params: { threadId },
    });
    expect((readResult(read) as { currentEffort: string }).currentEffort).toBe("xhigh");
  });

  it("rejects none effort for OpenAI models", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({
        cwd: projectRoot,
        runtimeConfig: makeFactoryRuntimeConfig({ modelId: "gpt-5.6-terra" }),
      }),
    );

    connectTestPeer(server);
    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1512,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    await expect(
      server.handleRequest(TEST_CONNECTION_ID, {
        id: 1513,
        method: "effort/set",
        params: { threadId, effort: "none" },
      }),
    ).resolves.toMatchObject({ error: { message: "Minimal thinking is not supported for this model." } });
  });

  it("lists a newly started thread before the first turn", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          }),
        }),
    });

    connectTestPeer(server);

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 110,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(start) as { threadId: string }).threadId;

    const list = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 111,
      method: "thread/list",
      params: { limit: 10 },
    });
    const result = readResult(list) as { data: Array<{ id: string; messageCount: number }> };
    expect(result.data.find((item) => item.id === threadId)).toMatchObject({ id: threadId, messageCount: 0 });
  });

  it("reconciles idle thread/read from disk when runtime memory is stale", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "original" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);
    let resolveTurnCompleted: (() => void) | null = null;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    connection.setNotificationListener((notification) => {
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        resolveTurnCompleted?.();
      }
    });

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 901,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(start) as { threadId: string }).threadId;

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 902,
      method: "turn/start",
      params: { threadId, message: "hello" },
    });
    await turnCompleted;

    const paths = await ensureDiligentDir(projectRoot);
    const sessionPath = join(paths.sessions, `${threadId}.jsonl`);
    const fileText = await readFile(sessionPath, "utf8");
    const lines = fileText.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as {
      type: string;
      message?: {
        role?: string;
        content?: unknown[];
        model?: string;
        usage?: unknown;
        stopReason?: string;
        timestamp?: number;
      };
      timestamp?: string;
      id?: string;
      parentId?: string | null;
    };
    expect(last.type).toBe("message");
    expect(last.message?.role).toBe("assistant");

    const appendedEntry = {
      type: "message",
      id: "deadbeef",
      parentId: last.id ?? null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "from-disk" }],
        model: last.message?.model ?? "fake-model",
        usage: last.message?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: last.message?.stopReason ?? "end_turn",
        timestamp: Date.now(),
      },
    };

    await writeFile(sessionPath, `${fileText}${JSON.stringify(appendedEntry)}\n`, "utf8");

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 903,
      method: "thread/read",
      params: { threadId },
    });
    const result = readResult(read) as {
      items: Array<{ type: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } }>;
    };
    const assistantItems = result.items.filter((item) => item.type === "agentMessage");
    const lastAssistant = assistantItems[assistantItems.length - 1];
    expect(lastAssistant?.message?.role).toBe("assistant");
    expect(lastAssistant?.message?.content?.find((b) => b.type === "text")?.text).toBe("from-disk");

    // Also validate equal-count/equal-leaf fingerprints are present and stable on next read.
    const secondRead = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 904,
      method: "thread/read",
      params: { threadId },
    });
    const second = readResult(secondRead) as {
      items: Array<{ type: string; message?: { content?: Array<{ type: string; text?: string }> } }>;
    };
    const secondAssistantItems = second.items.filter((item) => item.type === "agentMessage");
    const secondLastAssistant = secondAssistantItems[secondAssistantItems.length - 1];
    expect(secondLastAssistant?.message?.content?.find((b) => b.type === "text")?.text).toBe("from-disk");
  });

  it("thread/read includes snapshot items with tool input/output/render", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({ cwd: projectRoot, runtimeConfig: makeFactoryRuntimeConfig() }),
    );

    connectTestPeer(server);

    const paths = await ensureDiligentDir(projectRoot);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1901,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const now = new Date();
    const ts = now.toISOString();
    const timestamp = now.getTime();
    const sessionPath = join(paths.sessions, `${threadId}.jsonl`);
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: "read readme", timestamp },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc-read-1", name: "read", input: { file_path: "README.md" } }],
          model: "fake-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp,
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: ts,
        message: {
          role: "tool_result",
          toolCallId: "tc-read-1",
          toolName: "read",
          output: "# README",
          isError: false,
          timestamp,
          render: { outputSummary: "Read README.md", blocks: [{ type: "summary", text: "ok" }] },
        },
      },
    ];
    const existing = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, `${existing}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1903,
      method: "thread/read",
      params: { threadId },
    });

    const result = readResult(read) as {
      items: Array<{
        type: string;
        itemId: string;
        toolCallId?: string;
        input?: unknown;
        output?: string;
        render?: { version: number };
      }>;
    };

    const toolItems = result.items.filter((item) => item.type === "toolCall" && item.toolCallId === "tc-read-1");
    expect(toolItems.length).toBe(2);
    expect(toolItems[0]?.input).toMatchObject({ file_path: "README.md" });
    const completed = toolItems.find((item) => item.output === "# README");
    expect(completed?.output).toBe("# README");
    expect(completed?.render).toMatchObject({ outputSummary: "Read README.md" });
  });

  it("thread/read preserves bash start render and command result render", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({ cwd: projectRoot, runtimeConfig: makeFactoryRuntimeConfig() }),
    );

    connectTestPeer(server);

    const paths = await ensureDiligentDir(projectRoot);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1911,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const now = new Date();
    const ts = now.toISOString();
    const timestamp = now.getTime();
    const sessionPath = join(paths.sessions, `${threadId}.jsonl`);
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: "run pwd", timestamp },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc-bash-1", name: "bash", input: { command: "pwd" } }],
          model: "fake-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp,
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: ts,
        message: {
          role: "tool_result",
          toolCallId: "tc-bash-1",
          toolName: "bash",
          output: "/tmp/project",
          isError: false,
          timestamp,
          render: {
            inputSummary: "pwd",
            outputSummary: "Command completed",
            blocks: [{ type: "command", command: "pwd", output: "/tmp/project", isError: false }],
          },
        },
      },
    ];
    const existing = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, `${existing}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1913,
      method: "thread/read",
      params: { threadId },
    });

    const result = readResult(read) as {
      items: Array<{
        type: string;
        toolCallId?: string;
        output?: string;
        render?: {
          inputSummary?: string;
          outputSummary?: string;
          blocks?: Array<{ type: string; command?: string; output?: string; isError?: boolean }>;
        };
      }>;
    };

    const toolItems = result.items.filter((item) => item.type === "toolCall" && item.toolCallId === "tc-bash-1");
    expect(toolItems.length).toBe(2);

    const startedItem = toolItems.find((item) => item.output === undefined);
    expect(startedItem?.render).toMatchObject({
      inputSummary: "pwd",
    });
    expect(startedItem?.startedAt).toBe(timestamp);

    const completedItem = toolItems.find((item) => item.output === "/tmp/project");
    expect(completedItem?.render).toMatchObject({
      inputSummary: "pwd",
      outputSummary: "Command completed",
    });
    expect(completedItem?.durationMs).toBe(0);
    expect(completedItem?.render?.blocks?.[0]).toMatchObject({
      type: "command",
      command: "pwd",
      output: "/tmp/project",
      isError: false,
    });
  });

  it("thread/read includes inputSummary for error tool results", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({ cwd: projectRoot, runtimeConfig: makeFactoryRuntimeConfig() }),
    );

    connectTestPeer(server);

    const paths = await ensureDiligentDir(projectRoot);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 2915,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const timestamp = 1_700_000_000_000;
    const ts = new Date(timestamp).toISOString();
    const sessionPath = join(paths.sessions, `${threadId}.jsonl`);
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: "run bad command", timestamp },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc-bash-err-1", name: "bash", input: { command: "badcmd" } }],
          model: "fake-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp,
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: ts,
        message: {
          role: "tool_result",
          toolCallId: "tc-bash-err-1",
          toolName: "bash",
          output: "[Exit code: 127]",
          isError: true,
          timestamp,
        },
      },
    ];
    const existing = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, `${existing}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 2916,
      method: "thread/read",
      params: { threadId },
    });

    const result = readResult(read) as {
      items: Array<{
        type: string;
        toolCallId?: string;
        output?: string;
        render?: {
          inputSummary?: string;
          outputSummary?: string;
        };
      }>;
    };

    const completedItem = result.items.find(
      (item) => item.type === "toolCall" && item.toolCallId === "tc-bash-err-1" && item.output === "[Exit code: 127]",
    );
    expect(completedItem?.render).toMatchObject({
      inputSummary: "badcmd",
      outputSummary: "Command failed (exit 127)",
    });
  });

  it("thread/read merges request and response summaries for resumed tool results", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({ cwd: projectRoot, runtimeConfig: makeFactoryRuntimeConfig() }),
    );

    connectTestPeer(server);

    const paths = await ensureDiligentDir(projectRoot);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 3915,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const base = Date.now();
    const sessionPath = join(paths.sessions, `${threadId}.jsonl`);
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date(base).toISOString(),
        message: { role: "user", content: "read missing", timestamp: base },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: new Date(base + 1).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc-read-resume-1", name: "read", input: { file_path: "README.md" } }],
          model: "fake-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp: base + 1,
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: new Date(base + 2).toISOString(),
        message: {
          role: "tool_result",
          toolCallId: "tc-read-resume-1",
          toolName: "read",
          output: "Error: ENOENT",
          isError: true,
          timestamp: base + 2,
          render: { outputSummary: "Read failed", blocks: [] },
        },
      },
    ];
    const existing = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, `${existing}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 3916,
      method: "thread/read",
      params: { threadId },
    });

    const result = readResult(read) as {
      items: Array<{
        type: string;
        toolCallId?: string;
        output?: string;
        render?: {
          inputSummary?: string;
          outputSummary?: string;
        };
      }>;
    };

    const completedItem = result.items.find(
      (item) => item.type === "toolCall" && item.toolCallId === "tc-read-resume-1" && item.output === "Error: ENOENT",
    );
    expect(completedItem?.render).toMatchObject({
      inputSummary: "README.md",
      outputSummary: "Read failed",
    });
  });

  it("thread/read preserves tool duration from assistant timestamp to tool result timestamp", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer(
      createAppServerConfig({ cwd: projectRoot, runtimeConfig: makeFactoryRuntimeConfig() }),
    );

    connectTestPeer(server);

    const paths = await ensureDiligentDir(projectRoot);

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1915,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    const startTimestamp = 1_000;
    const endTimestamp = 2_350;
    const sessionPath = join(paths.sessions, `${threadId}.jsonl`);
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date(startTimestamp).toISOString(),
        message: { role: "user", content: "run pwd", timestamp: startTimestamp },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: new Date(startTimestamp).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "tc-bash-2", name: "bash", input: { command: "pwd" } }],
          model: "fake-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp: startTimestamp,
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: new Date(endTimestamp).toISOString(),
        message: {
          role: "tool_result",
          toolCallId: "tc-bash-2",
          toolName: "bash",
          output: "/tmp/project",
          isError: false,
          timestamp: endTimestamp,
          render: {
            inputSummary: "pwd",
            outputSummary: "Command completed",
            blocks: [{ type: "command", command: "pwd", output: "/tmp/project", isError: false }],
          },
        },
      },
    ];
    const existing = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, `${existing}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 1917,
      method: "thread/read",
      params: { threadId },
    });

    const result = readResult(read) as {
      items: Array<{ type: string; toolCallId?: string; output?: string; startedAt?: number; durationMs?: number }>;
    };

    const completedItem = result.items.find(
      (item) => item.type === "toolCall" && item.toolCallId === "tc-bash-2" && item.output,
    );
    expect(completedItem?.startedAt).toBe(startTimestamp);
    expect(completedItem?.durationMs).toBe(1_350);
  });

  it("reads image fallback preview from persisted thread list data when first turn is image-only", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 110,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(start) as { threadId: string }).threadId;
    let resolveTurnCompleted: (() => void) | null = null;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    connection.setNotificationListener((notification) => {
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        resolveTurnCompleted?.();
      }
    });

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 111,
      method: "turn/start",
      params: {
        threadId,
        message: "",
        attachments: [{ type: "local_image", path: "/tmp/a.png", mediaType: "image/png", fileName: "a.png" }],
      },
    });

    await turnCompleted;

    const list = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 112,
      method: "thread/list",
      params: { limit: 10 },
    });
    const result = readResult(list) as { data: Array<{ id: string; firstUserMessage?: string }> };
    expect(result.data.find((item) => item.id === threadId)?.firstUserMessage).toBe("[image]");
  });

  it("returns uploaded image paths as absolute filesystem paths", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-image-upload-"));
    try {
      const result = await handleImageUpload({
        params: {
          fileName: "example.png",
          mediaType: "image/png",
          dataBase64: Buffer.from("png-bytes").toString("base64"),
        },
        threadId: "thread-1",
        cwd: projectRoot,
      });

      expect(result.path.replaceAll("\\", "/")).toContain("/.diligent/images/thread-1/");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("continues turn execution when restored image file is missing", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-missing-image-"));

    const visionModel: Model = {
      ...FAKE_MODEL,
      supportsVision: true,
    };

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(visionModel, [{ label: "base", content: "test" }], [], {
          cwd: projectRoot,
          effort: "medium",
          llmMsgStreamFn: (model) => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: model.id,
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });
            return stream as never;
          },
        }),
    });

    try {
      const connection = connectTestPeer(server);
      let resolveTurnCompleted: (() => void) | null = null;
      const turnCompleted = new Promise<void>((resolve) => {
        resolveTurnCompleted = resolve;
      });
      connection.setNotificationListener((notification) => {
        if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
          resolveTurnCompleted?.();
        }
      });

      const start = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 211,
        method: "thread/start",
        params: { cwd: projectRoot },
      });
      const threadId = (readResult(start) as { threadId: string }).threadId;

      const turnStart = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 212,
        method: "turn/start",
        params: {
          threadId,
          message: "describe this",
          attachments: [
            {
              type: "local_image",
              path: ".diligent/images/missing.png",
              mediaType: "image/png",
              fileName: "missing.png",
            },
          ],
        },
      });

      expect((readResult(turnStart) as { accepted: boolean }).accepted).toBe(true);
      await turnCompleted;
      connection.disconnect();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("treats empty user-input response as aborted turn", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ ask }) =>
        new RuntimeAgent(
          FAKE_MODEL,
          [{ label: "base", content: "test" }],
          [createRequestUserInputTool({ ask }) as never],
          {
            effort: "medium",
            ...fakeConfig(() => {
              const stream = new EventStream(
                (event) => event.type === "done",
                (event) => ({ message: (event as { message: unknown }).message }),
              );

              queueMicrotask(() => {
                stream.push({ type: "start" });
                stream.push({
                  type: "done",
                  stopReason: "tool_use",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "tool_call",
                        id: "tc-1",
                        name: "request_user_input",
                        input: {
                          questions: [
                            {
                              id: "q1",
                              header: "scope",
                              question: "Pick one",
                              options: [
                                { label: "A (Recommended)", description: "Preferred" },
                                { label: "B", description: "Alternative" },
                              ],
                            },
                          ],
                        },
                      },
                    ],
                    model: "fake-model",
                    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    stopReason: "tool_use",
                    timestamp: Date.now(),
                  },
                });
              });

              return stream as never;
            }),
          },
        ),
    });

    const connection = connectTestPeer(server);

    const notifications: DiligentServerNotification[] = [];
    let resolveTurnDone: (() => void) | null = null;
    const turnDone = new Promise<void>((resolve) => {
      resolveTurnDone = resolve;
    });

    connection.setNotificationListener((notification) => {
      notifications.push(notification);
      if (
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED ||
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED
      ) {
        resolveTurnDone?.();
      }
    });

    connection.setServerRequestHandler(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST) {
        return {
          method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
          result: { answers: {} },
        };
      }
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision: "once" },
      };
    });

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 20,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const startResult = readResult(start) as { threadId: string };

    const turnStart = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 21,
      method: "turn/start",
      params: { threadId: startResult.threadId, message: "hi" },
    });
    const turnStartResult = readResult(turnStart) as { accepted: boolean };
    expect(turnStartResult.accepted).toBe(true);

    await turnDone;

    // abortRequested causes a normal (non-throwing) loop exit → TURN_COMPLETED, not TURN_INTERRUPTED
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED)).toBe(true);
    expect(notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED)).toBe(false);
  });

  it("survives disconnect on a user-input prompt and completes when a reconnected client answers late", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    let streamCall = 0;
    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ ask }) =>
        new RuntimeAgent(
          FAKE_MODEL,
          [{ label: "base", content: "test" }],
          [createRequestUserInputTool({ ask }) as never],
          {
            effort: "medium",
            ...fakeConfig(() => {
              const stream = new EventStream(
                (event) => event.type === "done",
                (event) => ({ message: (event as { message: unknown }).message }),
              );
              streamCall += 1;
              const first = streamCall === 1;
              queueMicrotask(() => {
                stream.push({ type: "start" });
                stream.push({
                  type: "done",
                  stopReason: first ? "tool_use" : "end_turn",
                  message: {
                    role: "assistant",
                    content: first
                      ? [
                          {
                            type: "tool_call",
                            id: "tc-1",
                            name: "request_user_input",
                            input: {
                              questions: [
                                {
                                  id: "q1",
                                  header: "scope",
                                  question: "Pick one",
                                  options: [
                                    { label: "A", description: "First" },
                                    { label: "B", description: "Second" },
                                  ],
                                },
                              ],
                            },
                          },
                        ]
                      : [{ type: "text", text: "done" }],
                    model: "fake-model",
                    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    stopReason: first ? "tool_use" : "end_turn",
                    timestamp: Date.now(),
                  },
                });
              });
              return stream as never;
            }),
          },
        ),
    });

    // A controllable peer that captures server→client requests without auto-answering,
    // and can inject a client→server response on demand.
    function makeControllablePeer() {
      const sent: JSONRPCMessage[] = [];
      const notifications: DiligentServerNotification[] = [];
      let messageListener: ((message: JSONRPCMessage) => void | Promise<void>) | null = null;
      const peer: TestPeer = {
        async send(message: JSONRPCMessage) {
          if ("method" in message && !("id" in message)) notifications.push(message as DiligentServerNotification);
          else sent.push(message);
        },
        onMessage(listener) {
          messageListener = listener;
        },
      };
      return {
        peer,
        sent,
        notifications,
        userInputRequest: () =>
          sent.find(
            (m) => "id" in m && "method" in m && m.method === DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
          ) as { id: number; method: string } | undefined,
        inject: (message: JSONRPCMessage) => messageListener?.(message),
      };
    }

    try {
      const connA = makeControllablePeer();
      const disconnectA = server.connect("conn-a", connA.peer as never);

      const start = await server.handleRequest("conn-a", {
        id: 30,
        method: "thread/start",
        params: { cwd: projectRoot },
      });
      const threadId = (readResult(start) as { threadId: string }).threadId;

      const turnStart = await server.handleRequest("conn-a", {
        id: 31,
        method: "turn/start",
        params: { threadId, message: "hi" },
      });
      expect((readResult(turnStart) as { accepted: boolean }).accepted).toBe(true);

      // Wait until the agent broadcasts the user-input prompt to conn-a.
      const deadline = Date.now() + 2000;
      while (!connA.userInputRequest() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const req = connA.userInputRequest();
      expect(req).toBeDefined();
      const reqId = req!.id;

      // Simulate an idle socket drop before the user answers.
      disconnectA();

      // A fresh client reconnects (new connection id) and subscribes to the thread.
      const connB = makeControllablePeer();
      server.connect("conn-b", connB.peer as never);
      let resolveTurnDone: (() => void) | null = null;
      const turnDone = new Promise<void>((resolve) => {
        resolveTurnDone = resolve;
      });
      // Register listener before subscribing so we capture completion.
      const originalSend = connB.peer.send;
      connB.peer.send = async (message: JSONRPCMessage) => {
        await originalSend(message);
        if (
          "method" in message &&
          !("id" in message) &&
          message.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED
        ) {
          resolveTurnDone?.();
        }
      };

      await server.handleRequest("conn-b", {
        id: 32,
        method: "thread/subscribe",
        params: { threadId },
      });

      // The durable prompt should be re-delivered to the reconnected client with the same id.
      const redelivered = connB.userInputRequest();
      expect(redelivered).toBeDefined();
      expect(redelivered!.id).toBe(reqId);

      // The late answer, delivered from the new connection, resolves the request and the turn completes.
      await connB.inject({ id: reqId, result: { answers: { q1: "B" } } } as JSONRPCMessage);
      await turnDone;

      expect(connB.notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED)).toBe(
        true,
      );
      expect(connB.notifications.some((n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED)).toBe(
        false,
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("persists turn-ending errors to thread history and emits error agent event", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const notifications: DiligentServerNotification[] = [];

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            throw new ProviderError("socket closed unexpectedly", {
              errorType: "network",
              isRetryable: false,
            });
          }),
        }),
    });

    const connection = connectTestPeer(server);
    connection.setNotificationListener((notification) => {
      notifications.push(notification);
    });

    const started = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 700,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(started) as { threadId: string }).threadId;

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 701,
      method: "turn/start",
      params: { threadId, message: "hi" },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const errorEventNotification = notifications.find(
      (n) => n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT && n.params.event.type === "error",
    );
    expect(errorEventNotification).toBeDefined();
    if (errorEventNotification?.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT) {
      expect(errorEventNotification.params.event.error.message).toContain("socket closed unexpectedly");
      expect(errorEventNotification.params.event.error.presentation).toEqual({
        message: "A network problem occurred. Please try again.",
        recovery: { kind: "retry" },
      });
    }

    const read = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 702,
      method: "thread/read",
      params: { threadId },
    });
    const result = readResult(read) as {
      errors?: Array<{ error: { message: string; name: string }; fatal: boolean; turnId?: string }>;
    };
    expect(result.errors?.length).toBe(1);
    expect(result.errors?.[0]?.error.message).toContain("socket closed unexpectedly");
    expect(result.errors?.[0]?.error).not.toHaveProperty("presentation");
    expect(result.errors?.[0]?.fatal).toBe(false);
    expect(result.errors?.[0]?.turnId).toBeDefined();
  });

  it("emits turn/completed only after session writes are flushed", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const paths = await ensureDiligentDir(projectRoot);

    const originalWrite = SessionWriter.prototype.write;
    SessionWriter.prototype.write = async function delayedWrite(entry) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await originalWrite.call(this, entry);
    };

    try {
      const server = new DiligentAppServer({
        cwd: projectRoot,
        resolvePaths: async (cwd) => ensureDiligentDir(cwd),
        createAgent: () =>
          new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
            effort: "medium",
            ...fakeConfig(() => {
              const stream = new EventStream(
                (event) => event.type === "done",
                (event) => ({ message: (event as { message: unknown }).message }),
              );
              queueMicrotask(() => {
                stream.push({ type: "start" });
                stream.push({ type: "text_delta", delta: "persist-check" });
                stream.push({
                  type: "done",
                  stopReason: "end_turn",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "persist-check" }],
                    model: "fake-model",
                    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    stopReason: "end_turn",
                    timestamp: Date.now(),
                  },
                });
              });
              return stream as never;
            }),
          }),
      });

      const connection = connectTestPeer(server);
      const start = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 970,
        method: "thread/start",
        params: { cwd: projectRoot },
      });
      const threadId = (readResult(start) as { threadId: string }).threadId;
      const sessionPath = join(paths.sessions, `${threadId}.jsonl`);

      const turnCompleted = new Promise<void>((resolve, reject) => {
        connection.setNotificationListener(async (notification) => {
          if (notification.method !== DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) return;
          try {
            const text = await readFile(sessionPath, "utf8");
            expect(text).toContain("persist-check");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });

      await server.handleRequest(TEST_CONNECTION_ID, {
        id: 971,
        method: "turn/start",
        params: { threadId, message: "hi" },
      });

      await turnCompleted;
    } finally {
      SessionWriter.prototype.write = originalWrite;
    }
  });

  it("uses yolo permission engine to skip approval prompts", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const runtimeConfig = makeFactoryRuntimeConfig();
    runtimeConfig.permissionEngine = createYoloPermissionEngine();

    const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig: runtimeConfig as never });
    const server = new DiligentAppServer({
      ...config,
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ approve }) =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(async () => {
              stream.push({ type: "start" });
              const decision = await approve({
                permission: "execute",
                toolName: "bash",
                description: "run ls",
                details: { command: "ls" },
              });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `decision:${decision}` }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);
    let approvalRequestCount = 0;
    const turnDone = new Promise<void>((resolve) => {
      connection.setNotificationListener((notification) => {
        if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
          resolve();
        }
      });
    });

    connection.setServerRequestHandler(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
        approvalRequestCount += 1;
      }
      return defaultServerRequestResponse(request.method);
    });

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 972,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(start) as { threadId: string }).threadId;

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 973,
      method: "turn/start",
      params: { threadId, message: "hi" },
    });

    await turnDone;
    expect(approvalRequestCount).toBe(0);
  });

  it("uses permission rules to reject without approval prompt", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const runtimeConfig = makeFactoryRuntimeConfig();
    runtimeConfig.permissionEngine = createPermissionEngine([
      { permission: "execute", pattern: "rm **", action: "deny" },
    ]);

    const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig: runtimeConfig as never });
    const server = new DiligentAppServer({
      ...config,
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ approve }) =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(async () => {
              stream.push({ type: "start" });
              const decision = await approve({
                permission: "execute",
                toolName: "bash",
                description: "run rm",
                details: { command: "rm -rf tmp" },
              });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `decision:${decision}` }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);
    let approvalRequestCount = 0;
    const turnDone = new Promise<void>((resolve) => {
      connection.setNotificationListener((notification) => {
        if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
          resolve();
        }
      });
    });

    connection.setServerRequestHandler(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
        approvalRequestCount += 1;
      }
      return defaultServerRequestResponse(request.method);
    });

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 974,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const threadId = (readResult(start) as { threadId: string }).threadId;

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 975,
      method: "turn/start",
      params: { threadId, message: "hi" },
    });

    await turnDone;
    expect(approvalRequestCount).toBe(0);
  });

  it("lists effective tool state and persists tool settings for next turns", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const runtimeConfig = makeFactoryRuntimeConfig({
        tools: {
          builtin: { bash: false },
        },
      });

      const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig: runtimeConfig as never });
      const server = new DiligentAppServer({
        ...config,
        cwd: projectRoot,
        resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      });

      connectTestPeer(server);

      const listed = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 200,
        method: "tools/list",
        params: {},
      });
      const listedResult = readResult(listed) as {
        configPath: string;
        appliesOnNextTurn: boolean;
        trustMode: string;
        conflictPolicy: string;
        tools: Array<{ name: string; enabled: boolean; immutable: boolean; reason: string }>;
        plugins: Array<{ package: string }>;
      };

      const expectedGlobalPath = join(fakeHome, ".diligent", "config.jsonc");
      expect(listedResult.configPath).toBe(expectedGlobalPath);
      expect(listedResult.appliesOnNextTurn).toBe(true);
      expect(listedResult.trustMode).toBe("full_trust");
      expect(listedResult.conflictPolicy).toBe("error");
      expect(listedResult.plugins).toEqual([]);
      expect(listedResult.tools.find((tool) => tool.name === "bash")).toMatchObject({
        enabled: false,
        immutable: false,
        reason: "disabled_by_user",
      });
      expect(listedResult.tools.find((tool) => tool.name === "plan")).toMatchObject({
        enabled: true,
        immutable: true,
      });
      expect(listedResult.tools.find((tool) => tool.name === "skill")).toMatchObject({
        enabled: true,
        immutable: true,
      });

      const setResult = readResult(
        await server.handleRequest(TEST_CONNECTION_ID, {
          id: 201,
          method: "tools/set",
          params: {
            builtin: { bash: true, read: false },
            plugins: [{ package: "@acme/diligent-tools", enabled: false, tools: { jira_comment: false } }],
            conflictPolicy: "plugin_wins",
          },
        }),
      ) as {
        conflictPolicy: string;
        tools: Array<{ name: string; enabled: boolean }>;
        plugins: Array<{ package: string; enabled: boolean; loaded: boolean }>;
      };

      expect(setResult.conflictPolicy).toBe("plugin_wins");
      expect(setResult.tools.find((tool) => tool.name === "bash")).toMatchObject({ enabled: true });
      expect(setResult.tools.find((tool) => tool.name === "read")).toMatchObject({ enabled: false });
      expect(setResult.plugins).toEqual([
        {
          package: "@acme/diligent-tools",
          configured: true,
          enabled: false,
          loaded: false,
          toolCount: 0,
          warnings: [],
        },
      ]);
      expect(runtimeConfig.diligent.tools).toEqual({
        builtin: { read: false },
        plugins: [{ package: "@acme/diligent-tools", enabled: false, tools: { jira_comment: false } }],
        conflictPolicy: "plugin_wins",
      });

      const configText = await Bun.file(expectedGlobalPath).text();
      expect(configText).toContain('"read": false');
      expect(configText).not.toContain('"bash": true');
      expect(configText).toContain('"package": "@acme/diligent-tools"');
      expect(configText).toContain('"conflictPolicy": "plugin_wins"');

      const threadStart = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 202,
        method: "thread/start",
        params: { cwd: projectRoot },
      });
      const threadId = (readResult(threadStart) as { threadId: string }).threadId;
      const turnStart = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 203,
        method: "turn/start",
        params: { threadId, message: "hi" },
      });
      expect((readResult(turnStart) as { accepted: boolean }).accepted).toBe(true);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("tools/set writes to global config path", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const fakeHome = await mkdtemp(join(tmpdir(), "diligent-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const runtimeConfig = makeFactoryRuntimeConfig();
      const config = createAppServerConfig({ cwd: projectRoot, runtimeConfig: runtimeConfig as never });
      const server = new DiligentAppServer({
        ...config,
        cwd: projectRoot,
        resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      });

      connectTestPeer(server);

      const setResult = readResult(
        await server.handleRequest(TEST_CONNECTION_ID, {
          id: 204,
          method: "tools/set",
          params: {
            plugins: [{ package: "@acme/diligent-tools", tools: { jira_comment: false } }],
          },
        }),
      ) as {
        configPath: string;
      };

      const expectedGlobalPath = join(fakeHome, ".diligent", "config.jsonc");
      expect(setResult.configPath).toBe(expectedGlobalPath);
      const configText = await Bun.file(expectedGlobalPath).text();
      expect(configText).toContain('"jira_comment": false');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("emits thread status busy->idle around manual thread compaction", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "hello" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 300,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const startResult = readResult(start) as { threadId: string };

    const compactResponse = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 301,
      method: "thread/compact/start",
      params: { threadId: startResult.threadId },
    });
    const compactResult = readResult(compactResponse) as {
      compacted: boolean;
      entryCount: number;
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(typeof compactResult.compacted).toBe("boolean");

    const statusEvents = connection.notifications.filter(
      (
        notification,
      ): notification is Extract<
        DiligentServerNotification,
        { method: typeof DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED }
      > =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
        notification.params.threadId === startResult.threadId,
    );

    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents[0]?.params.status).toBe("busy");
    expect(statusEvents[statusEvents.length - 1]?.params.status).toBe("idle");

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("emits error notification before idle when manual compaction fails", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );

            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({
                type: "done",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "hello" }],
                  model: "fake-model",
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "end_turn",
                  timestamp: Date.now(),
                },
              });
            });

            return stream as never;
          }),
        }),
    });

    const connection = connectTestPeer(server);

    try {
      const start = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 302,
        method: "thread/start",
        params: { cwd: projectRoot },
      });
      const startResult = readResult(start) as { threadId: string };

      const runtime = (
        server as unknown as { threads: Map<string, { manager: { compactNow: () => Promise<unknown> } }> }
      ).threads.get(startResult.threadId);
      if (!runtime) throw new Error("missing runtime");
      runtime.manager.compactNow = mock(async () => {
        throw new ProviderError("compaction network failed", { errorType: "network", isRetryable: true });
      });

      const compactResponse = await server.handleRequest(TEST_CONNECTION_ID, {
        id: 303,
        method: "thread/compact/start",
        params: { threadId: startResult.threadId },
      });
      expect(() => readResult(compactResponse)).toThrow("compaction network failed");

      const threadNotifications = connection.notifications.filter(
        (notification) => "threadId" in notification.params && notification.params.threadId === startResult.threadId,
      );
      const errorIndex = threadNotifications.findIndex(
        (notification) => notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      );
      const idleIndex = threadNotifications.findIndex(
        (notification) =>
          notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
          notification.params.status === "idle",
      );

      expect(errorIndex).toBeGreaterThan(-1);
      expect(idleIndex).toBeGreaterThan(errorIndex);
      const errorNotification = threadNotifications[errorIndex];
      if (errorNotification?.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR) {
        expect(errorNotification.params.error.presentation).toEqual({
          message: "A network problem occurred. Please try again.",
        });
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rebinds collab handler when registry instance changes between turns", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-app-server-"));
    const paths = await ensureDiligentDir(projectRoot);

    let llmCallCount = 0;
    let childSessionCount = 0;

    const streamFunction = () => {
      const callNumber = ++llmCallCount;
      const stream = new EventStream(
        (event) => event.type === "done",
        (event) => ({ message: (event as { message: unknown }).message }),
      );

      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const assistantByCall = () => {
        if (callNumber === 1) {
          return {
            role: "assistant" as const,
            content: [{ type: "tool_call" as const, id: "tc-noop", name: "noop", input: {} }],
            model: "fake-model",
            usage,
            stopReason: "tool_use" as const,
            timestamp: Date.now(),
          };
        }
        if (callNumber === 2) {
          return {
            role: "assistant" as const,
            content: [
              {
                type: "tool_call" as const,
                id: "tc-spawn",
                name: "spawn_agent",
                input: {
                  message: "Read any markdown file",
                  description: "spawn test",
                  agent_type: "general",
                },
              },
            ],
            model: "fake-model",
            usage,
            stopReason: "tool_use" as const,
            timestamp: Date.now(),
          };
        }
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "done" }],
          model: "fake-model",
          usage,
          stopReason: "end_turn" as const,
          timestamp: Date.now(),
        };
      };

      queueMicrotask(() => {
        stream.push({ type: "start" });
        stream.push({ type: "done", stopReason: assistantByCall().stopReason, message: assistantByCall() });
      });

      return stream as never;
    };

    const noopTool = {
      name: "noop",
      description: "No-op tool for turn progression",
      parameters: z.object({}),
      execute: async () => ({ output: "ok" }),
    };

    const server = new DiligentAppServer({
      cwd: projectRoot,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ ask, getSessionId }) => {
        const { tools: collabTools, registry } = createCollabTools({
          cwd: projectRoot,
          paths,
          modelId: "fake-model",
          effort: "medium",
          systemPrompt: [{ label: "base", content: "test" }],
          agentDefinitions: getBuiltinAgentDefinitions(),
          parentTools: [noopTool],
          getParentSessionId: getSessionId,
          ask,
          sessionManagerFactory: () => {
            const childSessionId = `child-${++childSessionCount}`;
            let childSubscriber: ((event: unknown) => void) | null = null;
            return {
              entries: [],
              leafId: null,
              create: async () => {},
              resume: async () => false,
              list: async () => [],
              getContext: () => [],
              subscribe: (fn: (event: unknown) => void) => {
                childSubscriber = fn;
                return () => {
                  childSubscriber = null;
                };
              },
              run: async () => {
                await new Promise<void>((resolve) => {
                  queueMicrotask(() => {
                    childSubscriber?.({ type: "agent_start" });
                    childSubscriber?.({ type: "turn_start", turnId: `turn-${childSessionId}` });
                    childSubscriber?.({
                      type: "tool_start",
                      itemId: `item-${childSessionId}`,
                      toolCallId: `call-${childSessionId}`,
                      toolName: "read",
                      input: { file_path: "README.md" },
                    });
                    childSubscriber?.({
                      type: "tool_update",
                      itemId: `item-${childSessionId}`,
                      toolCallId: `call-${childSessionId}`,
                      toolName: "read",
                      partialResult: "partial",
                    });
                    childSubscriber?.({
                      type: "tool_end",
                      itemId: `item-${childSessionId}`,
                      toolCallId: `call-${childSessionId}`,
                      toolName: "read",
                      output: "done",
                      isError: false,
                    });
                    childSubscriber?.({
                      type: "message_end",
                      itemId: `msg-${childSessionId}`,
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "child done" }],
                        model: "fake-model",
                        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                        stopReason: "end_turn",
                        timestamp: Date.now(),
                      },
                    });
                    childSubscriber?.({ type: "agent_end", messages: [] });
                    resolve();
                  });
                });
              },
              waitForWrites: async () => {},
              steer: () => {},
              hasPendingMessages: () => false,
              popPendingMessages: () => null,
              appendModeChange: () => {},
              get sessionPath() {
                return null;
              },
              get sessionId() {
                return childSessionId;
              },
              get entryCount() {
                return 0;
              },
            } as never;
          },
        });

        return new RuntimeAgent(
          FAKE_MODEL,
          [{ label: "base", content: "test" }],
          [noopTool, ...collabTools],
          { effort: "medium", ...fakeConfig(streamFunction) },
          registry,
        );
      },
    });

    const connection = connectTestPeer(server);

    const notifications: DiligentServerNotification[] = [];
    const turnDone = new Promise<void>((resolve) => {
      connection.setNotificationListener((notification) => {
        notifications.push(notification);
        if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
          resolve();
        }
      });
    });

    const start = await server.handleRequest(TEST_CONNECTION_ID, {
      id: 30,
      method: "thread/start",
      params: { cwd: projectRoot },
    });
    const startResult = readResult(start) as { threadId: string };

    await server.handleRequest(TEST_CONNECTION_ID, {
      id: 31,
      method: "turn/start",
      params: { threadId: startResult.threadId, message: "hi" },
    });

    await turnDone;

    expect(
      notifications.some(
        (n) =>
          n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT && n.params.event.type === "collab_spawn_begin",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (n) =>
          n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT && n.params.event.type === "collab_spawn_end",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (n) =>
          n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
          n.params.event.type === "tool_start" &&
          typeof n.params.event.childThreadId === "string",
      ),
    ).toBe(true);
  });
});
