---
id: P071
status: backlog
created: 2026-07-10
---

# OVERDARE MCP Router for Multiple Studio Instances

## Goal

Provide a stable OVERDARE MCP entrypoint that survives packaged runtime path changes and correctly handles multiple concurrently-open Studio instances.

Instead of making each Studio sidecar the MCP server directly, add a router mode to the stable `overdare-ai-agent` Rust launcher executable. The router exposes one MCP server to clients, discovers connected Studio sidecars, lets the model/user inspect and select the active Studio, and forwards subsequent Studio tool calls to the selected instance.

The key packaging constraint is size: an earlier split executable was avoided because Bun-made executables were too large. Therefore the preferred router home is the existing small Rust `overdare-ai-agent.exe`, not another bundled Bun executable.

## Prerequisites

- Existing OVERDARE sidecar web server startup in `apps/overdare-ai-agent/sidecar/src/server.ts`.
- Existing OVERDARE MCP server registry and stdio runner in `apps/overdare-ai-agent/sidecar/src/mcp-server.ts`.
- Existing Studio RPC tools currently target a single Studio through `STUDIO_PORT` / `STUDIO_HOST` (`apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts`).
- Official `@modelcontextprotocol/sdk` already installed and used for MCP client/server code (D056).
- Existing shared web server route layer in `packages/web/src/server/index.ts`.
- Existing Rust launcher in `apps/overdare-ai-agent/src/` already owns stable commands (`init`, `start`), update/runtime path resolution, storage namespace, and sidecar subprocess startup.

## Artifact

An MCP client is configured once against the stable Rust launcher executable:

```jsonc
{
  "mcpServers": {
    "overdare": {
      "command": "/stable/path/overdare-ai-agent.exe",
      "args": ["start-mcp-router"]
    }
  }
}
```

Optionally, if client support makes it worthwhile later, the same Rust launcher can start a local HTTP router:

```jsonc
{
  "mcpServers": {
    "overdare": {
      "type": "http",
      "url": "http://127.0.0.1:<router-port>/mcp",
      "headers": {
        "Authorization": "Bearer <router-token>"
      }
    }
  }
}
```

When multiple Studio windows are open, the MCP tool surface includes session-management tools similar to Roblox's pattern:

```text
list_overdare_studios
set_active_overdare_studio
get_active_overdare_studio
```

The agent can list available Studio instances, select one as active, then use normal OVERDARE Studio tools. Tool calls are routed to the active Studio unless a future task adds explicit per-call targeting.

## Scope

### Confirmed decisions

- Router command name is `overdare-ai-agent start-mcp-router`.
- A sidecar is expected to exist per Studio instance.
- Router-to-tool execution uses sidecar HTTP proxy so existing TypeScript Studio tools remain the source of truth.
- If exactly one Studio is live, the router auto-selects it.
- If multiple Studios are live, all Studio tools fail safely until active Studio is selected.
- Active Studio selection is scoped per MCP client/session where possible.
- Sidecar auth token in the user-private registry is acceptable for local router-to-sidecar authentication.

### What changes

| Area | What Changes |
|------|-------------|
| Rust launcher CLI | Add `start-mcp-router` command to the stable `overdare-ai-agent` executable. |
| Rust MCP router | Implement the small MCP router in Rust, avoiding a second large Bun executable. |
| Sidecar registration/discovery | Each running Studio sidecar publishes metadata: instance ID, display name, cwd/project ID, sidecar URL/port, auth token, PID, heartbeat timestamp. |
| MCP router server | Exposes session-management tools, maintains active Studio selection per MCP session/client, and proxies Studio tools to the selected sidecar. |
| Studio tool dispatch | Router forwards Studio tool calls to the selected sidecar HTTP endpoint instead of binding all tools to one `STUDIO_PORT` at router startup. |
| Sidecar web server | Expose an authenticated local endpoint for router-to-sidecar tool calls; external clients never need to know per-Studio sidecar ports. |
| Tests/docs | Add router discovery/selection/routing tests and document multi-Studio behavior. |

### What does NOT change

