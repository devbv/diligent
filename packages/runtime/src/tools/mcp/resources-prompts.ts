// @summary Proxy tools exposing MCP resources (list/read) and prompts (list/get) on demand

import type { Tool, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import type { RuntimeToolHost } from "../capabilities";
import { requestToolApproval } from "../capabilities";
import type { McpConnectionManager } from "./client";

const listParams = z.object({
  server: z.string().optional().describe("Restrict results to a single MCP server by name."),
});

const readResourceParams = z.object({
  server: z.string().describe("MCP server name (as shown by mcp_list_resources)."),
  uri: z.string().describe("Resource URI to read (as shown by mcp_list_resources)."),
});

const getPromptParams = z.object({
  server: z.string().describe("MCP server name (as shown by mcp_list_prompts)."),
  name: z.string().describe("Prompt name on that server (as shown by mcp_list_prompts)."),
  args: z.record(z.string(), z.unknown()).optional().describe("Prompt arguments (values coerced to strings)."),
});

/**
 * Resource tools for servers that advertise the `resources` capability. `mcp_list_resources`
 * enumerates available resources (read-only, no approval); `mcp_read_resource` fetches one by URI
 * behind the standard execute approval.
 */
export function createMcpResourceTools(
  servers: string[],
  manager: McpConnectionManager,
  host?: RuntimeToolHost,
): Tool[] {
  const known = new Set(servers);
  const listTool: Tool = {
    name: "mcp_list_resources",
    description: `List resources exposed by connected MCP servers. Servers with resources: ${servers.join(", ")}.`,
    parameters: listParams,
    supportParallel: true,
    async execute({ server }): Promise<ToolResult> {
      const targets = server ? [server] : servers;
      const entries: { server: string; uri: string; name: string; description?: string; mimeType?: string }[] = [];
      for (const name of targets) {
        if (!known.has(name)) continue;
        for (const r of await manager.listResources(name)) entries.push({ server: name, ...r });
      }
      if (entries.length === 0) return { output: "No MCP resources available." };
      return { output: JSON.stringify(entries, null, 2) };
    },
  };

  const readTool: Tool = {
    name: "mcp_read_resource",
    description: "Read the contents of an MCP resource by server and URI (discover them with mcp_list_resources).",
    parameters: readResourceParams,
    async execute({ server, uri }, ctx): Promise<ToolResult> {
      if (!known.has(server)) {
        return {
          output: `Unknown MCP server "${server}". Use mcp_list_resources to find valid servers.`,
          metadata: { error: true },
        };
      }
      const decision = await requestToolApproval(host, {
        permission: "execute",
        toolName: "mcp_read_resource",
        description: `Read MCP resource "${uri}" from server "${server}"`,
        details: { server, uri },
      });
      if (decision === "reject") return { output: "Resource read rejected by user." };
      const result = await manager.readResource(server, uri, ctx.signal);
      return { output: result.text || "(empty resource)", metadata: { mcpServer: server, mcpResource: uri } };
    },
  };

  return [listTool, readTool];
}

/**
 * Prompt tools for servers that advertise the `prompts` capability. `mcp_list_prompts` enumerates
 * prompt templates (read-only, no approval); `mcp_get_prompt` renders one behind execute approval.
 */
export function createMcpPromptTools(servers: string[], manager: McpConnectionManager, host?: RuntimeToolHost): Tool[] {
  const known = new Set(servers);
  const listTool: Tool = {
    name: "mcp_list_prompts",
    description: `List prompt templates exposed by connected MCP servers. Servers with prompts: ${servers.join(", ")}.`,
    parameters: listParams,
    supportParallel: true,
    async execute({ server }): Promise<ToolResult> {
      const targets = server ? [server] : servers;
      const entries: { server: string; name: string; description?: string; arguments?: unknown }[] = [];
      for (const name of targets) {
        if (!known.has(name)) continue;
        for (const p of await manager.listPrompts(name)) entries.push({ server: name, ...p });
      }
      if (entries.length === 0) return { output: "No MCP prompts available." };
      return { output: JSON.stringify(entries, null, 2) };
    },
  };

  const getTool: Tool = {
    name: "mcp_get_prompt",
    description: "Render an MCP prompt template by server and name (discover them with mcp_list_prompts).",
    parameters: getPromptParams,
    async execute({ server, name, args }, ctx): Promise<ToolResult> {
      if (!known.has(server)) {
        return {
          output: `Unknown MCP server "${server}". Use mcp_list_prompts to find valid servers.`,
          metadata: { error: true },
        };
      }
      const decision = await requestToolApproval(host, {
        permission: "execute",
        toolName: "mcp_get_prompt",
        description: `Render MCP prompt "${name}" from server "${server}"`,
        details: { server, name, args },
      });
      if (decision === "reject") return { output: "Prompt render rejected by user." };
      const result = await manager.getPrompt(server, name, args, ctx.signal);
      const header = result.description ? `${result.description}\n\n` : "";
      return {
        output: `${header}${result.text || "(empty prompt)"}`,
        metadata: { mcpServer: server, mcpPrompt: name },
      };
    },
  };

  return [listTool, getTool];
}
