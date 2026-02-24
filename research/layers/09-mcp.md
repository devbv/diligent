# Layer 9: MCP (Model Context Protocol)

## Problem Definition

MCP (Model Context Protocol) provides a standardized way for coding agents to integrate with external tools and data sources beyond their built-in capabilities. The core problems are:

1. **Tool extensibility**: How to allow third-party tools to be discovered and invoked by the LLM without modifying the agent's core codebase.
2. **Transport abstraction**: How to communicate with tool servers running as local processes (stdio) or remote HTTP services.
3. **Tool conversion**: How to translate MCP tool definitions into the agent's native tool format so they participate in the existing tool system (L2).
4. **Lifecycle management**: How to start, monitor, and shut down connections to multiple MCP servers.
5. **Configuration integration**: How to specify MCP server configurations in the config system (L5) with appropriate validation.
6. **Permission integration**: How MCP tool invocations interact with the approval system (L4).
7. **Error resilience**: How to handle server startup failures, timeouts, authentication requirements, and runtime errors gracefully.

This is one of the highest-dependency layers. It must integrate with L2 (Tool System) for tool registration, L4 (Approval) for permission checks, L5 (Config) for server configuration, and produces events consumed by L7 (TUI) for status display.

## codex-rs Analysis

### Architecture

codex-rs has the most mature and complex MCP implementation across all three projects. It is organized into three dedicated crates plus core integration code:

- **`codex-rmcp-client`** (crate): Wraps the `rmcp` Rust SDK (v0.15.0) with transport management, OAuth token handling, and process group lifecycle.
- **`codex-mcp-server`** (crate): Exposes codex itself as an MCP server for IDE integration.
- **`core/src/mcp_connection_manager.rs`**: The central orchestrator that manages multiple `RmcpClient` instances and aggregates their tools.
- **`core/src/mcp_tool_call.rs`**: Handles individual MCP tool call execution with approval flow, event emission, and result sanitization.
- **`core/src/tools/handlers/mcp.rs`**: The `McpHandler` implementing the `ToolHandler` trait for MCP tools.

### Key Types/Interfaces

**RmcpClient** (`rmcp-client/src/rmcp_client.rs`):
```rust
pub struct RmcpClient {
    state: Mutex<ClientState>,
}

enum ClientState {
    Connecting { transport: Option<PendingTransport> },
    Ready {
        _process_group_guard: Option<ProcessGroupGuard>,
        service: Arc<RunningService<RoleClient, LoggingClientHandler>>,
        oauth: Option<OAuthPersistor>,
    },
}

enum PendingTransport {
    ChildProcess { transport: TokioChildProcess, process_group_guard: Option<ProcessGroupGuard> },
    StreamableHttp { transport: StreamableHttpClientTransport<reqwest::Client> },
    StreamableHttpWithOAuth { transport: StreamableHttpClientTransport<AuthClient<reqwest::Client>>, oauth_persistor: OAuthPersistor },
}
```

**McpConnectionManager** (`core/src/mcp_connection_manager.rs`):
```rust
pub(crate) struct McpConnectionManager {
    clients: HashMap<String, AsyncManagedClient>,
    server_origins: HashMap<String, String>,
    elicitation_requests: ElicitationRequestManager,
}

pub(crate) struct ToolInfo {
    pub server_name: String,
    pub tool_name: String,
    pub tool: Tool,
    pub connector_id: Option<String>,
    pub connector_name: Option<String>,
}
```

**McpServerTransportConfig** (config types):
```rust
enum McpServerTransportConfig {
    Stdio { command, args, env, env_vars, cwd },
    StreamableHttp { url, http_headers, env_http_headers, bearer_token_env_var },
}

struct McpServerConfig {
    transport: McpServerTransportConfig,
    enabled: bool,
    required: bool,
    startup_timeout_sec: Option<Duration>,
    tool_timeout_sec: Option<Duration>,
    enabled_tools: Option<Vec<String>>,
    disabled_tools: Option<Vec<String>>,
    scopes: Option<...>,
}
```

