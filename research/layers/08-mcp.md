# Layer 8: MCP (Model Context Protocol)

## Key Questions

1. Which MCP specification version is supported?
2. How are MCP servers configured and started? (config format, lifecycle management)
3. How does MCP integrate with the tool system? (do MCP tools become regular tools?)
4. Which MCP capabilities are supported? (tools, prompts, resources, sampling)
5. How is the MCP transport layer implemented? (stdio, HTTP/SSE, etc.)
6. How are MCP server errors and failures handled?
7. Is there MCP server discovery? (if so, how?)
8. How does MCP interact with the permission/approval system?
9. What MCP client libraries or SDKs are used (if any)?
10. What is the boundary between MCP and the rest of the system?

## codex-rs Analysis

### Architecture Overview

codex-rs has the **most mature MCP implementation** of the three projects. It has a dedicated `rmcp-client` crate that wraps the `rmcp` Rust crate (an MCP SDK), a `mcp-server` crate that exposes codex itself as an MCP server, and a separate `shell-tool-mcp` crate.

### MCP Client Library

Uses the **`rmcp` Rust crate** (MCP SDK for Rust). The `rmcp-client` crate wraps it with:
- `RmcpClient` — central client managing connections to MCP servers
- `ClientState` enum: `Connecting { transport }` | `Ready { service, oauth }`
- `PendingTransport` enum: `ChildProcess`, `StreamableHttp`, `StreamableHttpWithOAuth`

### Transport Support

Three transport types:
1. **Stdio (ChildProcess)**: `TokioChildProcess` transport, spawns command as child process with piped stdio. Includes `ProcessGroupGuard` for cleanup.
2. **Streamable HTTP**: `StreamableHttpClientTransport<reqwest::Client>` for remote servers without auth.
3. **Streamable HTTP with OAuth**: `StreamableHttpClientTransport<AuthClient<reqwest::Client>>` with `OAuthPersistor` for token management.

### Config Format

MCP servers configured in TOML config under `mcp_servers`:
```rust
McpServerConfig {
    command: Vec<String>,        // For stdio transport
    url: Option<String>,         // For HTTP transport
    env: HashMap<String, String>, // Environment variables
    headers: HashMap<String, String>, // HTTP headers
    // ... transport-specific fields
}
```

Config layer stack supports MCP servers at each layer (global, project, managed).

### MCP Protocol Types (protocol/src/mcp.rs)

Protocol-level MCP types for wire communication:
- `Tool` — name, title, description, input_schema, output_schema, annotations, icons, meta
- `Resource` — name, uri, description, mime_type, size, title, annotations
- `ResourceTemplate` — uri_template, name, title, description, mime_type
- `CallToolResult` — content, structured_content, is_error, meta
- Adapter helpers for converting between rmcp model types and protocol-friendly types

### Capabilities Supported

- **Tools**: Full support — MCP tools listed via `listTools()`, invoked via `callTool()`
- **Resources**: `listResources()`, `readResource()`, resource templates
- **Prompts**: Not explicitly observed in client code
- **Elicitation**: `CreateElicitationRequestParams` / `CreateElicitationResult` types present
- **OAuth**: Full OAuth flow with token persistence via `OAuthPersistor`

### Tool System Integration

MCP tools integrate via the `ToolHandler` trait:
- `ToolKind::Mcp` — dedicated kind for MCP tool handlers
- `ToolPayload::Mcp { server, tool, args }` — MCP-specific payload
- `ToolOutput::Mcp { result: Result<CallToolResult, String> }` — MCP-specific output
- MCP tools are registered in the `ToolRegistryBuilder` alongside built-in tools
- `MCPConnectionManager` manages MCP server connections and provides tool specs
- MCP tools appear in the LLM's tool list with namespaced names (server_name + tool_name)

### Permission/Approval Integration

MCP tool calls go through the same approval pipeline as built-in tools:
- `ExecApprovalRequirement` evaluated for MCP tool calls
- Events: `McpToolCallBegin` / `McpToolCallEnd` emitted for UI tracking
- MCP operations: `Op::ListMcpTools`, `Op::RefreshMcpServers` for runtime management

### Error Handling

- Connection failures tracked per-server with `McpAuthStatus`
- OAuth flow: `UnauthorizedError` detection, token refresh, re-authentication
- Tool call failures wrapped in `ToolOutput::Mcp { result: Err(String) }`
- Timeout handling with `run_with_timeout()`
- Process group cleanup via `ProcessGroupGuard` on stdio transport

