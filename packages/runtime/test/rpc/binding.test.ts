// @summary Tests for transport-neutral JSON-RPC binding, request correlation, and NDJSON framing

import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { EventStream } from "@diligent/core/event-stream";
import type { StreamFunction } from "@diligent/core/provider-contract";
import {
  DILIGENT_CLIENT_REQUEST_METHODS,
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_SERVER_REQUEST_METHODS,
  type JSONRPCMessage,
} from "@diligent/protocol";
import {
  type AgentOptions,
  createNdjsonParser,
  formatNdjsonMessage,
  RpcClientSession,
  type RpcPeer,
  RuntimeAgent,
} from "@diligent/runtime";
import { DiligentAppServer } from "@diligent/runtime/app-server";
import { ensureDiligentDir } from "@diligent/runtime/infrastructure";
import { readKnowledge } from "@diligent/runtime/knowledge";
import { z } from "zod";

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

class MemoryPeer implements RpcPeer {
  private messageListener: ((message: JSONRPCMessage) => void | Promise<void>) | null = null;
  private closeListener: ((error?: Error) => void) | null = null;
  counterpart: MemoryPeer | null = null;
  sent: JSONRPCMessage[] = [];

  send(message: JSONRPCMessage): void {
    this.sent.push(message);
    void this.counterpart?.messageListener?.(message);
  }

  onMessage(listener: (message: JSONRPCMessage) => void | Promise<void>): void {
    this.messageListener = listener;
  }

  onClose(listener: (error?: Error) => void): void {
    this.closeListener = listener;
  }

  close(error?: Error): void {
    this.closeListener?.(error);
  }
}

function createLinkedPeers(): { client: MemoryPeer; server: MemoryPeer } {
  const client = new MemoryPeer();
  const server = new MemoryPeer();
  client.counterpart = server;
  server.counterpart = client;
  return { client, server };
}

