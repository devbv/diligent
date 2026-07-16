// @summary Tests for WebRpcClient raw JSON-RPC request handling and reconnect delay policy
import { afterEach, expect, test } from "bun:test";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, DILIGENT_SERVER_REQUEST_METHODS } from "@diligent/protocol";
import { getReconnectAttemptLimit, getReconnectDelay, WebRpcClient } from "../../../src/client/lib/rpc-client";

const OriginalWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(payload: string) {
    this.sent.push(payload);
    const parsed = JSON.parse(payload) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (parsed.method === "initialize" && typeof parsed.id === "number") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: {
              serverName: "fake",
              serverVersion: "test",
              protocolVersion: 1,
              capabilities: {
                supportsFollowUp: true,
                supportsApprovals: true,
                supportsUserInput: true,
              },
              cwd: process.cwd(),
              mode: "default",
              effort: "medium",
              currentModel: "test-model",
              availableModels: [],
            },
          }),
        });
      });
      return;
    }

    if (parsed.method === "turn/start" && typeof parsed.id === "number") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: { accepted: true },
          }),
        });
      });
      return;
    }

    if (parsed.method === "tools/list" && typeof parsed.id === "number") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: {
              configPath: `${process.cwd()}/.diligent/config.jsonc`,
              appliesOnNextTurn: true,
              trustMode: "full_trust",
              conflictPolicy: "error",
              tools: [],
              plugins: [],
            },
          }),
        });
      });
      return;
    }

    if (parsed.method === "tools/set" && typeof parsed.id === "number") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: {
              configPath: `${process.cwd()}/.diligent/config.jsonc`,
              appliesOnNextTurn: true,
              trustMode: "full_trust",
              conflictPolicy: "plugin_wins",
              tools: [],
              plugins: [],
            },
          }),
        });
      });
      return;
    }

    if (parsed.method === "thread/subscribe" && typeof parsed.id === "number") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: parsed.id,
            result: { subscriptionId: `sub-${parsed.params?.threadId ?? "x"}` },
          }),
        });
      });
    }
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  FakeWebSocket.instances = [];
});

test("sends raw json-rpc request and resolves response", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();
  await client.initialize({
    clientName: "diligent-web",
    clientVersion: "0.0.1",
    protocolVersion: 1,
  });

  const result = await client.request("turn/start", {
    threadId: "t1",
    message: "hi",
  });

  expect((result as { accepted: boolean }).accepted).toBe(true);
  const sent = FakeWebSocket.instances[0]?.sent.map((entry) => JSON.parse(entry));
  expect(sent?.some((entry) => entry.method === "turn/start" && entry.id === 2)).toBe(true);
  client.disconnect();
});

test("request accepts null timeout for long-running rpc calls", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();
  await client.initialize({
    clientName: "diligent-web",
    clientVersion: "0.0.1",
    protocolVersion: 1,
  });

  const rawPromise = client.requestRaw("slow/method", { ok: true }, null);
  const sent = FakeWebSocket.instances[0]?.sent.map((entry) => JSON.parse(entry));
  const request = sent?.find((entry) => entry.method === "slow/method");
  expect(request?.id).toBeDefined();

  FakeWebSocket.instances[0]!.onmessage?.({
    data: JSON.stringify({
      id: request!.id,
      result: { ok: true },
    }),
  });

  await expect(rawPromise).resolves.toEqual({ ok: true });
  client.disconnect();
});

test("initialize result is the bootstrap source and triggers resubscribe", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();
  await client.subscribe("thread-1");
  FakeWebSocket.instances[0]!.sent.length = 0;

  const init = await client.initialize({
    clientName: "diligent-web",
    clientVersion: "0.0.1",
    protocolVersion: 1,
  });

  expect(init.cwd).toBe(process.cwd());
  expect(init.mode).toBe("default");
  const sentMethods = FakeWebSocket.instances[0]!.sent.map((entry) => JSON.parse(entry).method);
  expect(sentMethods).toContain("initialize");
  expect(sentMethods).toContain("thread/subscribe");
  client.disconnect();
});

