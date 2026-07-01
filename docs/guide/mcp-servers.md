# MCP servers

Diligent can connect to external [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers and expose each server's tools to the agent as normal tools. This works on every client (TUI, Web, VS Code) with no per-client code — MCP tools flow through the same tool loop, approval gating, and rendering as built-in tools.

Diligent acts as an MCP **client** only. It consumes tools from external servers; it does not expose itself as an MCP server, and it does not consume MCP resources or prompts (tools only).

## Configuration

Declare servers under a top-level `mcpServers` map in `~/.diligent/config.jsonc` (global) or `.diligent/config.jsonc` (project). The two layers are deep-merged, so a project can add or override individual servers.

```jsonc
{
  "mcpServers": {
    // Local subprocess (stdio transport)
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
    },
    // Remote server (Streamable HTTP, falls back to SSE)
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" }
    }
  }
}
```

`{env:VAR}` placeholders are substituted from the environment, so secrets never need to be written into the config file.

### stdio servers

| Field | Description |
|-------|-------------|
| `command` | Executable to spawn (required). |
| `args` | Command arguments. |
| `env` | Extra environment variables overlaid on a curated safe default set. The full parent environment is **not** forwarded to the subprocess. |
| `cwd` | Working directory for the subprocess. |

### HTTP servers

| Field | Description |
|-------|-------------|
| `url` | Server endpoint (required). |
| `type` | `"http"` (Streamable HTTP, default) or `"sse"`. |
| `headers` | Static request headers, e.g. a bearer token. |
| `bearerTokenEnvVar` | Name of an env var whose value is sent as `Authorization: Bearer <token>` when no explicit header is set. |
| `oauth` | OAuth options (see below). |

### Shared fields

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Set `false` to disable the whole server. |
| `tools` | — | Per-tool toggle map, e.g. `{ "dangerous_tool": false }`. |
| `startupTimeoutMs` | `30000` | Budget for connect + initial tool listing. |
| `toolTimeoutMs` | `120000` | Per tool-call budget. A hung call aborts instead of stalling the turn. |

## Tool naming

Server tools are namespaced as `mcp__<server>__<tool>` (sanitized to `[a-zA-Z0-9_-]`). Names longer than 64 bytes are truncated with a short stable hash suffix to satisfy provider function-name limits.

## Approval and execution

Every MCP tool call routes through the standard approval host with the `execute` permission. Rejecting a prompt prevents the call. Tools that the server marks read-only (`annotations.readOnlyHint`) are allowed to run in parallel.

## OAuth (remote servers)

For HTTP servers that require OAuth, Diligent supports discovery, interactive browser login, token persistence, and silent refresh. Static `headers` and `{env:VAR}` bearer tokens always take precedence; OAuth is attempted only when no explicit `Authorization` header is configured and `oauth.enabled` is not `false`.

```jsonc
{
  "mcpServers": {
    "acme": {
      "url": "https://mcp.acme.com/mcp",
      "oauth": { "scopes": ["read", "write"] }
    }
  }
}
```

On first use, Diligent opens your browser to complete the login and stores the resulting tokens under `~/.diligent/mcp-oauth/`. Tokens are refreshed automatically before they expire.

## Reliability

- Servers connect in parallel and are isolated: a failing or unreachable server is skipped (its error is logged) and never blocks agent startup or other servers.
- Connections are reused across turns and are only re-established when a server's transport configuration changes or the server is removed.