describe("RPC binding", () => {
  it("binds a peer to DiligentAppServer and completes initialize/thread/start flow", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-rpc-binding-"));
    const { client: clientPeer, server: serverPeer } = createLinkedPeers();

    const notifications: JSONRPCMessage[] = [];
    const client = new RpcClientSession(clientPeer, {
      onNotification: async (notification) => {
        notifications.push(notification);
      },
    });
    clientPeer.onMessage(async (message) => {
      await client.handleMessage(message);
    });

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

    const { bindAppServer } = await import("@diligent/runtime");
    const stop = bindAppServer(server, serverPeer);

    const init = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.INITIALIZE, {
      clientName: "test-client",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    });
    expect(init.protocolVersion).toBe(1);
    expect(init.cwd).toBe(projectRoot);
    expect(init.mode).toBe("default");
    expect(init.effort).toBe("medium");
    expect(init.currentModel).toBe("fake-model");

    const started = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START, { cwd: projectRoot });
    expect(started.threadId).toMatch(/^\d{20}-[0-9a-f]{6}$/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      notifications.some(
        (message) => "method" in message && message.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED,
      ),
    ).toBe(true);

    stop();
  });

  it("rejects initialize requests with unsupported protocolVersion", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-rpc-binding-"));
    const { client: clientPeer, server: serverPeer } = createLinkedPeers();

    const client = new RpcClientSession(clientPeer);
    clientPeer.onMessage(async (message) => {
      await client.handleMessage(message);
    });

    const server = new DiligentAppServer({
      cwd: projectRoot,
      createAgent: () => {
        throw new Error("createAgent should not be called for initialize rejection test");
      },
    });

    const { bindAppServer } = await import("@diligent/runtime");
    const stop = bindAppServer(server, serverPeer);

    await expect(
      client.request(DILIGENT_CLIENT_REQUEST_METHODS.INITIALIZE, {
        clientName: "test-client",
        clientVersion: "0.0.1",
        protocolVersion: 2,
      }),
    ).rejects.toThrow("Unsupported protocolVersion: 2. Only version 1 is supported.");

    stop();
  });

  it("round-trips server-initiated approval requests through the bound peer", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-rpc-binding-"));
    const { client: clientPeer, server: serverPeer } = createLinkedPeers();

    let approvalRequestId: string | number | null = null;
    const client = new RpcClientSession(clientPeer, {
      onServerRequest: async (request) => {
        expect(request.method).toBe(DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST);
        return {
          method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
          result: { decision: "once" },
        };
      },
    });

    clientPeer.onMessage(async (message) => {
      if (
        "method" in message &&
        "id" in message &&
        message.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST
      ) {
        approvalRequestId = message.id;
      }
      await client.handleMessage(message);
    });

    let streamCallCount = 0;
    const server = new DiligentAppServer({
      cwd: projectRoot,
      defaultEffort: "medium",
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: ({ approve }) => {
        // Approval tool closes over `approve` from createAgent — the Runtime pattern
        const approvalTool = {
          name: "needs_approval",
          description: "Requests approval",
          parameters: z.object({}),
          execute: async (): Promise<{ output: string }> => {
            await approve({
              permission: "execute",
              toolName: "needs_approval",
              description: "approval test",
            });
            return { output: "approved" };
          },
        };

        return new RuntimeAgent(FAKE_MODEL, [{ label: "base", content: "test" }], [approvalTool], {
          effort: "medium",
          ...fakeConfig(() => {
            const stream = new EventStream(
              (event) => event.type === "done",
              (event) => ({ message: (event as { message: unknown }).message }),
            );
            const isFirstCall = ++streamCallCount === 1;
            queueMicrotask(() => {
              stream.push({ type: "start" });
              if (isFirstCall) {
                stream.push({
                  type: "done",
                  stopReason: "tool_use",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "tool_call",
                        id: "tc-approval",
                        name: "needs_approval",
                        input: {},
                      },
                    ],
                    model: "fake-model",
                    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    stopReason: "tool_use",
                    timestamp: Date.now(),
                  },
                });
              } else {
                stream.push({
                  type: "done",
                  stopReason: "end_turn",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    model: "fake-model",
                    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    stopReason: "end_turn",
                    timestamp: Date.now(),
                  },
                });
              }
            });
            return stream as never;
          }),
        });
      },
    });

    const { bindAppServer } = await import("@diligent/runtime");
    const stop = bindAppServer(server, serverPeer);

    const started = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START, { cwd: projectRoot });
    const turn = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START, {
      threadId: started.threadId,
      message: "please run",
    });
    expect(turn.accepted).toBe(true);

    // Wait long enough for the async approval round-trip through MemoryPeer
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approvalRequestId).not.toBeNull();

    stop();
  });

  it("supports knowledge update (upsert/delete) over RPC", async () => {
    const projectRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "diligent-rpc-binding-knowledge-"));
    const { client: clientPeer, server: serverPeer } = createLinkedPeers();

    const client = new RpcClientSession(clientPeer);
    clientPeer.onMessage(async (message) => {
      await client.handleMessage(message);
    });

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

    const { bindAppServer } = await import("@diligent/runtime");
    const stop = bindAppServer(server, serverPeer);

    const started = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START, { cwd: projectRoot });

    const added = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE, {
      action: "upsert",
      threadId: started.threadId,
      type: "pattern",
      content: "Use focused tests before full suite",
      tags: ["tests"],
    });
    expect(added.entry.content).toBe("Use focused tests before full suite");
    expect(added.entry.type).toBe("pattern");

    const updated = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE, {
      action: "upsert",
      threadId: started.threadId,
      id: added.entry.id,
      type: "backlog",
      content: "Run focused tests before full suite",
      tags: ["tests", "workflow"],
    });
    expect(updated.entry.id).toBe(added.entry.id);
    expect(updated.entry.type).toBe("backlog");
    expect(updated.entry.confidence).toBe(0.8);

    const listed = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST, {
      threadId: started.threadId,
      limit: 10,
    });
    expect(listed.data.some((entry) => entry.id === added.entry.id && entry.type === "backlog")).toBe(true);

    const deleted = await client.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE, {
      action: "delete",
      threadId: started.threadId,
      id: added.entry.id,
    });
    expect(deleted.deleted).toBe(true);

    const paths = await ensureDiligentDir(projectRoot);
    const entries = await readKnowledge(paths.knowledge);
    expect(entries.some((entry) => entry.id === added.entry.id)).toBe(false);

    stop();
  });

  it("parses and formats NDJSON JSON-RPC frames", () => {
    const seen: JSONRPCMessage[] = [];
    const parser = createNdjsonParser((message) => {
      seen.push(message);
    });

    const first = formatNdjsonMessage({ id: 1, method: "initialize", params: { clientName: "cli" } });
    const second = formatNdjsonMessage({ method: "initialized" });

    parser.push(first.slice(0, 10));
    parser.push(first.slice(10) + second);
    parser.end();

    expect(seen).toEqual([{ id: 1, method: "initialize", params: { clientName: "cli" } }, { method: "initialized" }]);
  });
});