**Tool integration types** (`core/src/tools/`):
```rust
enum ToolKind { Function, Mcp, Custom }
enum ToolPayload {
    Function { arguments: String },
    Mcp { server: String, tool: String, raw_arguments: String },
    Custom { input: String },
}
enum ToolOutput {
    Function { body, success },
    Mcp { result: Result<CallToolResult, String> },
}
```

### Implementation Details

**Transport handling**: Two constructors on `RmcpClient`:
- `new_stdio_client()`: Spawns a child process via `TokioChildProcess` with piped stdin/stdout. Uses `ProcessGroupGuard` (Unix-only) for cleanup. Environment is sanitized via `create_env_for_mcp_server()`. Program path resolved via platform-specific `program_resolver::resolve()`.
- `new_streamable_http_client()`: Creates HTTP client with optional OAuth. If stored OAuth tokens exist, attempts OAuth transport first. Falls back to plain HTTP with bearer token if OAuth metadata discovery fails.

**Initialization**: The `initialize()` method performs the MCP handshake (spec 2025-06-18). It transitions state from `Connecting` to `Ready`, storing the `RunningService` and optionally the `OAuthPersistor`. Timeout is configurable (default 10s startup timeout).

**Tool naming**: Fully qualified name = `"mcp" + "__" + server_name + "__" + tool_name`. Names are sanitized to match `^[a-zA-Z0-9_-]+$` (Responses API requirement). SHA1 hash suffix used when names exceed 64 characters.

**Tool filtering**: Per-server `enabled_tools` (allowlist) and `disabled_tools` (denylist). The `ToolFilter` struct applies both: a tool must be in the enabled set (if present) AND not in the disabled set.

**Connection lifecycle**: `McpConnectionManager::new()` starts all configured servers in parallel using `JoinSet`. Each server gets an `AsyncManagedClient` wrapping a shared future. Status events (`McpStartupUpdate`, `McpStartupComplete`) emitted for TUI display. A `CancellationToken` enables graceful shutdown.

**Startup caching**: For the special "codex_apps" MCP server, tools are cached to disk with a per-user key. `startup_snapshot` provides immediate tool availability while the real connection initializes in background.

