---
id: P069
status: active
created: 2026-07-01
---

# MCP Client (Tools)

## Goal

Diligent can connect to external Model Context Protocol (MCP) servers declared in
config and expose each server's tools to the agent as first-class tools. After this,
a user can add an MCP server (stdio or HTTP) to `config.jsonc` and the LLM can call
its tools in the normal tool loop, with approval gating and UI visibility, on every
client (TUI, Web, VS Code) without per-client code.

## Prerequisites

- Existing tool pipeline: `Tool` contract (`packages/core/src/tool/types.ts`), catalog
  builder (`packages/runtime/src/tools/catalog.ts`), and `BundledToolProvider`
  extension point (`packages/runtime/src/tools/bundled-provider.ts`). All present.
- Approval host wiring (`RuntimeToolHost`, `requestToolApproval`). Present.
- Config loader with layered merge + `{env:VAR}` substitution
  (`packages/runtime/src/config/loader.ts`). Present.
- New runtime dependency: `@modelcontextprotocol/sdk` (official MCP client SDK).
- HTTP OAuth support for remote MCP servers: discovery, login initiation, token persistence, refresh.

## Artifact

`~/.diligent/config.jsonc` (or project `.diligent/config.jsonc`):

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
    },
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" }
    }
  }
}
```

```
User -> "search the github repo for open PRs touching the loop"
Agent -> calls tool mcp__github__search_issues { q: "..." }   (approval prompt: execute)
Agent -> "Found 3 open PRs: ..."
```

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| packages/core/src/tool | `Tool` gains optional raw `inputSchema` passthrough |
| packages/core/src/agent | `toFunctionToolDefinition` prefers `tool.inputSchema` over `zodToJsonSchema` |
| packages/runtime/src/config | New top-level `mcpServers` config schema |
| packages/runtime/src/tools/mcp | New module: connection manager, tool bridge, OAuth, provider |
| packages/runtime/src/tools/defaults | Construct MCP provider from config, merge into bundled providers |
| packages/runtime/src/app-server | Thread `mcpServers` into agent + tools-list handlers |
| packages/runtime/package.json | Add `@modelcontextprotocol/sdk` dependency |

### What does NOT change

- **No MCP server mode** - Diligent does not expose itself as an MCP server (backlog).
- **No Resources or Prompts** - only MCP `tools/*` is consumed. Resource/prompt
  discovery is out of scope (backlog).
- **HTTP OAuth is included in first implementation scope** for remote MCP servers. Static headers /
  `{env:VAR}` bearer tokens remain supported as the simple/manual path.
- **No per-tool toggle UI plumbing beyond config** - enable/disable is honored from
  `config.mcpServers[name].enabled` and `.tools`, but the runtime tools-set RPC does
  not yet write MCP toggles (read-only visibility in v1).
- **No new client UI components** - MCP tools render through the existing generic
  tool-call rendering path.

## File Manifest

### packages/core/src/tool/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | MODIFY | Add optional `inputSchema?: Record<string, unknown>` to `Tool` |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|------------|
| `assistant.ts` | MODIFY | `toFunctionToolDefinition` uses `tool.inputSchema` when present |

### packages/runtime/src/config/

| File | Action | Description |
|------|--------|------------|
| `schema.ts` | MODIFY | Add `mcpServers` record + `McpServerConfig` union; export type |

### packages/runtime/src/tools/mcp/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | CREATE | Internal MCP config/tool types re-exported from schema |
| `client.ts` | CREATE | `McpConnectionManager` - connect/list/call, signature-keyed reuse |
| `to-tool.ts` | CREATE | Convert MCP tool def -> Diligent `Tool` (schema passthrough, approval, result map) |
| `provider.ts` | CREATE | `createMcpToolProvider(config)` -> `BundledToolProvider` |
| `oauth.ts` | CREATE | HTTP OAuth discovery/login/token-store/refresh support |
| `index.ts` | CREATE | Public exports |

### packages/runtime/src/tools/

| File | Action | Description |
|------|--------|------------|
| `defaults.ts` | MODIFY | `BuildDefaultToolsOptions.mcpServers`; append MCP provider to bundled providers |
| `index.ts` | MODIFY | Export MCP module surface |

### packages/runtime/src/app-server/

| File | Action | Description |
|------|--------|------------|
| `factory.ts` | MODIFY | Pass `runtimeConfig.diligent.mcpServers` to `buildDefaultTools` |
| `thread-handlers.ts` | MODIFY | Expose `getMcpServers()` on handler context |
| `tool-handlers.ts` | MODIFY | Pass mcp config into tools-list/set `buildDefaultTools` |

### packages/runtime/src/config/

| File | Action | Description |
|------|--------|------------|
| `runtime.ts` | MODIFY | Pass `config.mcpServers` to agents-discovery `buildDefaultTools` (knownToolNames) |

### packages/runtime/

| File | Action | Description |
|------|--------|------------|
| `package.json` | MODIFY | Add `@modelcontextprotocol/sdk` dependency |

### packages/runtime/test/tools/mcp/

| File | Action | Description |
|------|--------|------------|
| `to-tool.test.ts` | CREATE | Schema passthrough, approval reject, result mapping |
| `client.test.ts` | CREATE | Connection reuse/dispose by signature, list caching, error capture (fake transport) |
| `provider.test.ts` | CREATE | Provider filters disabled servers/tools, namespaced names |
| `oauth.test.ts` | CREATE | OAuth discovery, token loading/refresh, auth header selection |

## Implementation Tasks

### Task 1: Raw JSON-Schema passthrough in core

**Files:** `packages/core/src/tool/types.ts`, `packages/core/src/agent/assistant.ts`
**Decisions:** D013 (Tool definition)

MCP servers advertise tool inputs as JSON Schema. The core currently derives the
LLM-facing schema from a Zod object via `zodToJsonSchema`. Add an optional raw schema
that, when set, is sent verbatim - additive and backward-compatible (mirrors the
existing `web_action` special-case already in `toToolDefinition`).

```typescript
// packages/core/src/tool/types.ts
export interface Tool<TParams extends z.ZodType = any> {
  name: string;
  description: string;
  parameters: TParams;
  /** When set, this raw JSON Schema is advertised to the LLM instead of deriving
   *  it from `parameters`. Used by tools whose schema is not Zod-authored (e.g. MCP). */
  inputSchema?: Record<string, unknown>;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
  supportParallel?: boolean;
  parseArgs?: (raw: unknown) => z.infer<TParams>;
}
```

```typescript
// packages/core/src/agent/assistant.ts
function toFunctionToolDefinition(
  tool: Pick<Tool, "name" | "description" | "parameters" | "inputSchema">,
): FunctionToolDefinition {
  const schema = tool.inputSchema
    ? tool.inputSchema
    : (() => {
        const { $schema, ...rest } = zodToJsonSchema(tool.parameters) as Record<string, unknown>;
        return rest;
      })();
  return { kind: "function", name: tool.name, description: tool.description, inputSchema: schema };
}
```

**Verify:** Existing tool tests still pass; a Tool with `inputSchema` set emits that
schema verbatim (unit test in core, or covered by `to-tool.test.ts`).

### Task 2: `mcpServers` config schema

**Files:** `packages/runtime/src/config/schema.ts`
**Decisions:** D033/D034 (config layering)

```typescript
const McpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const McpHttpServerSchema = z.object({
  type: z.enum(["http", "sse"]).optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const McpServerConfigSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// inside DiligentConfigSchema object:
mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
```

Notes: `mcpServers` merges across global < project via the existing deep object merge
(unlike `tools`, which is global-only). `{env:VAR}` substitution already applies to
all string values, so headers/env can reference secrets.

**Verify:** Loader parses the Artifact example without warnings; project override
adds/replaces a server key.

### Task 3: MCP connection manager

**Files:** `packages/runtime/src/tools/mcp/client.ts`, `packages/runtime/src/tools/mcp/types.ts`

A module-level singleton keyed by a stable signature of each server's resolved config.
Connections (stdio process / HTTP session) persist across turns; only servers whose
signature changed are reconnected, and removed servers are disposed. Never throws -
per-server failures are captured and surfaced as `error` on the server entry.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface McpToolDef {
  name: string;                       // raw server tool name
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerRuntime {
  name: string;                       // config key
  status: "connected" | "error" | "disabled";
  tools: McpToolDef[];
  error?: string;
}

export interface McpCallResult {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

export class McpConnectionManager {
  /** Reconcile active connections against desired config; connect/dispose as needed. */
  async sync(servers: Record<string, McpServerConfig>): Promise<McpServerRuntime[]>;
  /** Call a tool on a connected server. Throws only if server is not connected. */
  async call(serverName: string, toolName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
  async disposeAll(): Promise<void>;
}

export function getMcpManager(): McpConnectionManager; // process singleton
```

- Signature = hash of `{type, command, args, env, cwd, url, headers}` (excludes
  `enabled`/`tools`, which are applied downstream as filters).
- `sync` connects each enabled server with a bounded timeout (`timeoutMs`, default
  ~15s), runs `client.listTools()` once, caches the result on the entry.
- Transport selection: `command` -> stdio; `url` -> Streamable HTTP, falling back to
  SSE on the documented 4xx handshake failure.

**Verify:** `client.test.ts` with a fake in-memory transport asserts: connect once ->
reuse on identical signature; changed signature -> dispose+reconnect; failing server ->
`status: "error"` with message, others unaffected.

### Task 4: MCP tool -> Diligent `Tool` bridge

**Files:** `packages/runtime/src/tools/mcp/to-tool.ts`
**Decisions:** D013, D027 (approval)

```typescript
export function mcpToolToDiligentTool(args: {
  serverName: string;
  def: McpToolDef;
  manager: McpConnectionManager;
  host?: RuntimeToolHost;
}): Tool {
  const toolName = mcpToolName(args.serverName, args.def.name); // mcp__<server>__<tool>, sanitized
  return {
    name: toolName,
    description: args.def.description ?? `MCP tool ${args.def.name} from ${args.serverName}`,
    parameters: z.object({}).passthrough(),
    inputSchema: args.def.inputSchema,
    parseArgs: (raw) => (raw ?? {}) as Record<string, unknown>,
    async execute(rawArgs, ctx) {
      const decision = await requestToolApproval(args.host, {
        permission: "execute",
        toolName,
        description: `Call MCP tool ${args.def.name} on server "${args.serverName}"`,
        details: { server: args.serverName, tool: args.def.name, args: rawArgs },
      });
      if (decision === "reject") return { output: "Rejected by user." };
      const res = await args.manager.call(args.serverName, args.def.name, rawArgs, ctx.signal);
      return {
        output: res.text || (res.isError ? "MCP tool returned an error." : ""),
        outputImages: res.images.map((i) => ({ /* ImageBlock */ })),
        metadata: { mcpServer: args.serverName, mcpTool: args.def.name, isError: res.isError },
      };
    },
  };
}
```

- `mcpToolName` sanitizes to `[a-zA-Z0-9_-]` and namespaces per server to avoid
  collisions with builtins and across servers.
- Result mapping: MCP `CallToolResult.content` text parts joined into `output`; image
  parts mapped to `outputImages` (`ImageBlock`); `isError` recorded in metadata.

**Verify:** `to-tool.test.ts` - `inputSchema` is advertised verbatim (via
`toToolDefinition`), reject short-circuits without calling manager, text+image results
map correctly.

### Task 5: MCP bundled provider + defaults wiring

**Files:** `packages/runtime/src/tools/mcp/provider.ts`, `packages/runtime/src/tools/mcp/index.ts`,
`packages/runtime/src/tools/defaults.ts`, `packages/runtime/src/tools/index.ts`
**Decisions:** P067 (bundled product tool providers)

```typescript
// provider.ts
export function createMcpToolProvider(servers: Record<string, McpServerConfig>): BundledToolProvider {
  return {
    id: "mcp",
    displayName: "MCP Servers",
    async createTools({ host }) {
      const manager = getMcpManager();
      const enabled = filterEnabledServers(servers);       // drop enabled:false
      const runtimes = await manager.sync(enabled);
      const tools: Tool[] = [];
      for (const rt of runtimes) {
        if (rt.status !== "connected") continue;            // errors logged, skipped
        const toolToggles = servers[rt.name].tools ?? {};
        for (const def of rt.tools) {
          if (toolToggles[def.name] === false) continue;    // per-tool disable
          tools.push(mcpToolToDiligentTool({ serverName: rt.name, def, manager, host }));
        }
      }
      return tools;
    },
  };
}
```

```typescript
// defaults.ts - BuildDefaultToolsOptions gains:
mcpServers?: DiligentConfig["mcpServers"];

// inside buildDefaultTools, before buildToolCatalog:
const providers = [...(bundledToolProviders ?? [])];
if (mcpServers && Object.keys(mcpServers).length > 0) {
  providers.push(createMcpToolProvider(mcpServers));
}
// pass `providers` as bundledProviders to buildToolCatalog
```

The provider is cheap to recreate each turn; persistence lives in the singleton
manager. Per-server/per-tool enablement is applied inside the provider (v1), so the
catalog needs no toggle changes.

**Verify:** `provider.test.ts` - disabled server yields no tools; `tools:{x:false}`
drops only `x`; names are `mcp__<server>__<tool>`.

### Task 6: App-server + runtime plumbing

**Files:** `packages/runtime/src/app-server/factory.ts`,
`packages/runtime/src/app-server/thread-handlers.ts`,
`packages/runtime/src/app-server/tool-handlers.ts`,
`packages/runtime/src/config/runtime.ts`

- `factory.ts createRuntimeAgent`: add `mcpServers: runtimeConfig.diligent.mcpServers`
  to the `buildDefaultTools` call.
- `thread-handlers.ts`: add `getMcpServers: () => DiligentConfig["mcpServers"]` to the
  handler context; wire it in `server.ts` alongside `getBundledToolProviders`.
- `tool-handlers.ts`: pass `mcpServers: ctx.getMcpServers()` in both `buildDefaultTools`
  calls so the tools list reflects MCP tools.
- `runtime.ts` agents-discovery call: pass `mcpServers: config.mcpServers` so
  `knownToolNames` includes MCP tool names for agent validation.
- Child agents (`collab/registry.ts`) require **no** change: they inherit built parent
  tools via `parentToolOverride`, so MCP tools already flow through and are filtered by
  `allowedChildToolNames`.

**Verify:** With a configured server, `tools/list` RPC includes the namespaced MCP
tools; a normal turn can invoke one end-to-end.

### Task 7: HTTP OAuth for remote MCP servers

**Files:** `packages/runtime/src/tools/mcp/oauth.ts`, `packages/runtime/src/config/schema.ts`,
`packages/runtime/test/tools/mcp/oauth.test.ts`

Add first-pass HTTP OAuth support for Streamable HTTP/SSE servers. Static `headers` and
`{env:VAR}` bearer tokens take precedence; OAuth is used when no explicit authorization
header is configured.

```typescript
const McpOAuthConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  resource: z.string().optional(),
});

const McpHttpServerSchema = z.object({
  type: z.enum(["http", "sse"]).optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  bearerTokenEnvVar: z.string().optional(),
  oauth: McpOAuthConfigSchema.optional(),
  // ...shared fields
});
```

Implementation scope:

- discover authorization server metadata from the MCP server / protected resource metadata where supported;
- start an interactive browser login flow when no valid token exists;
- persist access/refresh tokens in the existing auth storage/keyring-backed infrastructure where possible;
- refresh expired tokens before connecting/calling;
- fall back to unauthenticated only when OAuth is disabled or metadata is unavailable;
- surface actionable setup errors instead of silently hiding auth failures.

**Verify:** OAuth tests cover explicit header precedence, stored token use, refresh, and
missing/invalid credentials. Manual verification with one OAuth-protected HTTP MCP server.

### Task 8: Dependency + docs

**Files:** `packages/runtime/package.json`, `docs/guide/*` (MCP usage note)

- Add `@modelcontextprotocol/sdk` to runtime dependencies; `bun install`.
- Add a short usage section (config shape, stdio vs http, `{env:VAR}` secrets,
  approval behavior).

**Verify:** `bun install` resolves; typecheck passes; guide documents the Artifact.

## Acceptance Criteria

1. `bun test` - all tests pass, including new `mcp/*` tests.
2. A stdio MCP server declared in config exposes its tools as `mcp__<server>__<tool>`
   and the LLM can call one successfully in a normal turn.
3. An HTTP (Streamable, SSE fallback) MCP server works equivalently, including OAuth-protected servers.
4. A failing/unreachable server does not crash agent creation; its tools are absent and
   the error is logged; other servers remain usable.
5. MCP tool execution routes through the approval host (`execute` permission); `reject`
   prevents the call.
6. Connections are reused across turns (no per-turn reconnect) and disposed when the
   server is removed or its transport config changes.
7. `enabled: false` and `tools: { name: false }` remove servers/tools respectively.
8. No `any` escape hatches in new code beyond the documented Zod-passthrough boundary.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | schema passthrough, result mapping, approval reject | `bun test` `to-tool.test.ts` |
| Unit | connection reuse/dispose/error capture | `bun test` `client.test.ts` with fake transport |
| Unit | provider filtering + namespacing | `bun test` `provider.test.ts` |
| Integration | end-to-end call via a real stdio sample server | `packages/e2e` scenario (optional, follow-up) |
| Manual | add server to config, run TUI, invoke a tool | Run and verify approval + output |
| Manual | OAuth-protected HTTP server | Run login, persist token, reconnect after restart, refresh expired token |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `@modelcontextprotocol/sdk` Bun compatibility | Blocks transport | Validate stdio+HTTP under Bun early (Task 3 spike); pin a known-good version |
| First-turn latency from connecting on tool build | Slow first turn | Bounded per-server connect timeout; cache tools; reuse across turns |
| stdio child processes leaking | Resource leak | Singleton manager owns lifecycle; dispose on config change |
| Tool-name collisions / invalid charset for providers | Provider rejects tools | Namespace + sanitize to `[a-zA-Z0-9_-]` |
| Untrusted MCP tool side effects | Unwanted actions | Route every call through approval host (`execute`) |
| Bundled batches ignore per-tool toggles in catalog | Toggles not applied | Apply enable/tool filters inside the MCP provider (v1) |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D013 | Tool definition contract | Task 1, Task 4 |
| D027 | Rule-based permission/approval | Task 4 |
| D033/D034 | Config layering & merge | Task 2, Task 6 |
| P067 | Bundled product tool providers | Task 5 |

---

## Additional Considerations (from codex MCP review)

Reviewed `/Users/devbv/git/codex` (codex-rs: `rmcp-client`, `codex-mcp`, `core/src/mcp_tool_call`). The following refine/extend the tasks above. Items marked **[v1]** fold into this plan; **[backlog]** are deferred with a note.

### C1. Two distinct timeouts, not one **[v1]**

codex uses `startup_timeout_sec` (default 30s: connect + first `listTools`) **and** a separate `tool_timeout_sec` (default 300s: per tool call). Our draft only had a connect timeout. A hung MCP tool call would otherwise stall the entire agent turn.

- Split config `timeoutMs` into `startupTimeoutMs` (default ~30s) and `toolTimeoutMs` (default ~120s).
- `McpConnectionManager.call` must race the SDK call against `toolTimeoutMs` and abort on expiry (return an error `ToolResult`, never hang the loop).

### C2. Parallel, non-blocking connect with per-server isolation **[v1]**

codex starts servers concurrently (`JoinSet`), never blocks session init on optional servers, and isolates failures. Our `sync()` should connect enabled servers via `Promise.allSettled` with each bounded by `startupTimeoutMs`; a failing server yields `status:"error"` and is skipped while others proceed. (We already reuse across turns — keep that.)

### C3. Cancellation wired to `ctx.signal` **[v1]**

Pass `ctx.signal` into the SDK `callTool` `RequestOptions` (plus `timeout`). SDK emits `notifications/cancelled` on abort. This lets a user-interrupted turn actually cancel in-flight MCP calls (codex has only timeout-based stops — we can do better cheaply since our tools already receive an `AbortSignal`).

### C4. Tool-name length cap + collision-safe naming **[v1]**

Providers (e.g. OpenAI) cap function names at 64 chars and restrict charset. `mcp__<server>__<tool>` can exceed that. codex sanitizes, then appends a short hash suffix on collision and truncates to 64 bytes.

- Sanitize to `[a-zA-Z0-9_-]`, build `mcp__<server>__<tool>`, and if `>64` bytes, truncate and append a short stable hash.
- **We avoid codex's reverse-parsing complexity**: each wrapped `Tool` closure captures its own `(serverName, rawToolName)`, so call-time routing needs no name-decoding.

### C5. Richer result mapping **[v1]**

MCP `CallToolResult` carries `content[]` (text / image / audio / embedded resource), `structuredContent`, and `isError`. Map:
- text parts → joined `output`;
- image parts → `outputImages` (`ImageBlock`) — already falls back to text-only for image-less providers;
- `structuredContent` → append a compact JSON section to `output` (so structured servers are usable);
- embedded resource → include its text/URI in `output`;
- `isError:true` → prefix/annotate output and set `metadata.isError`.
- Large payloads: rely on the existing executor auto-truncation (D025 `MAX_OUTPUT_BYTES`) rather than a bespoke limiter.

### C6. `readOnlyHint` → `supportParallel` **[v1]**

MCP tool `annotations.readOnlyHint` marks side-effect-free tools. codex maps this to parallel-safe. Set `Tool.supportParallel = annotations?.readOnlyHint === true` so read-only MCP tools can run concurrently. (Approval tuning from `destructiveHint`/`openWorldHint` is **[backlog]**.)

### C7. stdio environment policy **[v1]**

Do **not** blindly pass the full parent environment to spawned stdio servers. Use the SDK's curated default environment plus the config `env` overlay, and apply the existing `filterSensitiveEnv` (from `bash.ts`) to avoid leaking secrets. (codex supports an explicit `env` allow-list; our `env` map + safe defaults is the pragmatic equivalent. Full allow-list is **[backlog]**.)

### C8. Server→client requests: declare none in v1 **[v1]**

MCP servers may request `sampling`, `roots`, or `elicitation`. Since we advertise **no** such client capabilities during `initialize`, conformant servers won't invoke them, so we can't be surprised mid-call. Note: elicitation maps naturally onto our existing `host.ask` primitive — wiring `elicitation → host.ask` is a strong, low-friction future feature. **[backlog]**

### C9. `notifications/tools/list_changed` **[backlog]**

codex fetches tools once at startup and does **not** refresh on `list_changed` (requires restart). We match this in v1: list once per connection, cache. Optionally subscribe to the notification to invalidate the cache — deferred.

### C10. `required` server flag **[backlog]**

codex `required=true` makes non-interactive runs fail fast if a server can't initialize. Useful for CI/`exec`-style flows. Add `required?: boolean` later; v1 always degrades gracefully.

### C11. OAuth for HTTP servers **[v1]**

codex has full OAuth: keyring/file token storage, silent refresh, and an out-of-band `codex mcp login <server>` command, plus a ChatGPT ambient-auth special case. Include OAuth in v1 for remote MCP: static `headers` + `{env:VAR}` bearer tokens still take precedence, but OAuth discovery/login/token storage/refresh is part of the first implementation scope.

### Config schema deltas from these considerations

```typescript
// shared fields on both stdio and http server configs:
startupTimeoutMs: z.number().int().positive().optional(),  // default ~30_000
toolTimeoutMs: z.number().int().positive().optional(),     // default ~120_000
// (replaces the single `timeoutMs` in the Task 2 sketch)
```

### Risk additions

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Hung MCP tool call stalls the turn | Agent appears frozen | Per-call `toolTimeoutMs` + abort on `ctx.signal` (C1, C3) |
| Long/namespaced tool name rejected by provider | Tool silently unusable | 64-byte cap + hash suffix (C4) |
| Full env leaked to untrusted stdio server | Secret exposure | SDK default env + `filterSensitiveEnv` (C7) |
| Server expects elicitation/sampling | Call stalls waiting for capability | Declare no such capabilities in `initialize` (C8) |

### Backlog priority after codex + MCP authorization review

The official MCP authorization spec treats HTTP authorization as a first-class concern: HTTP-based transports should follow the authorization framework, while stdio should retrieve credentials from the environment. Therefore, OAuth is not just a nice-to-have for long-term remote MCP support; it is part of the first implementation scope.

| Priority | Item | Rationale | Suggested Phase |
|----------|------|-----------|-----------------|
| P0 | Per-call `toolTimeoutMs` + abort/cancellation | Prevents a hung MCP tool from freezing an agent turn. Required for safe v1. | v1 |
| P0 | Tool-name cap/collision handling | Provider function-name limits can make MCP tools unusable. Required before broad use. | v1 |
| P0 | Safe stdio env policy | Avoids leaking process secrets to local MCP server subprocesses. Required for safe v1. | v1 |
| P0 | HTTP OAuth (discovery, login, token store, refresh) | Needed for serious remote MCP adoption and spec-aligned HTTP servers. Static headers work for manual use but will fail for many user-scoped servers. | v1 |
| P1 | Elicitation -> `host.ask` | Natural fit with existing user-input primitive; many interactive MCP servers may request clarification/auth-like user input. | v1.1 |
| P2 | `required` fail-fast server flag | Useful for CI/non-interactive workflows; optional for interactive agent UX. | v1.2 |
| P2 | `notifications/tools/list_changed` refresh | Improves long-lived server correctness, but codex also defers this; restart/reconnect is acceptable initially. | v1.2 |
| P2 | Approval tuning from MCP annotations | `destructiveHint`/`openWorldHint` can improve prompts and policy, but basic execute approval is safe enough for v1. | v1.2 |
| P3 | Full env allow-list model | Better control than env overlay, but safe defaults + explicit env map are enough initially. | later |
| P3 | Sampling / roots / prompts / resources | Outside agreed Tools-only scope. Add only when product use cases are clear. | later |

