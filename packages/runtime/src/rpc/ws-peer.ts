// @summary Creates a transport-neutral RpcPeer from a WebSocket sender for use in both web server and e2e tests

import { type JSONRPCMessage, JSONRPCMessageSchema } from "../protocol/index";
import type { RpcPeer } from "./channel";

/**
 * Minimal interface required from a WebSocket connection — only the send capability.
 * Both Bun's ServerWebSocket and test stubs satisfy this interface.
 */
export interface WebSocketSender {
  send(data: string): void;
}

/**
 * Creates a transport-neutral RpcPeer from a WebSocket sender.
 *
 * Returns `peer` (the RpcPeer abstraction passed to DiligentAppServer) and `receive`
 * (call with each raw incoming message to dispatch it to registered listeners).
 *
 * This shared implementation is used by both `packages/web/src/server/index.ts` (production
 * WebSocket server) and `packages/e2e/app-server/helpers/ws-server-factory.ts` (transport-level e2e
 * tests), ensuring that e2e tests exercise the same message-parsing code path as production.
 */
export function createWsPeer(ws: WebSocketSender): {
  peer: RpcPeer;
  receive: (raw: string | Buffer) => void;
} {
  const listeners: Array<(msg: JSONRPCMessage) => void | Promise<void>> = [];

  const peer: RpcPeer = {
    send(message: JSONRPCMessage): void {
      ws.send(JSON.stringify(message));
    },
    onMessage(listener: (msg: JSONRPCMessage) => void | Promise<void>): void {
      listeners.push(listener);
    },
  };

  const receive = (raw: string | Buffer): void => {
    let parsed: JSONRPCMessage;
    try {
      parsed = JSONRPCMessageSchema.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
    } catch {
      ws.send(JSON.stringify({ id: "unknown", error: { code: -32700, message: "Malformed JSON" } }));
      return;
    }
    for (const listener of listeners) {
      void listener(parsed);
    }
  };

  return { peer, receive };
}