**Tool call flow** (`mcp_tool_call.rs`):
1. Parse arguments from JSON string.
2. Look up tool metadata (annotations, connector info).
3. Apply app tool policy (enabled/disabled, approval mode).
4. Request approval if needed (MCP-specific approval UI with Accept/Accept+Remember/Deny/Cancel).
5. Emit `McpToolCallBegin` event.
6. Call `session.call_tool(server, tool_name, arguments)` via `McpConnectionManager`.
7. Sanitize result (strip images if model doesn't support image input).
8. Emit `McpToolCallEnd` event.
9. Return `ResponseInputItem::McpToolCallOutput`.

**MCP approval system**: MCP tools use `ToolAnnotations` (destructive_hint, open_world_hint, read_only_hint) to determine if approval is needed. Approval decisions can be remembered per-session. Three approval modes: `Approve` (always auto-approve), `Auto` (check annotations), `Prompt` (always ask).

**Elicitation**: MCP servers can request user input via `CreateElicitationRequestParams`. The `ElicitationRequestManager` routes these to the UI via events and `oneshot` channels. Policy-based: elicitation rejected when approval policy is `Never`.

**Custom capabilities**: Supports a `codex/sandbox-state` custom MCP method for notifying servers about sandbox configuration. Server must declare capability support in initialization.

**Resources**: Full support for `listResources()`, `readResource()`, `listResourceTemplates()` with pagination via cursors.

### Layer Boundaries

- **L2 (Tool System)**: MCP tools registered via `McpHandler` implementing `ToolHandler`. Dedicated `ToolKind::Mcp`, `ToolPayload::Mcp`, and `ToolOutput::Mcp` variants.
- **L4 (Approval)**: MCP tool calls go through a dedicated approval flow using `ToolAnnotations`. Elicitation requests also interact with approval policy.
- **L5 (Config)**: `McpServerConfig` in TOML config under `mcp_servers` key. Per-server transport, timeouts, tool filtering.
- **L1 (Agent Loop)**: MCP tools appear in the LLM's tool list alongside built-in tools. `McpToolCallOutput` is a response input item variant.
- **L7 (TUI)**: Events: `McpStartupUpdate`, `McpStartupComplete`, `McpToolCallBegin`, `McpToolCallEnd`, `ElicitationRequest`.

---

## pi-agent Analysis

### Architecture

pi-agent has **no built-in MCP support**. There is no MCP client, no MCP server configuration, and no MCP protocol integration anywhere in the codebase. The only references to "MCP" found were in documentation/README files and a test fixture that mentioned it as a potential config field.

### Key Types/Interfaces

Not applicable. No MCP types exist.

### Implementation Details

pi-agent uses its **extension system** as the primary extensibility mechanism. Extensions can register tools via `pi.registerTool()`, commands, and UI elements. This serves a similar purpose to MCP but with a fundamentally different architecture:

- Extensions are loaded at startup from configured directories.
- Extensions run in-process (same Node.js runtime), not as separate servers.
- The `ExtensionAPI` provides hooks for tool registration, UI rendering, and context access.
- No standardized protocol; extensions directly use TypeScript APIs.

If MCP support were needed, it would be implemented as an extension that:
1. Reads MCP server config from settings.
2. Spawns/connects to MCP servers.
3. Converts MCP tools to pi-agent tools via `pi.registerTool()`.
4. Routes tool calls through the MCP client.

### Layer Boundaries

Since MCP doesn't exist in pi-agent, the extension system fills this role:
- **L2 equivalent**: `pi.registerTool()` adds tools to the tool registry.
- **L5 equivalent**: Extension config in settings JSON.
- No standardized transport, lifecycle, or tool conversion.

---

## opencode Analysis

### Architecture

opencode has a comprehensive MCP implementation using the official `@modelcontextprotocol/sdk` TypeScript package. The implementation is contained in a single `MCP` namespace (`src/mcp/index.ts`) with supporting modules for OAuth:

- **`src/mcp/index.ts`**: Core MCP namespace with `create()`, `connect()`, `disconnect()`, `tools()`, `prompts()`, `resources()`.
- **`src/mcp/oauth-provider.ts`**: `McpOAuthProvider` implementing OAuth flow for remote servers.
- **`src/mcp/auth.ts`**: `McpAuth` for token storage and management.
- **`src/mcp/oauth-callback.ts`**: HTTP callback server for OAuth redirect handling.

### Key Types/Interfaces

**Config types** (`src/config/config.ts`):
```typescript
const McpLocal = z.object({
    type: z.literal("local"),
    command: z.string().array(),
    environment: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().optional(),
})

const McpRemote = z.object({
    type: z.literal("remote"),
    url: z.string(),
    enabled: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z.union([z.literal(false), McpOAuth]).optional(),
    timeout: z.number().optional(),
})

const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
```

**Status type** (discriminated union):
```typescript
const Status = z.discriminatedUnion("status", [
    z.object({ status: z.literal("connected") }),
    z.object({ status: z.literal("disabled") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
    z.object({ status: z.literal("needs_auth") }),
    z.object({ status: z.literal("needs_client_registration"), error: z.string() }),
])
```

**Bus events**:
```typescript
const ToolsChanged = BusEvent.define("mcp.tools.changed", z.object({ server: z.string() }))
const BrowserOpenFailed = BusEvent.define("mcp.browser.open.failed", z.object({ mcpName, url }))
```

### Implementation Details

**State management**: Uses `Instance.state()` (a factory for instance-scoped singleton state with cleanup). The state holds `clients: Record<string, MCPClient>` and `status: Record<string, Status>`. On cleanup, all clients are closed.

**Server creation** (`create()` function):
- For **local** servers: Creates `StdioClientTransport` with command, args, cwd (project directory), merged environment. Stderr piped and logged. Wraps in `Client` from SDK, calls `client.connect(transport)` with timeout.
- For **remote** servers: Tries `StreamableHTTPClientTransport` first, then falls back to `SSEClientTransport`. Both support `authProvider` for OAuth. On `UnauthorizedError`, stores transport in `pendingOAuthTransports` map for later `finishAuth()`.

**Connection timeout**: Default 30 seconds. Configurable per-server via `timeout` config field. Uses `withTimeout()` wrapper.

**Tool conversion** (`convertMcpTool()`):
```typescript
async function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Promise<Tool> {
    const schema: JSONSchema7 = {
        ...inputSchema,
        type: "object",
        properties: inputSchema.properties ?? {},
        additionalProperties: false,
    }
    return dynamicTool({
        description: mcpTool.description ?? "",
        inputSchema: jsonSchema(schema),
        execute: (args) => client.callTool({ name, arguments: args }, CallToolResultSchema, {
            resetTimeoutOnProgress: true,
            timeout,
        }),
    })
}
```

**Tool naming**: `sanitizedClientName + "_" + sanitizedToolName` where sanitization replaces non-alphanumeric characters (except `_` and `-`) with `_`.

**Tool listing** (`tools()` function): Iterates all connected clients, calls `client.listTools()`, converts each to AI SDK `Tool`. Status updated to `failed` if listing throws. Failed clients removed from state.

**Prompts**: MCP prompts fetched via `client.listPrompts()` and exposed with namespaced keys (`clientName:promptName`). These integrate with the command system as slash commands.

**Resources**: MCP resources listed via `client.listResources()` and exposed for reading via `readResource()`.

**Notification handling**: Registers handler for `ToolListChangedNotification` which publishes `ToolsChanged` bus event. This triggers tool refresh in the prompt builder.

**OAuth flow**:
1. `startAuth()`: Creates `McpOAuthProvider`, creates transport, tries to connect. On `UnauthorizedError`, captures authorization URL.
2. `authenticate()`: Opens browser with authorization URL, waits for OAuth callback via `McpOAuthCallback` HTTP server, calls `finishAuth()`.
3. `finishAuth()`: Calls `transport.finishAuth(authorizationCode)`, then reconnects.
4. Supports PKCE (handled by SDK), CSRF protection via state parameter.
5. Tokens stored via `McpAuth` module.

**Dynamic management**: Runtime `add()`, `connect()`, `disconnect()` methods. Properly closes existing clients before replacement to prevent memory leaks.

**Error handling**:
- Connection failures: Status set to `failed` with error message.
- OAuth errors: `UnauthorizedError` detection, separate states for `needs_auth` vs `needs_client_registration`.
- Tool listing failures: Server marked as failed, client closed and removed.
- Tool call failures: `resetTimeoutOnProgress: true` prevents timeout during slow operations.
- Toast notifications via bus events for authentication issues.

### Layer Boundaries

- **L2 (Tool System)**: MCP tools converted to AI SDK `Tool` objects via `dynamicTool()`. Merged into tool set in `resolveTools()` function in `prompt.ts`.
- **L4 (Approval)**: MCP tools go through the same `ctx.ask()` permission flow as built-in tools. No MCP-specific approval differentiation.
- **L5 (Config)**: `mcp` config key with discriminated union (`McpLocal | McpRemote`). Validated via Zod schema.
- **L1 (Agent Loop)**: MCP tools appear alongside built-in tools in AI SDK tool definitions.
- **L7 (TUI)**: Status display via MCP status endpoint. Toast notifications for auth issues. Server management UI (connect/disconnect).
- **L8 (Skills/Commands)**: MCP prompts registered as slash commands.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **MCP Support** | Full (client + server) | None | Full (client only) |
| **SDK/Library** | `rmcp` Rust crate (v0.15.0) | N/A | `@modelcontextprotocol/sdk` (official TS SDK) |
| **Protocol Version** | 2025-06-18 | N/A | Latest (via SDK) |
| **Transport: Stdio** | `TokioChildProcess`, process group cleanup | N/A | `StdioClientTransport`, stderr piped |
| **Transport: HTTP** | `StreamableHttpClientTransport` | N/A | `StreamableHTTPClientTransport` (primary) |
| **Transport: SSE** | Not separate (part of StreamableHttp) | N/A | `SSEClientTransport` (fallback) |
| **OAuth** | Full (`OAuthPersistor`, token refresh) | N/A | Full (`McpOAuthProvider`, browser flow, PKCE, callback server) |
| **Config Format** | TOML (`McpServerConfig` with transport enum) | N/A | JSONC (Zod discriminated union: `local`/`remote`) |
| **Config Features** | enabled, required, startup_timeout, tool_timeout, enabled/disabled_tools, scopes | N/A | enabled, timeout, headers, oauth config |
| **Capabilities: Tools** | Yes (`listTools`, `callTool`, pagination) | N/A | Yes (`listTools`, `callTool`) |
| **Capabilities: Resources** | Yes (`listResources`, `readResource`, templates, pagination) | N/A | Yes (`listResources`, `readResource`) |
| **Capabilities: Prompts** | Not observed | N/A | Yes (`listPrompts` -> slash commands) |
| **Capabilities: Elicitation** | Yes (form + url types, policy-based) | N/A | Not observed |
| **Tool Naming** | `mcp__server__tool` (64 char max, SHA1 suffix) | N/A | `client_tool` (sanitized) |
| **Tool Filtering** | Per-server allowlist + denylist | N/A | None |
| **Tool Integration** | `ToolHandler` trait, `ToolKind::Mcp` | N/A | AI SDK `dynamicTool()` wrapper |
| **Approval** | MCP-specific approval (annotations-based, remember per session) | N/A | Same `ctx.ask()` as built-in tools |
| **Lifecycle** | `McpConnectionManager`, `AsyncManagedClient`, cancellation token | N/A | `Instance.state()`, dynamic add/connect/disconnect |
| **Startup** | Parallel via `JoinSet`, status events, startup snapshot cache | N/A | Parallel via `Promise.all()` |
| **Error Handling** | Auth status tracking, process group cleanup, timeout, metrics | N/A | Status enum, toast notifications, timeout |
| **MCP Server Mode** | Yes (`mcp-server` crate) | No | No |
| **Dynamic Refresh** | Not observed (tools cached from startup) | N/A | `ToolListChangedNotification` -> bus event |
| **Custom Capabilities** | `codex/sandbox-state` custom method | N/A | None |
| **Tool Call Events** | `McpToolCallBegin/End` with duration, invocation details | N/A | None (uses standard tool events) |
| **Complexity** | Very high (3 crates, OAuth, elicitation, caching, metrics) | N/A | High (full SDK, OAuth, lifecycle) |

## Synthesis

### Common Patterns

1. **Official SDK usage**: Both implementing projects use the official MCP SDK for their language (Rust: `rmcp`, TypeScript: `@modelcontextprotocol/sdk`). Neither rolls their own protocol handling.

2. **Transport layering**: Both support stdio (local) and StreamableHTTP (remote). opencode adds SSE as a fallback. The pattern is: local = child process with piped stdio, remote = HTTP with optional auth.

3. **Tool name sanitization**: Both sanitize MCP tool names for API compatibility (`^[a-zA-Z0-9_-]+$`), using server name as namespace prefix to avoid collisions.

4. **Parallel startup**: Both start all configured MCP servers in parallel (`JoinSet` / `Promise.all()`) for fast initialization.

5. **OAuth integration**: Both implement full OAuth flows for remote servers. codex-rs uses persistent token storage with automatic refresh. opencode uses a browser-based flow with callback server.

6. **Status tracking**: Both maintain per-server status with multiple states (connected, failed, needs_auth, disabled).

7. **Graceful degradation**: Both handle server failures gracefully, allowing the agent to continue with available servers. codex-rs has startup snapshot caching for ultra-fast startup.

### Key Differences

1. **Approval granularity**: codex-rs has MCP-specific approval using `ToolAnnotations` (destructive_hint, open_world_hint). opencode treats MCP tools identically to built-in tools through `ctx.ask()`.

2. **Prompts integration**: opencode registers MCP prompts as slash commands, bridging MCP with the command system. codex-rs does not expose MCP prompts.

3. **Tool filtering**: codex-rs supports per-server allowlist/denylist of tools. opencode exposes all tools from each server.

4. **Elicitation**: codex-rs supports MCP elicitation (servers requesting user input), with policy-based control. opencode does not.

5. **MCP server mode**: codex-rs can also act as an MCP server. opencode is client-only.

6. **Event granularity**: codex-rs emits dedicated `McpToolCallBegin/End` events with timing data. opencode uses standard tool events.

7. **Caching**: codex-rs implements disk-based tool caching for the codex_apps server. opencode fetches tools fresh each time.

8. **Notification handling**: opencode handles `ToolListChangedNotification` for dynamic tool refresh. codex-rs does not appear to handle this notification.

### Best Practices Identified

1. **Use official SDK**: Building on the official MCP SDK avoids reimplementing protocol details and ensures spec compliance.

2. **Discriminated config union**: opencode's `type: "local" | "remote"` discriminated union is cleaner than codex-rs's transport enum for config ergonomics.

3. **Startup snapshot pattern**: codex-rs's startup snapshot caching is excellent for perceived performance but adds complexity. Worth considering for MVP only if startup latency is a problem.

4. **Tool annotation-based approval**: codex-rs's approach of using MCP `ToolAnnotations` for approval decisions is more principled than treating all MCP tools the same.

5. **Process group cleanup**: codex-rs's `ProcessGroupGuard` pattern ensures child processes are properly terminated. Essential for stdio transport reliability.

6. **Timeout on progress**: opencode's `resetTimeoutOnProgress: true` prevents premature timeouts for slow but active operations. Important for MCP tools that stream progress.

7. **Tool filtering**: codex-rs's per-server tool allowlist/denylist prevents unwanted tools from being exposed to the LLM. Important for security when connecting to untrusted MCP servers.

## Open Questions

1. **SDK choice**: The official `@modelcontextprotocol/sdk` is the clear choice for TypeScript. Should diligent use it directly or wrap it in a thin abstraction layer?

2. **Transport at MVP**: Stdio (local) is essential. StreamableHTTP is needed for remote servers. SSE fallback adds complexity for minimal gain. What transports at MVP?

3. **OAuth at MVP**: Full OAuth is complex (callback server, token persistence, PKCE). Can this be deferred to post-MVP with bearer token support as the initial remote auth mechanism?

4. **Elicitation support**: codex-rs supports MCP elicitation. This interacts with approval (L4) and TUI (L7). Should this be deferred?

5. **MCP prompts as commands**: opencode's pattern of registering MCP prompts as slash commands bridges L9 and L7/L8. Should diligent adopt this at MVP?

6. **Tool annotations for approval**: Should MCP tools use ToolAnnotations for approval decisions (like codex-rs) or go through the standard permission system (like opencode)?

7. **Tool filtering**: Should diligent support per-server enabled/disabled tool lists? This adds security but also configuration complexity.

8. **Dynamic tool refresh**: Should diligent handle `ToolListChangedNotification` to refresh tools at runtime, or only load tools at startup?

9. **MCP server mode**: Should diligent expose itself as an MCP server? This enables IDE integration but is a large scope addition.

10. **Connection to L2**: MCP tools must register in the tool registry (D014 Map-based). Should they use a dedicated `ToolKind` (like codex-rs) or be converted to standard tool objects (like opencode)?
