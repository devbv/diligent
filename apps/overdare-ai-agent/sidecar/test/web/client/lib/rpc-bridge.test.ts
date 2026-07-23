// @summary Tests for DiligentAppServer multi-connection fan-out and image upload via web-specific toImageUrl
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONRPCMessage } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS, DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import { DiligentAppServer, EventStream, ensureDiligentDir, RuntimeAgent } from "@diligent/runtime";
import { toWebImageUrl, WEB_IMAGE_ROUTE_PREFIX } from "../../../../src/web/shared/image-routes";

interface FakePeer {
  sent: JSONRPCMessage[];
  receive: (msg: JSONRPCMessage) => void;
  peer: import("@diligent/runtime").RpcPeer;
  closeListeners: Array<() => void>;
  simulateClose: () => void;
}

function createFakePeer(): FakePeer {
  const sent: JSONRPCMessage[] = [];
  const messageListeners: Array<(msg: JSONRPCMessage) => void | Promise<void>> = [];
  const closeListeners: Array<() => void> = [];

  const fakePeer: FakePeer = {
    sent,
    receive(msg: JSONRPCMessage) {
      for (const l of messageListeners) void l(msg);
    },
    closeListeners,
    simulateClose() {
      for (const l of closeListeners) l();
    },
    peer: {
      send(message: JSONRPCMessage) {
        sent.push(message);
      },
      onMessage(listener) {
        messageListeners.push(listener);
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
    },
  };
  return fakePeer;
}

async function withSandboxedProject<T>(run: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "diligent-web-rpc-bridge-"));
  try {
    return await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function createMinimalServer(opts: {
  cwd: string;
  toImageUrl?: (path: string) => string | undefined;
  completionDelayMs?: number;
}) {
  return new DiligentAppServer({
    cwd: opts.cwd,
    resolvePaths: async (cwd) => ensureDiligentDir(cwd),
    createAgent: () =>
      new RuntimeAgent(
        { id: "fake", provider: "fake", contextWindow: 8192, maxOutputTokens: 4096, supportsThinking: false },
        [],
        [],
        {
          effort: "medium",
          llmMsgStreamFn: () => {
            const stream = new EventStream(
              (e) => e.type === "done",
              (e) => ({ message: (e as { message: unknown }).message }),
            );
            queueMicrotask(() => {
              stream.push({ type: "start" });
              stream.push({ type: "text_delta", delta: "ok" });
              setTimeout(() => {
                stream.push({
                  type: "done",
                  stopReason: "end_turn",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "ok" }],
                    model: "fake",
                    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    stopReason: "end_turn",
                    timestamp: Date.now(),
                  },
                });
              }, opts.completionDelayMs ?? 0);
            });
            return stream as never;
          },
        },
      ),
    toImageUrl: opts.toImageUrl,
  });
}

function sendRpc(peer: FakePeer, msg: object) {
  peer.receive(msg as JSONRPCMessage);
}

function waitFor(peer: FakePeer, predicate: (msg: JSONRPCMessage) => boolean, timeout = 500): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const found = peer.sent.find(predicate);
      if (found) {
        clearInterval(interval);
        resolve(found);
      }
    }, 10);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Timed out waiting for message"));
    }, timeout);
  });
}

