// @summary /mcp command — list configured MCP servers and manage OAuth login/logout (P070)

import { DILIGENT_CLIENT_REQUEST_METHODS, type McpServerStatus } from "@diligent/protocol";
import { t } from "../../theme";
import type { Command, CommandContext } from "../types";

const STATUS_BADGE: Record<McpServerStatus["status"], string> = {
  connected: `${t.success}✓${t.reset}`,
  needs_auth: `${t.warn}⚠${t.reset}`,
  error: `${t.error}✗${t.reset}`,
  disabled: `${t.dim}∅${t.reset}`,
};

function usage(ctx: CommandContext): void {
  ctx.displayLines([
    "",
    `  ${t.bold}Usage${t.reset}`,
    "    /mcp list",
    "    /mcp login <server>",
    "    /mcp logout <server>",
    "",
  ]);
}

function renderServerLine(server: McpServerStatus): string {
  const badge = STATUS_BADGE[server.status];
  const name = `${t.bold}${server.name}${t.reset}`.padEnd(24 + t.bold.length + t.reset.length);
  const transport = `${t.dim}${server.transport}${t.reset}`.padEnd(6 + t.dim.length + t.reset.length);
  let detail: string;
  switch (server.status) {
    case "connected":
      detail = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
      break;
    case "needs_auth":
      detail = `${t.warn}needs login${t.reset}  (run /mcp login ${server.name})`;
      break;
    case "error":
      detail = `${t.error}error: ${server.error ?? "unavailable"}${t.reset}`;
      break;
    default:
      detail = `${t.dim}disabled${t.reset}`;
  }
  return `  ${badge} ${name} ${transport} ${detail}`;
}

async function listServers(ctx: CommandContext): Promise<void> {
  const rpc = ctx.app.getRpcClient?.();
  if (!rpc) {
    ctx.displayError("App server not available.");
    return;
  }
  const { servers } = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST, {
    threadId: ctx.threadId ?? undefined,
  });
  if (servers.length === 0) {
    ctx.displayLines([
      "",
      `  ${t.dim}No MCP servers configured. Add them under \`mcpServers\` in config.jsonc.${t.reset}`,
      "",
    ]);
    return;
  }
  ctx.displayLines(["", `  ${t.bold}MCP Servers${t.reset}`, "", ...servers.map(renderServerLine), ""]);
}

async function loginServer(ctx: CommandContext, server: string): Promise<void> {
  const rpc = ctx.app.getRpcClient?.();
  if (!rpc) {
    ctx.displayError("App server not available.");
    return;
  }
  const waitFn = ctx.app.waitForMcpLogin;
  if (!waitFn) {
    ctx.displayError("MCP login completion handler not available.");
    return;
  }

  try {
    const completion = waitFn(server);
    ctx.displayLines([`  Opening browser for ${t.bold}${server}${t.reset} authorization...`]);
    const { authUrl } = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START, { server });
    if (authUrl) {
      ctx.displayLines([`  Auth URL: ${t.dim}${authUrl}${t.reset}`]);
    }

    const result = await completion;
    if (!result.success) {
      ctx.displayError(`Login failed for "${server}": ${result.error ?? "Unknown error"}`);
      return;
    }
    const count = result.toolCount ?? 0;
    ctx.displayLines([
      `  ${t.success}Authenticated.${t.reset} ${t.bold}${server}${t.reset} now exposes ${count} tool${count === 1 ? "" : "s"} (next turn).`,
    ]);
  } catch (err) {
    ctx.displayError(`Login failed for "${server}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function logoutServer(ctx: CommandContext, server: string): Promise<void> {
  const rpc = ctx.app.getRpcClient?.();
  if (!rpc) {
    ctx.displayError("App server not available.");
    return;
  }
  try {
    await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGOUT, { server });
    ctx.displayLines([`  ${t.success}Cleared stored credentials for "${server}".${t.reset}`]);
  } catch (err) {
    ctx.displayError(`Logout failed for "${server}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const mcpCommand: Command = {
  name: "mcp",
  description: "List and manage MCP servers (list / login / logout)",
  supportsArgs: true,
  availableDuringTask: true,
  async handler(args, ctx) {
    const [sub, server] = (args ?? "").trim().split(/\s+/).filter(Boolean);

    if (!sub || sub === "list") {
      await listServers(ctx);
      return;
    }
    if (sub === "login" || sub === "logout") {
      if (!server) {
        ctx.displayError(`Missing server name. Usage: /mcp ${sub} <server>`);
        return;
      }
      await (sub === "login" ? loginServer(ctx, server) : logoutServer(ctx, server));
      return;
    }
    usage(ctx);
  },
};
