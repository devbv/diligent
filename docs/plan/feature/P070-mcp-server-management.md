---
id: P070
status: backlog
created: 2026-07-01
---

# MCP Server Management (status + commands)

## Goal

Users can see which configured MCP servers are connected and manage OAuth-backed HTTP
servers without editing files: `/mcp list`, `/mcp login <server>`, `/mcp logout <server>`
in the TUI, an equivalent surface in Web, and an MCP status line in `/status`. This makes
the P069 MCP client usable in practice — especially remote servers that require an
interactive OAuth login/logout and re-auth after token expiry.

## Prerequisites

- **P069 (MCP Client)** — provides `mcpServers` config, `McpConnectionManager`
  (`sync()` / `call()` / server runtime status), the MCP tool bridge, and HTTP OAuth
  support (`packages/runtime/src/tools/mcp/oauth.ts`). This plan surfaces and drives that
  layer; it does not re-implement connection logic.
- Existing OAuth/login infrastructure to reuse (do NOT rebuild):
  - `auth/oauth/start` handler `handleAuthOAuthStart` in `packages/runtime/src/app-server/config-handlers.ts`
  - loopback callback server + browser open: `packages/runtime/src/auth/callback-server.ts`, `browser.ts`, `oauth-router.ts`
  - completion broadcast pattern: `account/login/completed` server notification (`ACCOUNT_LOGIN_COMPLETED`)
  - TUI OAuth UX: `startChatGPTOAuthFlow` + `ctx.app.waitForOAuthComplete()` in `packages/cli/src/tui/commands/builtin/provider.ts`
- Protocol RPC conventions: method constant → Zod params/result → discriminated-union pair
  → dispatcher case → handler (mirrors `tools/list`, `auth/*`).

## Artifact

```
User → /mcp list
Agent →   ✓ github     stdio    12 tools
          ⚠ linear     http     needs login  (run /mcp login linear)
          ✗ notion     http     error: connect timeout

User → /mcp login linear
Agent →   Opening browser for "linear" authorization...
Agent →   ✓ Authenticated. linear now exposes 8 tools (next turn).

User → /mcp logout linear
Agent →   ✓ Cleared stored credentials for "linear".
```

Web: an "MCP Servers" settings section listing the same status with Login / Logout buttons.

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| packages/protocol/src | New `mcp/list`, `mcp/login/start`, `mcp/logout` request methods + schemas; `mcp/login/completed` server notification |
| packages/runtime/src/app-server | New `mcp-handlers.ts` (list/login/logout) + dispatcher wiring; expose MCP server status |
| packages/runtime/src/tools/mcp | Manager exposes per-server status incl. `needs_auth`; OAuth login/logout entry points |
| packages/cli/src (TUI) | `/mcp` command (list/login/logout); MCP line in `/status` |
| packages/web/src (Web) | MCP settings section + hook methods over the same RPC |

### What does NOT change

- **No new connection/transport logic** — all connect/list/call stays in P069's `McpConnectionManager`.
- **No config-file editing UI** — adding/removing servers is still done in `config.jsonc`; this plan only manages *auth/session state* and *visibility* of already-configured servers.
- **No per-tool toggle UI** — enabling/disabling individual MCP tools remains config-driven (backlog).
- **No prompts/resources browser** — Tools-only scope (backlog).
- **No server restart/reconnect command in v1** — `login` implicitly reconnects; a standalone `/mcp reconnect` is deferred (backlog).

## File Manifest

### packages/protocol/src/

| File | Action | Description |
|------|--------|------------|
| `methods.ts` | MODIFY | Add `MCP_LIST`, `MCP_LOGIN_START`, `MCP_LOGOUT`; add `MCP_LOGIN_COMPLETED` server notification |
| `client-requests.ts` | MODIFY | `McpList/McpLoginStart/McpLogout` params+result schemas + union pairs; `McpServerStatusSchema` |
| `server-notifications.ts` (or equivalent) | MODIFY | `mcp/login/completed` notification payload schema |

### packages/runtime/src/app-server/

| File | Action | Description |
|------|--------|------------|
| `mcp-handlers.ts` | CREATE | `handleMcpList`, `handleMcpLoginStart`, `handleMcpLogout` |
| `request-dispatcher.ts` | MODIFY | Add cases for the three MCP methods |
| `thread-handlers.ts` | MODIFY | Context accessors: `getMcpServers()` (from P069) + manager access for status |
| `server.ts` | MODIFY | Emit `mcp/login/completed`; wire handler deps (openBrowser, notifier) |

### packages/runtime/src/tools/mcp/