### MCP Server Mode

codex-rs can also act as an MCP server (`mcp-server` crate):
- Exposes codex tools to other MCP clients
- `message_processor.rs` handles incoming MCP requests
- `patch_approval.rs` handles approval for patch operations

---

## pi-agent Analysis

### Architecture Overview

pi-agent has **no built-in MCP support**. There is no MCP client, no MCP server configuration, and no MCP protocol integration in the codebase. The only reference to "mcp" found was in a test file for settings manager that included it as a config field name.

### Implications

- MCP functionality would need to be added entirely from scratch
- The extension system (`ExtensionAPI`) could potentially be used to add MCP support as an extension
- The tool registration system (`pi.registerTool()`) provides the hook point where MCP tools could be registered
- Without MCP, pi-agent relies entirely on built-in tools and extension-registered tools

### Key Observation

pi-agent's approach is to use its **extension system** as the extensibility mechanism rather than MCP. Extensions can register tools, commands, and UI elements. This is a competing pattern to MCP for tool extensibility.

---

## opencode Analysis

### Architecture Overview

opencode has a **comprehensive MCP implementation** using the official `@modelcontextprotocol/sdk` npm package. The MCP module (`packages/opencode/src/mcp/index.ts`) manages multiple MCP server connections with full lifecycle management.

### MCP Client Library

Uses the official **`@modelcontextprotocol/sdk`** TypeScript SDK:
- `Client` from `@modelcontextprotocol/sdk/client/index.js`
- Transport imports: `StdioClientTransport`, `StreamableHTTPClientTransport`, `SSEClientTransport`
- Schema imports: `CallToolResultSchema`, `ToolListChangedNotificationSchema`

### Transport Support

Three transport types:
1. **Stdio**: `StdioClientTransport` for local servers — spawns command with piped stdio, `cwd` set to project directory, environment variables merged
2. **Streamable HTTP**: `StreamableHTTPClientTransport` for remote servers — tried first
3. **SSE**: `SSEClientTransport` as fallback for remote servers — tried if StreamableHTTP fails

Remote servers try StreamableHTTP first, then fall back to SSE.

### Config Format

Config under `mcp` key, discriminated union on `type`:
```typescript
Config.McpLocal {
    type: "local",
    command: string[],        // Command and arguments
    environment?: Record<string, string>,
    enabled?: boolean,
    timeout?: number,
}

Config.McpRemote {
    type: "remote",
    url: string,
    enabled?: boolean,
    headers?: Record<string, string>,
    timeout?: number,
    oauth?: false | { clientId?, clientSecret?, scope? },
}

Config.Mcp = McpLocal | McpRemote  // discriminated union on "type"
```

### Lifecycle Management

`MCP` namespace manages state via `Instance.state()`:
- **Startup**: All configured MCP servers connected in parallel via `Promise.all()`
- **Status tracking**: Per-server status: `connected | disabled | failed | needs_auth | needs_client_registration`
- **Dynamic management**: `add()`, `connect()`, `disconnect()` for runtime server management
- **Cleanup**: All clients closed on instance teardown
- **Notification handling**: `ToolListChangedNotification` triggers `Bus.publish(ToolsChanged)` event

### Capabilities Supported

- **Tools**: `listTools()` → converted to AI SDK `Tool` objects via `convertMcpTool()`
- **Prompts**: `listPrompts()` → registered as slash commands in the command system
- **Resources**: `listResources()`, `readResource()` for resource access
- **OAuth**: Full OAuth flow with `McpOAuthProvider`, browser-based authentication, PKCE support

### Tool System Integration

MCP tools become **AI SDK tool objects** via `convertMcpTool()`:
```typescript
function convertMcpTool(mcpTool, client, timeout) → Tool {
    return dynamicTool({
        description: mcpTool.description,
        inputSchema: jsonSchema(schema),
        execute: (args) => client.callTool({ name, arguments: args }, ...)
    })
}
```

Tool names are namespaced: `sanitizedClientName + "_" + sanitizedToolName`

MCP tools are merged into the tool set alongside built-in tools in the `resolveTools()` function (in `prompt.ts`).

### MCP Prompts as Commands

MCP prompts are registered as commands:
```typescript
for (const [name, prompt] of Object.entries(await MCP.prompts())) {
    result[name] = { name, source: "mcp", description, get template() { return MCP.getPrompt(...) } }
}
```

### Permission Integration

MCP tools go through the same permission system as built-in tools — they are wrapped in the AI SDK tool wrapper that includes the `ctx.ask()` permission flow.