- No removal of legacy `mcp-serve` stdio mode in this plan.
- No generic Diligent MCP server mode for all users. This remains an OVERDARE product-side MCP router, keeping D066's broader server-mode deferral intact.
- No direct remote/public network exposure. Router and sidecars bind to loopback only.
- No full rewrite of Studio RPC tools. The plan introduces a routing layer around their call target.
- No Rust port of every TypeScript Studio tool. Rust owns MCP routing/session/discovery; TypeScript sidecar owns rich tool execution.
- No automatic semantic decision about which Studio is correct for a user request beyond a safe default and explicit active-selection tools.
- No cross-Studio bulk editing in one tool call.

## File Manifest

### apps/overdare-ai-agent/src/

| File | Action | Description |
|------|--------|------------|
| `main.rs` | MODIFY | Register new Rust modules for MCP router support. |
| `cli.rs` | MODIFY | Add `start-mcp-router` command and help text. |
| `mcp_router.rs` | CREATE | Rust MCP stdio router entrypoint and JSON-RPC loop. |
| `mcp_protocol.rs` | CREATE | Minimal MCP request/response types if no Rust MCP crate is adopted. |
| `studio_registry.rs` | CREATE | Rust reader for connected Studio records and stale filtering. |
| `studio_router.rs` | CREATE | Active Studio resolver and routing/proxy logic. |
| `webserver.rs` | MODIFY | Ensure sidecar start/register metadata includes all router-needed fields. |

### apps/overdare-ai-agent/sidecar/src/

| File | Action | Description |
|------|--------|------------|
| `mcp-server.ts` | MODIFY | Preserve legacy Bun/TypeScript MCP server; expose reusable tool catalog/proxy helpers if needed. |
| `server.ts` | MODIFY | Register this sidecar as one Studio instance and expose router-callable local endpoint. |
| `studio-registry.ts` | CREATE | TypeScript writer for sidecar registration records and heartbeats. |
| `router-endpoint.ts` | CREATE | Authenticated sidecar HTTP endpoint for router-to-sidecar tool calls. |

### apps/overdare-ai-agent/sidecar/src/tools/studiorpc/

| File | Action | Description |
|------|--------|------------|
| `rpc.ts` | MODIFY | Keep current sidecar-owned Studio RPC behavior; explicit targets are no longer required for router dispatch. |
| `index.ts` | MODIFY | Ensure router-proxied calls can reuse existing TypeScript Studio tools and hooks. |

### packages/web/src/server/

| File | Action | Description |
|------|--------|------------|
| `index.ts` | MODIFY | Add optional extra route hook if sidecar router endpoint is mounted through the shared web server. |

### apps/overdare-ai-agent/sidecar/test/

| File | Action | Description |
|------|--------|------------|
| `mcp-server.test.ts` | MODIFY | Preserve existing registry/stdin behavior coverage. |
| `studio-registry.test.ts` | CREATE | Test sidecar registration file semantics and heartbeat expiry. |

### apps/overdare-ai-agent/test/ or Rust unit tests

| File | Action | Description |
|------|--------|------------|
| Rust module tests | CREATE/MODIFY | Test MCP router JSON-RPC, active selection, stale instance filtering, and routing. |

### docs/guide/ or app packaging docs

| File | Action | Description |
|------|--------|------------|
| `overdare-mcp.md` or existing setup guide | CREATE or MODIFY | Document router setup, multi-Studio selection, HTTP/stdio fallback, and troubleshooting. |

## Implementation Tasks

### Task 1: Run unknown-unknown spikes for Rust MCP router feasibility

**Files:** temporary spike/test only; remove or promote to tests.
**Decisions:** D056, D057

The router changes the shape more than a simple `/mcp` endpoint, and putting it in Rust changes reuse boundaries. Prove the transport/session mechanics and implementation scope before product logic.

Questions to answer:

- Which Rust MCP implementation route is safest: an official/community Rust MCP crate, or a minimal hand-written stdio JSON-RPC MCP surface for tools/prompts?
- Can the Rust router expose enough MCP server functionality without pulling in dependencies that make the launcher large or risky?
- Confirm the sidecar HTTP proxy contract for reusing existing TypeScript tools from the Rust router.
- Which MCP transport is safest as the default router entrypoint for target clients: stable stdio `overdare-ai-agent start-mcp-router`, optional Streamable HTTP router service, or both?
- Confirm MCP session identity is sufficient for per-client/session active Studio selection in target clients.
- For stdio clients, does one router process map to exactly one MCP client session in all target clients?
- If a client reconnects, should active Studio be restored from a persisted preference or reset to auto/default?
- How do Claude/Diligent clients expose or hide router session-management tools in practice?
- How much of `ensure_system_prompt`, `load_skill`, and prompt exposure must be duplicated in Rust versus proxied to the sidecar?

**Verify:** A spike can initialize an MCP router, call a session-management tool, then call a proxied test tool that observes the chosen active target.

### Task 2: Define Studio instance registration and discovery

**Files:** `apps/overdare-ai-agent/sidecar/src/studio-registry.ts`, `apps/overdare-ai-agent/src/studio_registry.rs`, `apps/overdare-ai-agent/sidecar/src/server.ts`, tests

Each sidecar writes a small, local, authenticated registration record. The router reads this registry instead of guessing from process paths or ports.

Code sketch:

```typescript
export interface StudioInstanceRecord {
  id: string;
  displayName: string;
  cwd: string;
  projectId?: string;
  studioHost: string;
  studioPort: number;
  sidecarUrl: string;
  sidecarToken: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface StudioRegistry {
  register(record: StudioInstanceRecord): Promise<void>;
  heartbeat(id: string): Promise<void>;
  unregister(id: string): Promise<void>;
  list(options?: { now?: Date; staleAfterMs?: number }): Promise<StudioInstanceRecord[]>;
}
```

Recommended storage shape:

```text
<overdare-storage-dir>/mcp/studios/<studio-instance-id>.json
```

Unknown-unknown guardrails:

- Stale records must be ignored using PID liveness and heartbeat age.
- Multiple sidecars may start/stop concurrently; writes should be atomic enough to avoid partial JSON.
- Instance ID should not be derived from mutable cwd alone. Use a generated ID per sidecar process plus metadata for display.
- Registry should not expose tokens to world-readable locations where avoidable.

**Verify:** Tests cover register/list/heartbeat/unregister, stale filtering, malformed file tolerance, and concurrent-ish updates.

### Task 3: Add Rust router session-management MCP tools

**Files:** `apps/overdare-ai-agent/src/mcp_router.rs`, `apps/overdare-ai-agent/src/studio_router.rs`, tests

Expose tools equivalent in spirit to Roblox's session management:

```rust
pub const LIST_OVERDARE_STUDIOS: &str = "list_overdare_studios";
pub const SET_ACTIVE_OVERDARE_STUDIO: &str = "set_active_overdare_studio";
pub const GET_ACTIVE_OVERDARE_STUDIO: &str = "get_active_overdare_studio";
```

Active selection policy:

- If exactly one live Studio exists, auto-select it.
- If zero live Studios exist, Studio tools return a clear error asking the user to open Studio.
- If multiple live Studios exist and none is active, all Studio tools refuse and instruct the model to call `list_overdare_studios` then `set_active_overdare_studio`.
- Active Studio selection is scoped per MCP client/session where the transport exposes a session boundary. For stdio router mode, the router process itself is the session boundary.

**Verify:** Router tests cover zero/one/many Studio cases and active selection changes.

### Task 4: Add the sidecar router-callable tool proxy endpoint

**Files:** `apps/overdare-ai-agent/sidecar/src/router-endpoint.ts`, `apps/overdare-ai-agent/sidecar/src/server.ts`, `packages/web/src/server/index.ts`, tests

The Rust router must not reimplement the rich TypeScript Studio tool layer. Instead, each sidecar exposes an authenticated local endpoint that lets the router fetch the sidecar's tool catalog and execute a tool inside that sidecar's existing TypeScript runtime.

Code sketch:

```typescript
export interface RouterToolCatalogResponse {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export interface RouterToolCallRequest {
  tool: string;
  args: unknown;
  routerCallId: string;
}
```

The endpoint must require the sidecar auth token from the registry record. This token is accepted in the registry file because the registry directory is user-private and records are heartbeat/PID validated.

**Verify:** Tests cover catalog fetch, successful call, unknown tool, invalid token, stale sidecar, and no regression to `/rpc`, `/health`, image routes, static serving, and dev fallback.

