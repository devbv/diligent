---
id: P071
status: active
created: 2026-07-10
---

> **Implementation status (2026-07-30):** Tasks 1–7 implemented and tested; Task 8's automated half is
> covered and its manual matrix is verified against real sidecars but not yet against Claude
> Desktop / Claude Code / packaged updates. See "Implementation notes" at the end of this document
> for the Task 1 spike outcomes and every deviation from the file manifest above.

# OVERDARE MCP Router for Multiple Studio Instances

## Goal

Provide a stable OVERDARE MCP entrypoint that survives packaged runtime path changes and correctly handles multiple concurrently-open Studio instances.

Instead of making each Studio sidecar the MCP server directly, add a small dedicated `overdare-mcp` Rust executable beside the stable `overdare-ai-agent` launcher. The router exposes one MCP server to clients, discovers connected Studio sidecars, lets the model/user inspect and select the active Studio, and forwards subsequent Studio tool calls to the selected instance.

The key packaging constraint is size: an earlier Bun split executable was too large. A second small Rust binary shares the launcher's library code while giving MCP processes a distinct executable name, preventing Epic Launcher from mistaking one router per client for running Studio instances.

## Prerequisites

- Existing OVERDARE sidecar web server startup in `apps/overdare-ai-agent/sidecar/src/server.ts`.
- Existing OVERDARE MCP server registry and stdio runner in `apps/overdare-ai-agent/sidecar/src/mcp-server.ts`.
- Existing Studio RPC tools currently target a single Studio through `STUDIO_PORT` / `STUDIO_HOST` (`apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts`).
- Official `@modelcontextprotocol/sdk` already installed and used for MCP client/server code (D056).
- Existing shared web server route layer in `packages/web/src/server/index.ts`.
- Existing Rust launcher in `apps/overdare-ai-agent/src/` already owns stable commands (`init`, `start`), update/runtime path resolution, storage namespace, and sidecar subprocess startup.

## Artifact

An MCP client is configured once against the stable dedicated Rust router executable:

```jsonc
{
  "mcpServers": {
    "overdare": {
      "command": "/stable/path/overdare-mcp.exe"
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

- New clients use the dedicated `overdare-mcp` executable; `overdare-ai-agent start-mcp-router` remains compatible.
- A sidecar is expected to exist per Studio instance.
- Router-to-tool execution uses sidecar HTTP proxy so existing TypeScript Studio tools remain the source of truth.
- If exactly one Studio is live, the router auto-selects it.
- If multiple Studios are live, all Studio tools fail safely until active Studio is selected.
- Active Studio selection is scoped per MCP client/session where possible.
- Sidecar auth token in the user-private registry is acceptable for local router-to-sidecar authentication.

### What changes

| Area | What Changes |
|------|-------------|
| Rust launcher CLI | Keep `start-mcp-router` as a compatibility command. |
| Rust MCP router | Implement the small MCP router in Rust and expose it through a separately named executable sharing the same library code. |
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
| `lib.rs` | CREATE | Share launcher and router modules between the two Rust binaries. |
| `main.rs` | MODIFY | Run the general launcher through the shared library. |
| `bin/overdare-mcp.rs` | CREATE | Start the router directly without a subcommand. |
| `cli.rs` | MODIFY | Add the dedicated router entrypoint and retain the compatibility command. |
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
- Which MCP transport is safest as the default router entrypoint for target clients: stable stdio `overdare-mcp`, optional Streamable HTTP router service, or both?
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

**Files:** `apps/overdare-ai-agent/src/lib.rs`, `apps/overdare-ai-agent/src/cli.rs`, `apps/overdare-ai-agent/src/main.rs`, `apps/overdare-ai-agent/src/bin/overdare-mcp.rs`, `apps/overdare-ai-agent/src/mcp_router.rs`, package/build config, tests

The router is the one thing external MCP clients configure. It should share the stable Rust launcher's code, use a distinct process name, stay small, and be independent of per-Studio runtime paths.

Responsibilities:

- Add a dedicated `overdare-mcp` binary and keep `overdare-ai-agent start-mcp-router` for compatibility.
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

Packaging must install `overdare-mcp.exe` beside `overdare-ai-agent.exe` as the stable MCP client command. The router must not require external clients to point at the moving Bun runtime sidecar path.

**Verify:** Legacy `mcp-serve` and the compatibility `start-mcp-router` command still work; the dedicated router works without a Studio-specific runtime path.

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
- Packaged app update does not break the configured `overdare-mcp.exe` path, or the installer updates config reliably.

**Verify:** Record results in PR notes or in this plan before marking complete.

## Acceptance Criteria

1. External MCP clients configure `overdare-mcp.exe` as one stable OVERDARE MCP router entrypoint, not per-Studio sidecar/runtime paths.
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
| Integration | Router MCP tools | MCP client or JSON-RPC harness calling `list_overdare_studios` / `set_active_overdare_studio` against `overdare-mcp` |
| Integration | Studio tool routing | Fake two Studios and assert selected target receives the call |
| Regression | Legacy MCP server | Existing `mcp-server.test.ts` and manual stdio smoke if needed |
| Manual | Real multi-Studio UX | Open two Studio windows, switch active target, run read and write tools |
| Manual | Packaging stability | Update/relaunch packaged app and confirm MCP client config still works |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Router path still moves | Original problem remains | Install `overdare-mcp.exe` beside the stable launcher; the launcher/installer owns MCP config if that directory changes. |
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

## Implementation notes (2026-07-30)

### Task 1 spike outcomes

| Question | Answer |
|----------|--------|
| Rust MCP crate or hand-written? | **Hand-written** (`src/mcp_protocol.rs`, ~200 lines). `Cargo.toml`'s release profile is explicitly size-tuned (`opt-level = "s"`, `lto`, `strip`, `panic = "abort"`) because executable size is the constraint that put the router here. An MCP crate brings schema generation and a service stack; the server half we need is newline-delimited JSON-RPC 2.0 over six methods, which `serde_json` already covers. New crates added: **none** (only two extra `tokio` features, `io-std` + `sync`). |
| Transport | **stdio only.** Broadest client support and no port/token for the user to manage. Streamable HTTP stays deferred — nothing in the design blocks adding it later. |
| Session boundary | One router process per stdio client, so active selection is process-local in-memory. Cross-client leakage is impossible by construction. |
| Reconnect behavior | Selection resets to auto rather than persisting. A persisted choice would silently retarget a new session at a project the user is no longer in. |
| `ensure_system_prompt` / `load_skill` / prompts | **Proxied, not duplicated.** `server.ts` reuses the sidecar's `buildRegistries()`, so the router advertises and executes exactly what `mcp-serve` does. No Rust-local catalog. |
| Tool catalog source | The sidecar writes a **catalog snapshot into its registry record**. The router answers `tools/list` with no round-trip, and can advertise Studio tools from the newest record even with no Studio live — which is what lets a client that connects before Studio opens ever see them. |

### Deviations from the plan above

| Plan | Actual | Why |
|------|--------|-----|
| `packages/web/src/server/index.ts` | `apps/overdare-ai-agent/sidecar/src/web/server/index.ts` | The shared web server lives in the sidecar, not in `packages/web`. |
| "optional extra route hook" | `extraRoutes: { matches, handle }` — a **sync** matcher plus an async handler | Bun's `fetch` must stay synchronous or the `/rpc` WebSocket upgrade breaks. The matcher decides synchronously; only the handler is async. |
| `mcp_protocol.rs` "if no Rust MCP crate is adopted" | Written | See spike table. |
| `studio_registry.rs` "stale filtering" by PID liveness | Heartbeat age + **HTTP reachability probe**; PID liveness only on the TypeScript side | Portable PID liveness in Rust needs `libc`/`windows-sys`, against the size budget. The probe is strictly better for the case that matters (is this sidecar answering?), and only runs when there is something to disambiguate. |
| `StudioInstanceRecord` fields | Plus `catalog` | See spike table. |
| `rpc.ts` MODIFY | `studiorpc/config.ts` gained exported `resolveStudioHost` / `resolveStudioPort`; `rpc.ts` now calls them | The record must report the address the tools actually dial. Moving the resolvers to the module that already owns config loading avoids duplicating precedence rules, and keeps `rpc.ts`'s test mock shape unchanged. |
| Registration is unconditional | Skipped when `STUDIO_DISABLED=1` | UI-only development has no Studio to route to. |
| `StudioRegistration.stop()` async | Synchronous (`unregisterSync`) | It runs from `process.on("exit")` and signal handlers, where an awaited unlink never completes. |

### Correctness notes worth keeping

- **Experiment gating is not optional.** The first working version of `server.ts` built registries without resolving experiments, so the router advertised `studiorpc_procedural_run` and `agent-procedural-builder` — both gated off by default — while `mcp-serve` correctly hid them. `registries()` now resolves `OVERDARE_EXPERIMENTS` exactly as `runMcpServerMain` does. Verified: both surfaces report 38 tools.
- **Registration must not delay startup.** The launcher parses `DILIGENT_PORT` under a timeout, so registration happens as soon as the port is known and the catalog is published in the background via `updateCatalog`.
- **Tool failures are not transport failures.** `/mcp-router/tools/call` answers HTTP 200 with `isError` for a failing tool. A 4xx would read to the router as a dead sidecar and wrongly clear the active selection.
- **Session tools cannot be shadowed.** A Studio catalog containing a session tool name is filtered out, or selection would become unreachable.
- **Ambiguity and "no Studio" are tool errors, not JSON-RPC errors.** The model has to read them and act; a protocol-level failure gives it nothing to do.

### Verification

- `cargo test`: 141 pass (52 new across `mcp_protocol`, `studio_registry`, `studio_router`, `mcp_router`). `studio_router` tests stand up real loopback HTTP sidecars and assert that only the selected one is called, that a wrong token surfaces as a tool error, and that an unreachable leftover record does not make the target ambiguous.
- `bun test apps/overdare-ai-agent/sidecar/test/`: 745 pass, 3 pre-existing unrelated failures (procedural Luau dummy JSON ×2, `VITE_APP_PROJECT_NAME` branding). 52 new tests across `studio-registry.test.ts`, `router-endpoint.test.ts`, `web/server/extra-routes.test.ts`.
- **Executable size, the constraint this plan turns on:** release build grew from 4,456,096 to 4,555,744 bytes on darwin-arm64 — **+97 KiB (+2.2%)**, with zero new crates. Measured by building `--release` with and without the change.
- Manual, against two real sidecars: single Studio auto-selects and proxies `ensure_system_prompt`; two Studios refuse then route correctly after `set_active_overdare_studio`; `tools/list` returns 3 session + 38 Studio tools; SIGTERM removes the record immediately and the survivor auto-selects; SIGKILL leaves a record that is ignored after the 15 s staleness window; legacy `mcp-serve` still initializes and lists 38 tools with clean stdout.

### Remaining before this can be marked complete

See `P071-overdare-mcp-router-handoff.md` for the step-by-step version of the list below, including
the Windows commands, the record-privacy decision, and the invariants a follow-up must not break.

1. Task 8 against real clients: Claude Desktop and Claude Code driving the session-management tools, and the Diligent MCP client connecting to the router.
2. Task 8 packaging check: a packaged app update must not break a configured `overdare-mcp.exe` path.
3. Windows verification — all manual testing so far was on macOS. The record's `0600`/`0700` permissions are best-effort no-ops there, so the registry directory's ACL should be confirmed.
4. Decide whether `list_overdare_studios` should surface the Studio RPC connection state (not just the sidecar's), which would let it distinguish "sidecar up, Studio detached".
