# MCP servers

Diligent can connect to external [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers and expose each server's tools to the agent as normal tools. This works on every client (TUI, Web, VS Code) with no per-client code — MCP tools flow through the same tool loop, approval gating, and rendering as built-in tools.

Diligent acts as an MCP **client** only. It consumes tools, resources, and prompts from external servers; it does not expose itself as an MCP server.

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

## Tool loading (eager vs lazy)

By default every enabled tool from every connected server is exposed to the model as its own function (`mcp__<server>__<tool>`), with its full input schema. This is fine for a few servers, but the per-turn context cost grows with the number of tools. To keep that cost roughly flat as you add servers, Diligent can switch to a **lazy** surface that exposes only two proxy tools:

- `mcp_search_tools` — discover tools and get their input schemas on demand. Call it with no arguments to list everything, a `query` to keyword-search, or a `server` to scope. Its description also carries a compact `server → tool names` index so the model always knows what exists.
- `mcp_run_tool` — invoke a discovered tool by `server` + `tool`, passing the tool's `args`. Approval and result handling are identical to the eager per-tool path.

Configure this globally under a top-level `mcp` object:

```jsonc
{
  "mcp": {
    // "auto" (default): eager until the exposed tool count exceeds `lazyThreshold`, then lazy.
    // "eager": always one function per tool. "lazy": always the search + run proxies.
    "toolLoading": "auto",
    "lazyThreshold": 20
  }
}
```

Notes:

- `auto` keeps small setups unchanged (behaves exactly like `eager` below the threshold) and only switches large multi-server setups to the lazy surface.
- Per-server `enabled` and per-tool `tools` toggles still apply in both modes — disabled tools never appear in search results or become callable.
- Lazy mode uses proxy execution (the model calls `mcp_run_tool`), so provider-native tool-schema validation is deferred to the server; the schema returned by `mcp_search_tools` tells the model the exact argument shape.

## Output size

Large tool outputs are capped so a single call cannot flood the context window. Each MCP tool's output is limited to roughly `maxOutputTokens` (default 25,000, matching Claude Code) and a console warning is logged past `warnOutputTokens` (default 10,000). Output over the cap is truncated by the executor's safety net (full output is still saved to disk). A server can raise the cap for a legitimately large tool by advertising `anthropic/maxResultSizeChars` in that tool's MCP `_meta`.

```jsonc
{
  "mcp": {
    "maxOutputTokens": 25000,
    "warnOutputTokens": 10000
  }
}
```

Token limits are applied as an approximate byte budget (~4 bytes/token). The per-tool `anthropic/maxResultSizeChars` override is a character count and takes precedence over `maxOutputTokens` for that tool.

## Resources and prompts

Beyond tools, MCP servers can expose **resources** (readable documents/data) and **prompts** (parameterized message templates). When a connected server advertises these capabilities, Diligent adds proxy tools the model can use on demand:

- `mcp_list_resources` / `mcp_read_resource` — enumerate resources and read one by URI.
- `mcp_list_prompts` / `mcp_get_prompt` — enumerate prompt templates and render one with arguments.

The `list` tools are read-only; `mcp_read_resource` and `mcp_get_prompt` route through the standard execute approval. These tools appear only for servers that support the capability, and can be turned off globally:

```jsonc
{
  "mcp": {
    "resources": false,
    "prompts": false
  }
}
```

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