### Task 5: Build the stable Rust MCP router entrypoint

**Files:** `apps/overdare-ai-agent/src/cli.rs`, `apps/overdare-ai-agent/src/main.rs`, `apps/overdare-ai-agent/src/mcp_router.rs`, package/build config if needed, tests

The router is the one thing external MCP clients configure. It should live inside the stable Rust launcher, stay small, and be independent of per-Studio runtime paths.

Responsibilities:

- Add `overdare-ai-agent start-mcp-router` CLI command.
- Start MCP server over stdio for broad compatibility.
- Optionally start/advertise Streamable HTTP if client support and packaging make it useful.
- Load or proxy bootstrap tools/prompts (`ensure_system_prompt`, `load_skill`, agent prompts) through the selected sidecar unless Task 1 proves a lighter Rust-local catalog is safer.
- Add session-management tools.
- Add Studio tool entries whose execution resolves the active Studio on each call.
- Keep stdout protocol-safe in stdio mode.
- Log diagnostics to stderr or a file.

Code sketch:

```rust
pub struct McpRouterOptions {
    pub registry_dir: std::path::PathBuf,
    pub default_active_studio_id: Option<String>,
}

pub async fn run_mcp_router(options: McpRouterOptions) -> Result<(), String>;
```

Router tool execution sketch:

```rust
async fn with_active_studio<F, Fut, T>(resolver: &ActiveStudioResolver, f: F) -> Result<T, String>
where
    F: FnOnce(StudioInstanceRecord) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let studio = resolver
        .resolve()
        .await?
        .ok_or_else(|| "No active OVERDARE Studio. Call list_overdare_studios and set_active_overdare_studio first.".to_string())?;
    f(studio).await
}
```

**Verify:** In-memory/router tests can register two fake Studios, select the second, and confirm a Studio tool calls the second target.

### Task 6: Wire router-to-sidecar proxy execution

**Files:** `apps/overdare-ai-agent/src/studio_router.rs`, `apps/overdare-ai-agent/src/mcp_router.rs`, tests

Router execution path:

1. Resolve active Studio from the session-scoped active state and live registry.
2. Fetch or use cached tool catalog from that sidecar.
3. Forward tool call to the sidecar HTTP endpoint with the sidecar auth token.
4. Map sidecar tool output back to MCP `CallToolResult`.
5. If the active sidecar is stale/unreachable, clear active state and return a clear error instructing the model to list/select again.

This preserves existing TypeScript behavior: approval metadata, snapshot/rollback hooks, render payloads, bootstrap skill discovery, RAG tools, and future tool additions remain in one place.

**Verify:** Fake two registered sidecars, select the second, call a proxied tool, and assert only the second sidecar receives it.

### Task 7: Preserve legacy `mcp-serve` and define migration path

**Files:** `apps/overdare-ai-agent/sidecar/src/server.ts`, `apps/overdare-ai-agent/sidecar/src/mcp-server.ts`, docs

Keep this existing branch for compatibility:

```typescript
if (process.argv.slice(1).includes("mcp-serve")) {
  await runMcpServerMain();
}
```

Add a new Rust launcher command:

```rust
match command.as_str() {
    "init" => run_init(&selection, args.collect()),
    "start" => run_webserver(&selection, args.collect()),
    "start-mcp-router" => run_mcp_router(&selection, args.collect()),
    other => Err(format!("Unknown command: {other}")),
}
```

Packaging must ensure `overdare-ai-agent.exe` is the stable MCP client command. The router must not require external clients to point at the moving Bun runtime sidecar path.

**Verify:** Legacy `mcp-serve` still works; new `start-mcp-router` works without a Studio-specific runtime path.

### Task 8: Compatibility matrix and manual verification

**Files:** docs/test notes only, plus tests discovered necessary during implementation.

Manually verify:

- One Studio open: router auto-selects it and tools work.
- Two Studios open: router lists both and refuses ambiguous Studio tool calls until active is set.
- Switching active Studio changes subsequent tool target.
- Closing the active Studio clears or invalidates active state with a clear error.
- Reopening Studio produces a new instance record; stale records are ignored.
- Claude Desktop / Claude Code target client can use the session-management tools correctly.
- Diligent MCP client can connect to the router.
- Packaged app update does not break the configured `overdare-ai-agent.exe start-mcp-router` path, or launcher updates config reliably.

