import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientMessage, WsServerMessage } from "../lib/types.js";

interface UseWebSocketOptions {
  onMessage: (msg: WsServerMessage) => void;
}

export function useWebSocket({ onMessage }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectDelayRef.current = 1000; // reset backoff
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        onMessageRef.current(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Reconnect with exponential backoff
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
        connect();
      }, reconnectDelayRef.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  const subscribe = useCallback((sessionId: string) => {
    const msg: WsClientMessage = { type: "subscribe", sessionId };
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const unsubscribe = useCallback((sessionId: string) => {
    const msg: WsClientMessage = { type: "unsubscribe", sessionId };
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  return { connected, subscribe, unsubscribe };
}
