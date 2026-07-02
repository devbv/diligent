// @summary Tests for MCP app-server handlers — list/login/logout over a fake connection manager

import { afterEach, describe, expect, test } from "bun:test";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, type DiligentServerNotification } from "@diligent/protocol";
import { handleMcpList, handleMcpLoginStart, handleMcpLogout } from "../../src/app-server/mcp-handlers";
import type { McpServerConfig, McpServerStatus } from "../../src/tools/mcp";
import {
  __resetMcpManagerForTest,
  __setMcpManagerForTest,
  type McpConnectionManager,
} from "../../src/tools/mcp/client";

const servers: Record<string, McpServerConfig> = {
  github: { command: "gh-mcp" },
  linear: { url: "https://mcp.linear.app" },
};
const getMcpServers = () => servers;

interface FakeManagerOverrides {
  listStatus?: () => Promise<McpServerStatus[]>;
  login?: (
    name: string,
    config: McpServerConfig,
    options: { onAuthUrl?: (url: string) => void },
  ) => Promise<{ toolCount: number }>;
  logout?: (name: string, config?: McpServerConfig) => Promise<void>;
}

function installFakeManager(overrides: FakeManagerOverrides): void {
  __setMcpManagerForTest(overrides as unknown as McpConnectionManager);
}

afterEach(() => {
  __resetMcpManagerForTest();
});

describe("handleMcpList", () => {
  test("returns the manager's per-server status", async () => {
    const status: McpServerStatus[] = [
      { name: "github", transport: "stdio", status: "connected", toolCount: 12 },
      { name: "linear", transport: "http", status: "needs_auth", toolCount: 0 },
    ];
    installFakeManager({ listStatus: async () => status });
    const result = await handleMcpList(getMcpServers);
    expect(result.servers).toEqual(status);
  });
});

describe("handleMcpLoginStart", () => {
  test("returns the auth URL and broadcasts success on completion", async () => {
    const notifications: DiligentServerNotification[] = [];
    installFakeManager({
      login: async (_name, _config, options) => {
        options.onAuthUrl?.("https://mcp.linear.app/oauth/authorize?x=1");
        return { toolCount: 8 };
      },
    });

    const result = await handleMcpLoginStart({
      server: "linear",
      getMcpServers,
      emit: async (n) => {
        notifications.push(n);
      },
    });
    expect(result.authUrl).toBe("https://mcp.linear.app/oauth/authorize?x=1");

    // The completion notification is emitted from a background promise; let it flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED,
      params: { server: "linear", success: true, toolCount: 8, error: null },
    });
  });

  test("rejects for an unknown server", async () => {
    installFakeManager({});
    await expect(handleMcpLoginStart({ server: "nope", getMcpServers, emit: async () => {} })).rejects.toThrow(
      /Unknown MCP server/,
    );
  });

  test("broadcasts failure when login fails", async () => {
    const notifications: DiligentServerNotification[] = [];
    installFakeManager({
      login: async () => {
        throw new Error("login timed out");
      },
    });
    await expect(
      handleMcpLoginStart({
        server: "linear",
        getMcpServers,
        emit: async (n) => {
          notifications.push(n);
        },
      }),
    ).rejects.toThrow(/login timed out/);
    await new Promise((r) => setTimeout(r, 0));
    expect(notifications[0]).toMatchObject({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED,
      params: { server: "linear", success: false },
    });
  });
});

describe("handleMcpLogout", () => {
  test("delegates to manager.logout with the server config and returns ok", async () => {
    let loggedOut: string | undefined;
    installFakeManager({
      logout: async (name) => {
        loggedOut = name;
      },
    });
    const result = await handleMcpLogout({ server: "linear", getMcpServers });
    expect(result).toEqual({ ok: true });
    expect(loggedOut).toBe("linear");
  });
});
