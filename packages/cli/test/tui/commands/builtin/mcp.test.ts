// @summary Tests for the /mcp command — subcommand routing, arg validation, RPC dispatch, login flow

import { describe, expect, it, mock } from "bun:test";
import { DILIGENT_CLIENT_REQUEST_METHODS, type McpServerStatus } from "@diligent/protocol";
import { mcpCommand } from "../../../../src/tui/commands/builtin/mcp";
import type { CommandContext } from "../../../../src/tui/commands/types";
import type { AppServerRpcClient } from "../../../../src/tui/rpc-client";

function makeContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    app: {
      confirm: async () => true,
      pick: async () => null,
      prompt: async () => null,
      stop: () => {},
      getRpcClient: () => null,
    },
    config: {} as unknown as CommandContext["config"],
    threadId: null,
    skills: [],
    registry: {} as CommandContext["registry"],
    requestRender: () => {},
    displayLines: () => {},
    displayError: () => {},
    runAgent: async () => {},
    reload: async () => {},
    currentMode: "default",
    setMode: () => {},
    currentEffort: "medium",
    setEffort: async () => {},
    setModel: async () => {},
    clearChatHistory: () => {},
    clearScreenAndResetRenderer: () => {},
    startNewThread: async () => "thread-1",
    resumeThread: async () => "thread-1",
    deleteThread: async () => true,
    listThreads: async () => [],
    readThread: async () => null,
    onModelChanged: () => {},
    onEffortChanged: () => {},
    ...overrides,
  } as CommandContext;
}

const sampleServers: McpServerStatus[] = [
  { name: "github", transport: "stdio", status: "connected", toolCount: 12 },
  { name: "linear", transport: "http", status: "needs_auth", toolCount: 0 },
];

describe("/mcp list", () => {
  it("requests MCP_LIST and renders server lines (default subcommand)", async () => {
    const request = mock(async () => ({ servers: sampleServers }));
    const displayLines = mock((_lines: string[]) => {});
    const ctx = makeContext({
      app: {
        confirm: async () => true,
        pick: async () => null,
        prompt: async () => null,
        stop: () => {},
        getRpcClient: () => ({ request }) as unknown as AppServerRpcClient,
      },
      displayLines,
    });

    await mcpCommand.handler(undefined, ctx);

    expect(request).toHaveBeenCalledWith(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST, { threadId: undefined });
    const rendered = displayLines.mock.calls.at(-1)?.[0].join("\n") ?? "";
    expect(rendered).toContain("github");
    expect(rendered).toContain("linear");
    expect(rendered).toContain("12 tools");
  });
});

describe("/mcp login", () => {
  it("errors when the server name is missing", async () => {
    const displayError = mock((_msg: string) => {});
    await mcpCommand.handler("login", makeContext({ displayError }));
    expect(displayError).toHaveBeenCalledTimes(1);
    expect(displayError.mock.calls[0][0]).toContain("Missing server name");
  });

  it("starts login, shows the auth URL, and reports success on completion", async () => {
    const request = mock(async () => ({ authUrl: "https://linear.app/oauth?x=1" }));
    const displayLines = mock((_lines: string[]) => {});
    const waitForMcpLogin = mock(async () => ({ success: true, toolCount: 8, error: null }));
    const ctx = makeContext({
      app: {
        confirm: async () => true,
        pick: async () => null,
        prompt: async () => null,
        stop: () => {},
        getRpcClient: () => ({ request }) as unknown as AppServerRpcClient,
        waitForMcpLogin,
      },
      displayLines,
    });

    await mcpCommand.handler("login linear", ctx);

    expect(request).toHaveBeenCalledWith(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START, { server: "linear" });
    expect(waitForMcpLogin).toHaveBeenCalledWith("linear");
    const rendered = displayLines.mock.calls.map((c) => c[0].join("\n")).join("\n");
    expect(rendered).toContain("https://linear.app/oauth?x=1");
    expect(rendered).toContain("8 tools");
  });
});

describe("/mcp logout", () => {
  it("requests MCP_LOGOUT for the given server", async () => {
    const request = mock(async () => ({ ok: true }));
    const displayLines = mock((_lines: string[]) => {});
    const ctx = makeContext({
      app: {
        confirm: async () => true,
        pick: async () => null,
        prompt: async () => null,
        stop: () => {},
        getRpcClient: () => ({ request }) as unknown as AppServerRpcClient,
      },
      displayLines,
    });

    await mcpCommand.handler("logout linear", ctx);

    expect(request).toHaveBeenCalledWith(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGOUT, { server: "linear" });
    expect(displayLines.mock.calls.at(-1)?.[0].join("\n")).toContain("Cleared stored credentials");
  });
});