### Error Handling

- **Connection failures**: Status set to `{ status: "failed", error: message }`
- **OAuth errors**: `UnauthorizedError` detection → `needs_auth` or `needs_client_registration` status
- **Tool listing failures**: Server marked as failed, client closed
- **Timeout**: `withTimeout()` wrapper with configurable timeout (default 30s)
- **Runtime errors**: `resetTimeoutOnProgress: true` for long-running tool calls
- **Toast notifications**: UI toasts for auth-related issues

### Server Routes

MCP has dedicated HTTP routes (`server/routes/mcp.ts`) for:
- Listing MCP server status
- Managing connections (connect/disconnect)
- OAuth authentication flow

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **MCP Support** | Full (client + server) | None | Full (client only) |
| **SDK/Library** | `rmcp` Rust crate | N/A | `@modelcontextprotocol/sdk` (official TS SDK) |
| **Transport: Stdio** | Yes (TokioChildProcess) | N/A | Yes (StdioClientTransport) |
| **Transport: HTTP** | Yes (StreamableHttp) | N/A | Yes (StreamableHTTP + SSE fallback) |
| **Transport: SSE** | Not separate | N/A | Yes (SSEClientTransport as fallback) |
| **OAuth Support** | Yes (OAuthPersistor, token refresh) | N/A | Yes (McpOAuthProvider, browser flow, PKCE) |
| **Config Format** | TOML (McpServerConfig) | N/A | JSONC (discriminated union: local/remote) |
| **Capabilities: Tools** | Yes (listTools, callTool) | N/A | Yes (listTools, callTool) |
| **Capabilities: Resources** | Yes (listResources, readResource) | N/A | Yes (listResources, readResource) |
| **Capabilities: Prompts** | Not observed | N/A | Yes (listPrompts → commands) |
| **Capabilities: Elicitation** | Yes (CreateElicitation types) | N/A | Not observed |
| **Tool Integration** | ToolHandler trait (ToolKind::Mcp) | N/A | AI SDK dynamicTool wrapper |
| **Tool Naming** | Server-namespaced | N/A | `clientName_toolName` |
| **Permission** | Same approval pipeline (Orchestrator) | N/A | Same ctx.ask() flow |
| **Lifecycle** | MCPConnectionManager, refresh via Op | N/A | Instance.state(), dynamic add/connect/disconnect |
| **Error Handling** | Auth status tracking, process group cleanup | N/A | Status enum, toast notifications, timeout |
| **As MCP Server** | Yes (mcp-server crate) | No | No |
| **Dynamic Refresh** | Op::RefreshMcpServers | N/A | Bus event (ToolsChanged) |
| **Complexity** | Very high (3 crates, OAuth, server mode) | N/A | High (full SDK, OAuth, lifecycle) |

## Open Questions

1. **SDK choice for TypeScript**: opencode uses the official `@modelcontextprotocol/sdk`. For a Bun/TS project, this is the clear choice. Should diligent use it too, or roll its own minimal client?

2. **Transport priority**: opencode tries StreamableHTTP first, falls back to SSE. codex-rs supports all three. What transport should be supported at MVP? Stdio is essential for local tools; HTTP/SSE for remote.

3. **MCP tool naming**: Both projects namespace MCP tool names (server + tool name). This prevents collisions but makes names longer. How should MCP tools be named in the LLM's tool list?

4. **MCP prompts as commands**: opencode's pattern of registering MCP prompts as slash commands is elegant. Should diligent adopt this? It bridges L8 (MCP) and L7 (slash commands).

5. **OAuth complexity**: Both codex-rs and opencode implement full OAuth flows. Is this needed at MVP, or can it be deferred?

6. **MCP server mode**: codex-rs acts as both MCP client and server. Should diligent expose its tools via MCP? This enables IDE integration and inter-agent communication.

7. **Dynamic server management**: Both projects support adding/removing MCP servers at runtime. Is this needed at MVP, or can servers be configured at startup only?

8. **Permission granularity for MCP tools**: Should MCP tools have their own permission rules, or use the same rules as built-in tools? opencode treats them the same; codex-rs has specific MCP handling in the orchestrator.

9. **Connection to D014/D055**: D014 decided on a Map-based tool registry, and D055 deferred extension/plugin scope to L8/L9. MCP tools need to integrate into this registry. How?

10. **Elicitation support**: codex-rs has elicitation types (MCP servers requesting input from the user). This interacts with the approval/TUI layers. Should this be supported?
