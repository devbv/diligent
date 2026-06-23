// @summary React hook that registers and tears down the AgentNativeBridge on the window object
import { useEffect } from "react";
import { type AgentContextItem, createAgentNativeBridge, installAgentNativeBridgeMock } from "./agent-native-bridge";

export function useAgentNativeBridge({
  updateContextItems,
}: {
  updateContextItems: (items: AgentContextItem[]) => void;
}): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const previousBridge = window.AgentNativeBridge;
    window.AgentNativeBridge = createAgentNativeBridge({ updateContextItems });
    installAgentNativeBridgeMock(window);
    return () => {
      window.AgentNativeBridge = previousBridge;
    };
  }, [updateContextItems]);
}
