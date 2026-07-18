// @summary In-process RpcClientSession transport used by runtime eval executions

import {
  DILIGENT_VERSION,
  type DiligentServerNotification,
  type DiligentServerRequest,
  type JSONRPCMessage,
} from "@diligent/protocol";
import { type DiligentAppServer, RpcClientSession } from "@diligent/runtime";

let connectionSequence = 0;

export function createRuntimeProtocolClient(server: DiligentAppServer) {
  const notifications: DiligentServerNotification[] = [];
  const serverRequests: DiligentServerRequest[] = [];
  let serverListener: ((message: JSONRPCMessage) => void | Promise<void>) | undefined;
  const waiters = new Set<() => void>();
  const rpc = new RpcClientSession(
    {
      send(message) {
        void serverListener?.(message);
      },
    },
    {
      onNotification(notification) {
        notifications.push(notification);
        for (const notify of waiters) notify();
      },
      async onServerRequest(request) {
        serverRequests.push(structuredClone(request));
        if (request.method === "approval/request")
          return { method: request.method, result: { decision: "once" as const } };
        return { method: request.method, result: { answers: {} } } as never;
      },
    },
  );
  const disconnect = server.connect(`runtime-eval-${++connectionSequence}`, {
    send(message) {
      void rpc.handleMessage(message);
    },
    onMessage(listener) {
      serverListener = listener;
    },
    onClose() {},
  });

  return {
    notifications,
    serverRequests,
    request(method: string, params: Record<string, unknown>) {
      return rpc.request(method as never, params as never);
    },
    async initialize() {
      return rpc.request(
        "initialize" as never,
        { clientName: "diligent-runtime-eval", clientVersion: DILIGENT_VERSION, protocolVersion: 1 } as never,
      );
    },
    async waitForTerminal(startIndex: number, timeoutMs: number): Promise<DiligentServerNotification[]> {
      const terminal = () =>
        notifications
          .slice(startIndex)
          .find((item) => item.method === "turn/completed" || item.method === "turn/interrupted");
      if (!terminal()) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`Runtime turn exceeded ${timeoutMs}ms.`));
          }, timeoutMs);
          const check = () => {
            if (!terminal()) return;
            clearTimeout(timer);
            waiters.delete(check);
            resolve();
          };
          waiters.add(check);
        });
      }
      return notifications.slice(startIndex);
    },
    close() {
      rpc.close();
      disconnect();
    },
  };
}

export type RuntimeProtocolClient = ReturnType<typeof createRuntimeProtocolClient>;
