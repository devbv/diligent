import type { ServerWebSocket } from "bun";
import type { WsClientMessage, WsServerMessage } from "../shared/protocol.js";
import type { SessionEntry, SessionMeta } from "../shared/types.js";

export interface WsData {
  subscriptions: Set<string>;
}

export class WebSocketManager {
  private connections = new Set<ServerWebSocket<WsData>>();

  handleOpen(ws: ServerWebSocket<WsData>): void {
    this.connections.add(ws);
    const msg: WsServerMessage = { type: "connected", timestamp: Date.now() };
    ws.send(JSON.stringify(msg));
  }

  handleMessage(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
    try {
      const data = JSON.parse(typeof message === "string" ? message : message.toString()) as WsClientMessage;

      if (data.type === "subscribe") {
        ws.data.subscriptions.add(data.sessionId);
      } else if (data.type === "unsubscribe") {
        ws.data.subscriptions.delete(data.sessionId);
      }
    } catch {
      // ignore malformed messages
    }
  }

  handleClose(ws: ServerWebSocket<WsData>): void {
    this.connections.delete(ws);
  }

  broadcastSessionUpdated(sessionId: string, newEntries: SessionEntry[]): void {
    const msg: WsServerMessage = { type: "session_updated", sessionId, newEntries };
    const payload = JSON.stringify(msg);

    for (const ws of this.connections) {
      if (ws.data.subscriptions.has(sessionId)) {
        ws.send(payload);
      }
    }
  }

  broadcastSessionCreated(session: SessionMeta): void {
    const msg: WsServerMessage = { type: "session_created", session };
    const payload = JSON.stringify(msg);

    for (const ws of this.connections) {
      ws.send(payload);
    }
  }
}