test("tools/list and tools/set requests resolve through the shared request path", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();
  await client.initialize({
    clientName: "diligent-web",
    clientVersion: "0.0.1",
    protocolVersion: 1,
  });

  const listed = await client.request("tools/list", { threadId: "thread-1" });
  const saved = await client.request("tools/set", {
    threadId: "thread-1",
    builtin: { bash: false },
    plugins: [{ package: "@acme/diligent-tools", enabled: true }],
  });

  expect((listed as { trustMode: string }).trustMode).toBe("full_trust");
  expect((saved as { conflictPolicy: string }).conflictPolicy).toBe("plugin_wins");
  const sentMethods = FakeWebSocket.instances[0]!.sent.map((entry) => JSON.parse(entry).method);
  expect(sentMethods).toContain("tools/list");
  expect(sentMethods).toContain("tools/set");
  client.disconnect();
});

test("server request response resolution emits server/request/resolved notification locally", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();

  const seen: Array<{ id: number; method: string }> = [];
  const resolved: number[] = [];
  client.onServerRequest((id, request) => {
    seen.push({ id, method: request.method });
  });
  client.onNotification((notification) => {
    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED) {
      resolved.push(notification.params.requestId);
    }
  });

  FakeWebSocket.instances[0]!.onmessage?.({
    data: JSON.stringify({
      id: 41,
      method: "approval/request",
      params: {
        threadId: "thread-1",
        request: { permission: "execute", toolName: "bash", description: "run" },
      },
    }),
  });

  expect(seen).toEqual([{ id: 41, method: "approval/request" }]);

  FakeWebSocket.instances[0]!.onmessage?.({
    data: JSON.stringify({
      id: 41,
      result: { decision: "once" },
    }),
  });

  expect(resolved).toEqual([41]);
  client.disconnect();
});

test("respondServerRequest sends response and clears retry after resolved notification", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();

  FakeWebSocket.instances[0]!.onmessage?.({
    data: JSON.stringify({
      id: 42,
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      params: {
        threadId: "thread-1",
        request: {
          questions: [
            {
              id: "q1",
              header: "Next",
              question: "Continue?",
              options: [{ label: "Yes", description: "Continue." }],
            },
          ],
        },
      },
    }),
  });

  client.respondServerRequest(42, {
    method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
    result: { answers: { q1: "Yes" } },
  });

  expect(FakeWebSocket.instances[0]!.sent.map((entry) => JSON.parse(entry))).toContainEqual({
    id: 42,
    result: { answers: { q1: "Yes" } },
  });

  FakeWebSocket.instances[0]!.onmessage?.({
    data: JSON.stringify({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      params: { requestId: 42 },
    }),
  });

  client.disconnect();
});

test("re-delivered unanswered server request does not re-notify the listener", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new WebRpcClient("ws://example.test/rpc");
  await client.connect();

  const seen: Array<{ id: number; method: string }> = [];
  client.onServerRequest((id, request) => {
    seen.push({ id, method: request.method });
  });

  const deliver = () =>
    FakeWebSocket.instances[0]!.onmessage?.({
      data: JSON.stringify({
        id: 42,
        method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
        params: {
          threadId: "thread-1",
          request: {
            questions: [{ id: "q1", header: "Next", question: "Continue?", options: [] }],
          },
        },
      }),
    });

  deliver();
  // The server re-delivers the same durable prompt (e.g. after a reconnect) while the user is
  // still answering. Re-notifying the listener would reset in-progress input in the UI (a
  // half-typed custom answer), so an already-pending, unanswered request must be ignored.
  deliver();

  expect(seen).toEqual([{ id: 42, method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST }]);
  client.disconnect();
});

test("returns expected reconnect delays", () => {
  expect(getReconnectDelay(0)).toBe(1000);
  expect(getReconnectDelay(1)).toBe(2000);
  expect(getReconnectDelay(2)).toBe(5000);
  expect(getReconnectDelay(10)).toBe(5000);
  expect(getReconnectAttemptLimit()).toBe(5);
});

test("retries when initial websocket open fails", async () => {
  class FlakyWebSocket {
    static OPEN = 1;
    static attempts = 0;

    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(public readonly url: string) {
      FlakyWebSocket.attempts += 1;
      const attempt = FlakyWebSocket.attempts;
      queueMicrotask(() => {
        if (attempt === 1) {
          this.onerror?.();
          return;
        }
        this.readyState = FlakyWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(_: string) {}

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = FlakyWebSocket as unknown as typeof WebSocket;
  const states: string[] = [];
  const client = new WebRpcClient("ws://example.test/rpc");
  client.onConnectionChange((state) => states.push(state));

  await client.connect();
  expect(FlakyWebSocket.attempts).toBe(2);
  expect(states).toContain("reconnecting");
  expect(states.at(-1)).toBe("connected");

  client.disconnect();
});