**Verify:** Record results in PR notes or in this plan before marking complete.

## Acceptance Criteria

1. External MCP clients configure `overdare-ai-agent.exe start-mcp-router` as one stable OVERDARE MCP router entrypoint, not per-Studio sidecar/runtime paths.
2. The router lists all live connected Studio instances with ID, display name, cwd/project metadata, and active status.
3. The router can set and report the active Studio.
4. With exactly one Studio, Studio tools work without manual selection.
5. With multiple Studios, Studio tools fail safely until an active Studio is selected.
6. After active selection, subsequent Studio tool calls target the selected Studio.
7. Stale/closed Studio instances are ignored or clearly reported stale.
8. Legacy `mcp-serve` remains functional and stdout-safe.
9. Tests cover registry discovery, active selection, stale filtering, and routing to the selected target.
10. Documentation explains router setup, multi-Studio workflow, fallback stdio behavior, and troubleshooting.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Studio registry file semantics | `bun test apps/overdare-ai-agent/sidecar/test/studio-registry.test.ts` |
| Unit | Rust active Studio resolver | Rust tests with zero/one/many fake records |
| Unit | Sidecar proxy endpoint auth | Missing/wrong/right sidecar token against router-callable endpoint |
| Integration | Router MCP tools | MCP client or JSON-RPC harness calling `list_overdare_studios` / `set_active_overdare_studio` against `overdare-ai-agent start-mcp-router` |
| Integration | Studio tool routing | Fake two Studios and assert selected target receives the call |
| Regression | Legacy MCP server | Existing `mcp-server.test.ts` and manual stdio smoke if needed |
| Manual | Real multi-Studio UX | Open two Studio windows, switch active target, run read and write tools |
| Manual | Packaging stability | Update/relaunch packaged app and confirm MCP client config still works |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Launcher path still moves | Original problem remains | Use the already-stable `overdare-ai-agent.exe`; launcher/installer owns MCP config if even that path changes. |
| Rust MCP implementation grows complex | Router becomes hard to maintain | Keep Rust MCP surface minimal; prefer sidecar HTTP proxy for existing rich TypeScript tools. |
| Duplicating tool definitions in Rust drifts from TypeScript | Client sees stale or inconsistent tools | Prefer sidecar-provided tool catalog/proxy if feasible; otherwise generate or test parity. |
| Active Studio state leaks between clients | One client may affect another client's target | Scope active state per MCP session when possible; spike first. |
| Ambiguous multi-Studio writes | Tool edits wrong project | Refuse tool calls when multiple live Studios exist and no active Studio is selected. |
| Stale registry records | Router shows dead Studios or routes to closed port | Heartbeat + PID liveness + stale timeout + clear errors. |
| Sidecar proxy accidentally bypasses existing tool hooks | Snapshot/rollback/render behavior may drift | Execute through the existing TypeScript tool registry rather than reimplementing tool behavior in Rust. |
| Sidecar registry token exposure | Local token leakage | Store under user-private storage dir; validate permissions where practical; bind loopback. |
| Client support for HTTP MCP differs | HTTP router may not work everywhere | Default to stable stdio router command; HTTP router remains optional if useful. |
| D066 deferred MCP server mode ambiguity | Scope creep into generic server mode | Keep router OVERDARE-specific and product-packaged. |
| Tool descriptions become confusing | Model may not know to select active Studio | Server instructions and ambiguous-target errors must explicitly tell it to call list/set tools. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D056 | Use official `@modelcontextprotocol/sdk` for MCP. | Router server and spike. |
| D057 | Support stdio and Streamable HTTP transports. | Router entrypoint choice. |
| D059 | MCP tools convert into ordinary tool registry entries. | Router exposes session-management and Studio tools as normal tools. |
| D066 | Generic Diligent MCP server mode deferred. | Negative scope and risk mitigation. |
| D068 | Core remains transport-agnostic; registry/tool context are integration points. | Router remains product-side transport/tool composition. |
