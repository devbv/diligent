// @summary Verifies development RPC proxy target resolution for Vite.

import { describe, expect, test } from "bun:test";
import { normalizeRpcProxyTarget, resolveDevRpcProxyTarget } from "../../src/server/dev-proxy-target";

describe("dev RPC proxy target", () => {
  test("uses the default backend when no environment override is present", () => {
    expect(resolveDevRpcProxyTarget({} as NodeJS.ProcessEnv)).toBe("ws://localhost:7433");
  });

  test("prefers an explicit proxy target", () => {
    expect(
      resolveDevRpcProxyTarget({
        DILIGENT_WEB_RPC_TARGET: "ws://127.0.0.1:7445",
        VITE_DILIGENT_RPC_URL: "ws://127.0.0.1:7433/rpc",
      } as NodeJS.ProcessEnv),
    ).toBe("ws://127.0.0.1:7445");
  });

  test("accepts the legacy Vite RPC URL and strips the /rpc endpoint path", () => {
    expect(resolveDevRpcProxyTarget({ VITE_DILIGENT_RPC_URL: "ws://127.0.0.1:7433/rpc" } as NodeJS.ProcessEnv)).toBe(
      "ws://127.0.0.1:7433",
    );
  });

  test("can derive the target from a backend port", () => {
    expect(resolveDevRpcProxyTarget({ DILIGENT_WEB_SERVER_PORT: "7440" } as NodeJS.ProcessEnv)).toBe(
      "ws://localhost:7440",
    );
  });

  test("normalizes non-URL values conservatively", () => {
    expect(normalizeRpcProxyTarget("backend.internal/rpc")).toBe("backend.internal");
  });
});