| File | Action | Description |
|------|--------|------------|
| `client.ts` | MODIFY | Surface per-server status (`connected`/`error`/`needs_auth`/`disabled`) + `toolCount`/`error`; expose `login(server)` / `logout(server)` delegating to `oauth.ts` |
| `oauth.ts` | MODIFY | `startLogin(server) → { authUrl }`, `completeLogin`, `clearCredentials(server)` |

### packages/cli/src/tui/commands/

| File | Action | Description |
|------|--------|------------|
| `builtin/mcp.ts` | CREATE | `/mcp` command: `list` / `login <server>` / `logout <server>` |
| `builtin/index.ts` | MODIFY | Register `mcpCommand` |
| `builtin/session.ts` | MODIFY | Add MCP summary line to `/status` |

### packages/web/src/client/

| File | Action | Description |
|------|--------|------------|
| `lib/use-thread-data.ts` | MODIFY | `listMcpServers()`, `mcpLoginStart()`, `mcpLogout()` RPC wrappers |
| `components/McpServersModal.tsx` | CREATE | List servers + Login/Logout buttons |
| `lib/use-app-state.ts` + host component | MODIFY | Wire modal open + OAuth-complete handling |

### test/

| File | Action | Description |
|------|--------|------------|
| `packages/runtime/test/app-server/mcp-handlers.test.ts` | CREATE | list/login/logout handler behavior with a fake manager |
| `packages/protocol/test/client-requests.test.ts` | MODIFY | Schema round-trip for new methods |
| `packages/cli/test/tui/commands/mcp.test.ts` | CREATE | Subcommand parsing + RPC dispatch + rendering |

## Implementation Tasks

### Task 1: Manager status + auth entry points (P069 layer)

**Files:** `packages/runtime/src/tools/mcp/client.ts`, `packages/runtime/src/tools/mcp/oauth.ts`

Extend `McpServerRuntime.status` to include `"needs_auth"` (HTTP OAuth server with no valid
token) and ensure `toolCount`/`error` are populated. Add manager methods:

```typescript
interface McpServerStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  status: "connected" | "needs_auth" | "error" | "disabled";
  toolCount: number;
  error?: string;
}

class McpConnectionManager {
  listStatus(servers: Record<string, McpServerConfig>): Promise<McpServerStatus[]>;
  loginStart(serverName: string): Promise<{ authUrl: string }>;   // delegates to oauth.ts
  loginComplete(serverName: string): Promise<{ toolCount: number }>; // reconnect + list
  logout(serverName: string): Promise<void>;                       // clear stored creds + drop conn
}
```

`listStatus` reuses the cached runtime state from `sync()` — it must not force a reconnect.

**Verify:** unit test: an HTTP server without a token reports `needs_auth`; a failing stdio
server reports `error` with a message; a healthy server reports `connected` + `toolCount`.

### Task 2: Protocol methods + schemas

**Files:** `packages/protocol/src/methods.ts`, `packages/protocol/src/client-requests.ts`, server-notifications schema

```typescript
// methods.ts (client requests)
MCP_LIST: "mcp/list",
MCP_LOGIN_START: "mcp/login/start",
MCP_LOGOUT: "mcp/logout",
// server notifications
MCP_LOGIN_COMPLETED: "mcp/login/completed",
```

```typescript
export const McpServerStatusSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  status: z.enum(["connected", "needs_auth", "error", "disabled"]),
  toolCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export const McpListParamsSchema = z.object({ threadId: z.string().optional() });
export const McpListResponseSchema = z.object({ servers: z.array(McpServerStatusSchema) });

export const McpLoginStartParamsSchema = z.object({ server: z.string() });
export const McpLoginStartResultSchema = z.object({ authUrl: z.string() });

export const McpLogoutParamsSchema = z.object({ server: z.string() });
export const McpLogoutResultSchema = z.object({ ok: z.literal(true) });

// server notification payload
export const McpLoginCompletedSchema = z.object({
  server: z.string(),
  success: z.boolean(),
  toolCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
```

Register each in the request/response discriminated unions exactly like `tools/list` and `auth/oauth/start`.

**Verify:** protocol schema round-trip test; typecheck of `RequestParams`/`RequestResult` inference.

### Task 3: Runtime handlers + dispatch

**Files:** `packages/runtime/src/app-server/mcp-handlers.ts`, `request-dispatcher.ts`, `thread-handlers.ts`, `server.ts`

```typescript
export async function handleMcpList(ctx, threadId): Promise<McpListResponse> {
  const servers = ctx.getMcpServers() ?? {};
  return { servers: await getMcpManager().listStatus(servers) };
}

export async function handleMcpLoginStart(ctx, deps, params): Promise<McpLoginStartResult> {
  const { authUrl } = await getMcpManager().loginStart(params.server);
  // background: await completion via oauth callback, then reconnect + broadcast
  void deps.runLoginFlow(params.server); // opens browser via openBrowser, awaits callback-server
  return { authUrl };
}

export async function handleMcpLogout(ctx, params): Promise<McpLogoutResult> {
  await getMcpManager().logout(params.server);
  return { ok: true };
}
```

