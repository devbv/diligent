// @summary React hook that installs and tears down AgentNativeBridge on window for host-injected context items

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
