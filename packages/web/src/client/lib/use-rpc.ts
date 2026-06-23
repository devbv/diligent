// @summary React hook for WebRpcClient lifecycle: creation, connection state, reconnect, and connection modal visibility
import { useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionState, getReconnectAttemptLimit, WebRpcClient } from "./rpc-client";

export function useRpcClient(url: string) {
  const rpcRef = useRef<WebRpcClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  useEffect(() => {
    const rpc = new WebRpcClient(url);
    rpcRef.current = rpc;

    rpc.onConnectionChange((next) => {
      setConnection(next);
      if (next === "connected") {
        setReconnectAttempts(0);
        return;
      }
      if (next === "reconnecting") {
        setReconnectAttempts((prev) => prev + 1);
      }
    });

    void rpc.connect();
    return () => rpc.disconnect();
  }, [url]);

  const retryConnection = (): void => {
    const rpc = rpcRef.current;
    if (!rpc || connection === "connecting" || connection === "reconnecting") return;
    setReconnectAttempts(0);
    void rpc.connect();
  };

  const retryLimit = getReconnectAttemptLimit();
  const showConnectionModal = useMemo(
    () => connection === "reconnecting" || (connection === "disconnected" && reconnectAttempts > 0),
    [connection, reconnectAttempts],
  );

  return { rpcRef, connection, reconnectAttempts, retryConnection, retryLimit, showConnectionModal };
}
