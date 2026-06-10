// @summary React hook to set up and tear down the AgentNativeBridge on the window object
import { useEffect } from "react";
import type { AgentContextItem } from "./agent-native-bridge";
import { createAgentNativeBridge, installAgentNativeBridgeMock } from "./agent-native-bridge";

export function useAgentNativeBridge(updateContextItems: (items: AgentContextItem[]) => void): void {
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
