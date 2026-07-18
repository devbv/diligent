// @summary App-server e2e client using RpcClientSession and an in-memory bidirectional peer

import {
  DILIGENT_VERSION,
  type DiligentServerNotification,
  type DiligentServerRequest,
  type DiligentServerRequestResponse,
  type JSONRPCMessage,
} from "@diligent/protocol";
import { type DiligentAppServer, RpcClientSession } from "@diligent/runtime";

export interface ProtocolTestClient {
  /** Send a typed JSON-RPC request and await the response. */
  request<M extends string>(method: M, params: Record<string, unknown>): Promise<unknown>;
  /** All notifications received from the server. */
  notifications: DiligentServerNotification[];
  /** Wait until a notification with the given method arrives. */
  waitForNotification(method: string, timeout?: number): Promise<DiligentServerNotification>;
  /** Wait until a notification matching a predicate arrives. */
  waitFor(predicate: (n: DiligentServerNotification) => boolean, timeout?: number): Promise<DiligentServerNotification>;
  /** Shortcut: initialize + thread/start, returns threadId. */
  initAndStartThread(cwd: string): Promise<string>;
  /** Shortcut: turn/start + wait for turn/completed or turn/interrupted. Returns all notifications. */
  sendTurnAndWait(threadId: string, message: string, timeout?: number): Promise<DiligentServerNotification[]>;
  /** Register a handler for server-initiated requests (approval, user input). */
  onServerRequest(handler: (request: DiligentServerRequest) => Promise<DiligentServerRequestResponse>): void;
  /** Simulate connection close. */
  simulateClose(): void;
  /** Disconnect and clean up. */
  close(): void;
  /** The underlying connectionId. */
  connectionId: string;
}

let nextConnectionId = 1;

export function createProtocolClient(server: DiligentAppServer): ProtocolTestClient {
  const connectionId = `test-${nextConnectionId++}`;
  const notifications: DiligentServerNotification[] = [];
  const notificationWaiters: Array<{
    predicate: (n: DiligentServerNotification) => boolean;
    resolve: (n: DiligentServerNotification) => void;
  }> = [];
  const closeListeners: Array<() => void> = [];

  // Server-side listener — set when server calls onMessage during connect()
  let serverMessageListener: ((msg: JSONRPCMessage) => void | Promise<void>) | null = null;

  let serverRequestHandler: ((request: DiligentServerRequest) => Promise<DiligentServerRequestResponse>) | undefined;

  const rpcClient = new RpcClientSession(
    {
      send(message: JSONRPCMessage) {
        // Client → server: trigger the server's registered listener directly
        if (serverMessageListener) {
          void serverMessageListener(message);
        }
      },
    },
    {
      onNotification(notification: DiligentServerNotification) {
        notifications.push(notification);
        for (let i = notificationWaiters.length - 1; i >= 0; i--) {
          if (notificationWaiters[i].predicate(notification)) {
            notificationWaiters[i].resolve(notification);
            notificationWaiters.splice(i, 1);
          }
        }
      },
      async onServerRequest(request: DiligentServerRequest) {
        if (serverRequestHandler) {
          return serverRequestHandler(request);
        }
        if (request.method === "approval/request") {
          return { method: "approval/request", result: { decision: "once" as const } };
        }
        return { method: request.method, result: { answers: {} } } as DiligentServerRequestResponse;
      },
    },
  );

  // Connect to server with a direct bidirectional peer:
  // - server.send(msg) → rpcClient.handleMessage(msg)  (server → client)
  // - server.onMessage(listener) → captured for client → server routing
  const disconnect = server.connect(connectionId, {
    send(message: JSONRPCMessage) {
      void rpcClient.handleMessage(message);
    },
    onMessage(listener) {
      serverMessageListener = listener;
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
  });

  return {
    notifications,
    connectionId,

    async request(method, params) {
      return rpcClient.request(method as never, params as never);
    },

    waitForNotification(method, timeout = 2000) {
      const existing = notifications.find((n) => n.method === method);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for notification: ${method}`));
        }, timeout);
        notificationWaiters.push({
          predicate: (n) => n.method === method,
          resolve: (n) => {
            clearTimeout(timer);
            resolve(n);
          },
        });
      });
    },

    waitFor(predicate, timeout = 2000) {
      const existing = notifications.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for notification matching predicate"));
        }, timeout);
        notificationWaiters.push({
          predicate,
          resolve: (n) => {
            clearTimeout(timer);
            resolve(n);
          },
        });
      });
    },

    async initAndStartThread(cwd) {
      await rpcClient.request(
        "initialize" as never,
        {
          clientName: "test",
          clientVersion: DILIGENT_VERSION,
          protocolVersion: 1,
        } as never,
      );

      const result = (await rpcClient.request(
        "thread/start" as never,
        {
          cwd,
          mode: "default",
        } as never,
      )) as { threadId: string };

      return result.threadId;
    },

    async sendTurnAndWait(threadId, message, timeout = 5000) {
      // Subscribe if not already subscribed
      await rpcClient.request("thread/subscribe" as never, { threadId } as never);

      const startIdx = notifications.length;

      await rpcClient.request("turn/start" as never, { threadId, message } as never);

      // Wait for turn/completed or turn/interrupted
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for turn completion"));
        }, timeout);

        const check = () => {
          for (let i = startIdx; i < notifications.length; i++) {
            const n = notifications[i];
            if (n.method === "turn/completed" || n.method === "turn/interrupted") {
              clearTimeout(timer);
              resolve();
              return true;
            }
          }
          return false;
        };

        if (check()) return;

        notificationWaiters.push({
          predicate: (n) => n.method === "turn/completed" || n.method === "turn/interrupted",
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });

      return notifications.slice(startIdx);
    },

    onServerRequest(handler) {
      serverRequestHandler = handler;
    },

    simulateClose() {
      for (const l of closeListeners) l();
    },

    close() {
      rpcClient.close();
      disconnect();
    },
  };
}