- Reuse `handleAuthOAuthStart`'s structure (browser open + loopback callback) from
  `config-handlers.ts` for the background login flow; on completion, call
  `manager.loginComplete(server)` and emit `mcp/login/completed`.
- Add the three `case` entries to the dispatcher switch (mirror `TOOLS_LIST` / `AUTH_OAUTH_START`).
- `thread-handlers.ts` context already needs `getMcpServers()` (P069 Task 6) — reuse it.

**Verify:** `mcp-handlers.test.ts` with a fake manager: list maps status; logout calls
`manager.logout`; login-start returns `authUrl` and schedules completion + notification.

### Task 4: TUI `/mcp` command + `/status` line

**Files:** `packages/cli/src/tui/commands/builtin/mcp.ts`, `builtin/index.ts`, `builtin/session.ts`

- New `mcpCommand` (`supportsArgs: true`) parses `list` | `login <server>` | `logout <server>`.
- `list`: `rpc.request(MCP_LIST, { threadId })` → render status lines with ✓/⚠/✗ + toolCount.
- `login`: `rpc.request(MCP_LOGIN_START, { server })` → show `authUrl`, then
  `await ctx.app.waitForOAuthComplete()` (reuse the provider flow), render success/tool count.
- `logout`: `rpc.request(MCP_LOGOUT, { server })` → confirmation line.
- Register in `builtin/index.ts`.
- `/status`: add a compact `MCP: n/m connected` line (best-effort, swallow errors).

**Verify:** `mcp.test.ts` — subcommand routing, arg validation (missing server name),
correct RPC method per subcommand, rendered output.

### Task 5: Web MCP servers surface

**Files:** `packages/web/src/client/lib/use-thread-data.ts`, `components/McpServersModal.tsx`,
`lib/use-app-state.ts` (+ host component)

- Add `listMcpServers` / `mcpLoginStart` / `mcpLogout` to `use-thread-data.ts` (mirror
  `listTools` / `saveTools`).
- `McpServersModal.tsx`: fetch on open, render rows (name, transport, status badge,
  toolCount), Login button for `needs_auth` (opens `authUrl` in a new tab, then reconciles
  on `mcp/login/completed`), Logout button otherwise.
- Wire modal open + subscribe to the `mcp/login/completed` notification to refresh the list.

**Verify:** manual — list renders, Login opens browser and updates on completion, Logout
clears. (Component test optional following existing modal test patterns.)

## Acceptance Criteria

1. `bun test` — all tests pass, including new protocol/handler/TUI tests.
2. `/mcp list` shows every configured server with an accurate status
   (`connected`/`needs_auth`/`error`/`disabled`) and tool count.
3. `/mcp login <server>` opens the browser, completes OAuth, and the server transitions to
   `connected` with its tools available on the next turn.
4. `/mcp logout <server>` clears stored credentials; the server returns to `needs_auth`.
5. Web exposes the same list + Login/Logout over the identical RPC methods.
6. `/status` includes an MCP summary line.
7. No new transport/connection code outside P069's `McpConnectionManager`.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | manager status mapping incl. `needs_auth` | `bun test` client.test.ts (fake transport/oauth) |
| Unit | protocol schema round-trip for new methods | `bun test` client-requests.test.ts |
| Unit | list/login/logout handlers | `bun test` mcp-handlers.test.ts (fake manager) |
| Unit | TUI subcommand routing + rendering | `bun test` mcp.test.ts |
| Manual | OAuth login end-to-end (TUI + Web) | Real OAuth-protected HTTP MCP server |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Login flow diverges from provider OAuth infra | Duplicate/fragile code | Reuse `handleAuthOAuthStart` + callback-server + `waitForOAuthComplete` |
| `mcp/list` forcing reconnects on every call | Latency / churn | `listStatus` reads cached `sync()` state only |
| Status drift after login until next turn | Confusing UX | Emit `mcp/login/completed`; clients refresh list on it |
| Concurrent logins to multiple servers | Callback/port contention | Serialize per-server login; reuse single loopback router keyed by state param |
| Server names with spaces/special chars in args | Command parse errors | Validate/quote server names; surface usage errors |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D027 | Approval/permission model | Login gating consistency |
| D033/D034 | Config layering | Server set resolved from `mcpServers` |
| P069 | MCP client (manager, OAuth) | Prerequisite; this plan is its UX surface |