describe("DiligentAppServer multi-connection (web)", () => {
  test("thread/subscribe: subscribed peer receives thread notifications", async () => {
    await withSandboxedProject(async (projectRoot) => {
      const server = createMinimalServer({ cwd: projectRoot });
      const p1 = createFakePeer();
      const p2 = createFakePeer();
      server.connect("c1", p1.peer);
      server.connect("c2", p2.peer);

      sendRpc(p1, {
        id: 1,
        method: "initialize",
        params: { clientName: "test", clientVersion: "0.0.1", protocolVersion: 1 },
      });
      await new Promise((r) => setTimeout(r, 10));

      sendRpc(p1, { id: 2, method: "thread/start", params: { cwd: projectRoot, mode: "default" } });
      const threadStarted = await waitFor(
        p1,
        (m) => "method" in m && m.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED,
      );
      const threadId = (threadStarted as { params: { threadId: string } }).params.threadId;

      sendRpc(p1, { id: 3, method: "thread/subscribe", params: { threadId } });
      sendRpc(p2, { id: 4, method: "thread/subscribe", params: { threadId } });
      await new Promise((r) => setTimeout(r, 20));

      p1.sent.length = 0;
      p2.sent.length = 0;

      sendRpc(p1, { id: 5, method: "turn/start", params: { threadId, message: "hello" } });
      const notif1 = await waitFor(
        p1,
        (m) => "method" in m && (m as { method: string }).method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED,
      );
      const notif2 = await waitFor(
        p2,
        (m) => "method" in m && (m as { method: string }).method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED,
      );
      expect(notif1).toBeTruthy();
      expect(notif2).toBeTruthy();
    });
  });

  test("thread/unsubscribe: unsubscribed peer stops receiving thread notifications", async () => {
    await withSandboxedProject(async (projectRoot) => {
      const server = createMinimalServer({ cwd: projectRoot });
      const p1 = createFakePeer();
      server.connect("c1", p1.peer);

      sendRpc(p1, {
        id: 1,
        method: "initialize",
        params: { clientName: "t", clientVersion: "0.0.1", protocolVersion: 1 },
      });
      sendRpc(p1, { id: 2, method: "thread/start", params: { cwd: projectRoot, mode: "default" } });
      const started = await waitFor(
        p1,
        (m) => "method" in m && m.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED,
      );
      const threadId = (started as { params: { threadId: string } }).params.threadId;

      sendRpc(p1, { id: 3, method: "thread/subscribe", params: { threadId } });
      await new Promise((r) => setTimeout(r, 20));

      const subResponse = p1.sent.find((m) => "id" in m && (m as { id: unknown }).id === 3 && "result" in m) as
        | { result: { subscriptionId: string } }
        | undefined;
      expect(subResponse?.result.subscriptionId).toBeTruthy();
      const subscriptionId = subResponse!.result.subscriptionId;

      sendRpc(p1, { id: 4, method: "thread/unsubscribe", params: { subscriptionId } });
      await new Promise((r) => setTimeout(r, 10));

      const unsubResponse = p1.sent.find((m) => "id" in m && (m as { id: unknown }).id === 4 && "result" in m) as
        | { result: { ok: boolean } }
        | undefined;
      expect(unsubResponse?.result.ok).toBe(true);
    });
  });

  test("late subscriber can read busy state and first user message after turn already started", async () => {
    await withSandboxedProject(async (projectRoot) => {
      const server = createMinimalServer({ cwd: projectRoot, completionDelayMs: 150 });
      const initiator = createFakePeer();
      const observer = createFakePeer();
      server.connect("c1", initiator.peer);
      server.connect("c2", observer.peer);

      sendRpc(initiator, {
        id: 1,
        method: "initialize",
        params: { clientName: "t", clientVersion: "0.0.1", protocolVersion: 1 },
      });
      sendRpc(observer, {
        id: 2,
        method: "initialize",
        params: { clientName: "t", clientVersion: "0.0.1", protocolVersion: 1 },
      });
      await new Promise((r) => setTimeout(r, 10));

      sendRpc(initiator, { id: 3, method: "thread/start", params: { cwd: projectRoot, mode: "default" } });
      const started = await waitFor(
        initiator,
        (m) => "method" in m && m.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED,
      );
      const threadId = (started as { params: { threadId: string } }).params.threadId;

      sendRpc(initiator, { id: 4, method: "thread/subscribe", params: { threadId } });
      await waitFor(initiator, (m) => "id" in m && (m as { id: unknown }).id === 4 && "result" in m);

      initiator.sent.length = 0;
      observer.sent.length = 0;

      sendRpc(initiator, { id: 5, method: "turn/start", params: { threadId, message: "hello from draft" } });

      await waitFor(
        initiator,
        (m) =>
          "method" in m &&
          (m as { method: string }).method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED &&
          (m as { params?: { status?: string } }).params?.status === "busy",
      );

      sendRpc(observer, { id: 6, method: "thread/subscribe", params: { threadId } });
      await waitFor(observer, (m) => "id" in m && (m as { id: unknown }).id === 6 && "result" in m);

      sendRpc(observer, { id: 7, method: DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, params: { threadId } });
      const readResponse = (await waitFor(
        observer,
        (m) => "id" in m && (m as { id: unknown }).id === 7 && "result" in m,
      )) as {
        result: {
          isRunning: boolean;
          items: Array<{
            type: string;
            message?: { role?: string; content?: Array<{ type: string; text?: string }> | string };
          }>;
        };
      };

      expect(readResponse.result.isRunning).toBe(true);
      expect(
        readResponse.result.items.some(
          (item) =>
            item.type === "userMessage" &&
            item.message?.role === "user" &&
            (item.message.content === "hello from draft" ||
              (Array.isArray(item.message.content) &&
                item.message.content.some((block) => block.type === "text" && block.text === "hello from draft"))),
        ),
      ).toBe(true);
    });
  });

  test("disconnect: server removes connection without error", async () => {
    await withSandboxedProject(async (projectRoot) => {
      const server = createMinimalServer({ cwd: projectRoot });
      const p1 = createFakePeer();
      const disconnect = server.connect("c1", p1.peer);
      expect(() => disconnect()).not.toThrow();
      expect(() => server.disconnect("c1")).not.toThrow();
    });
  });

  test("image/upload: persists file and returns local_image with webUrl", async () => {
    await withSandboxedProject(async (projectRoot) => {
      const server = createMinimalServer({
        cwd: projectRoot,
        toImageUrl: (absPath) => toWebImageUrl(absPath),
      });
      const p1 = createFakePeer();
      server.connect("c1", p1.peer);

      sendRpc(p1, {
        id: 1,
        method: "initialize",
        params: { clientName: "t", clientVersion: "0.0.1", protocolVersion: 1 },
      });
      sendRpc(p1, { id: 2, method: "thread/start", params: { cwd: projectRoot, mode: "default" } });
      const started = await waitFor(
        p1,
        (m) => "method" in m && m.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED,
      );
      const threadId = (started as { params: { threadId: string } }).params.threadId;

      sendRpc(p1, { id: 3, method: "thread/subscribe", params: { threadId } });
      await new Promise((r) => setTimeout(r, 10));

      p1.sent.length = 0;
      sendRpc(p1, {
        id: 10,
        method: "image/upload",
        params: {
          threadId,
          fileName: "screen.png",
          mediaType: "image/png",
          dataBase64: Buffer.from("png-bytes").toString("base64"),
        },
      });

      const response = await waitFor(p1, (m) => "id" in m && (m as { id: unknown }).id === 10 && "result" in m);
      const attachment = (
        response as {
          result: { attachment: { type: string; path: string; mediaType: string; fileName: string; webUrl?: string } };
        }
      ).result.attachment;

      expect(attachment.type).toBe("local_image");
      expect(attachment.mediaType).toBe("image/png");
      expect(attachment.fileName).toBe("screen.png");
      expect(attachment.path.replaceAll("\\", "/")).toContain(".diligent/images/");
      expect(attachment.path).toContain(threadId);
      expect(attachment.webUrl).toContain(WEB_IMAGE_ROUTE_PREFIX);
      expect(await Bun.file(attachment.path).text()).toBe("png-bytes");
    });
  });

  test("thread/compact/start: returns false without a notification below the compaction threshold", async () => {
    await withSandboxedProject(async (projectRoot) => {
      const server = createMinimalServer({ cwd: projectRoot });
      const p1 = createFakePeer();
      server.connect("c1", p1.peer);

      sendRpc(p1, {
        id: 1,
        method: "initialize",
        params: { clientName: "t", clientVersion: "0.0.1", protocolVersion: 1 },
      });
      sendRpc(p1, { id: 2, method: "thread/start", params: { cwd: projectRoot, mode: "default" } });
      const started = await waitFor(
        p1,
        (m) => "method" in m && m.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED,
      );
      const threadId = (started as { params: { threadId: string } }).params.threadId;

      sendRpc(p1, {
        id: 3,
        method: DILIGENT_CLIENT_REQUEST_METHODS.THREAD_COMPACT_START,
        params: { threadId },
      });

      const response = await waitFor(p1, (m) => "id" in m && (m as { id: unknown }).id === 3 && "result" in m);
      expect((response as { result: { compacted: boolean } }).result.compacted).toBe(false);
      expect(
        p1.sent.some(
          (message) => "method" in message && message.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTED,
        ),
      ).toBe(false);
    });
  });
});
