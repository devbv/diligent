# P071 OVERDARE MCP router — Windows / real-client verification handoff

> Audience: whoever picks this up on Windows to finish Task 8
> Branch: `devbv/better-mcp`
> Plan: `docs/plan/feature/P071-overdare-mcp-router.md` (status `active`; spike outcomes, deviations, and verification are in its "Implementation notes" section)
> User guide: `docs/guide/overdare-mcp.md`

---

## 0. One-line summary

The router is **implemented and green on macOS** (Tasks 1–7, 52 new Rust tests + 52 new bun tests). What remains is **verification that needs a Windows box, a packaged app, or a real MCP client** — plus one genuine open question about record privacy on Windows (§3.1). No known bugs are outstanding.

---

## 1. What exists now

| Layer | File | Role |
|-------|------|------|
| Rust | `src/mcp_protocol.rs` | Hand-written JSON-RPC 2.0 + MCP types (no MCP crate; +97 KiB total) |
| Rust | `src/studio_registry.rs` | Reads Studio records, heartbeat staleness, best-catalog selection |
| Rust | `src/studio_router.rs` | Session tools, active-Studio resolver, HTTP proxy to the sidecar |
| Rust | `src/mcp_router.rs` | stdio loop, `initialize`/`tools`/`prompts`/`ping`, `listChanged` watcher |
| Rust | `src/cli.rs`, `src/main.rs` | `start-mcp-router` command + module registration |
| TS | `sidecar/src/studio-registry.ts` | Writes/heartbeats/sweeps the record |
| TS | `sidecar/src/router-endpoint.ts` | Bearer-authenticated `/mcp-router/*` endpoint |
| TS | `sidecar/src/mcp-server.ts` | Refactored so the stdio server and the router share one execution path |
| TS | `sidecar/src/server.ts` | Registers the instance, mounts the endpoint, publishes the catalog |
| TS | `sidecar/src/web/server/index.ts` | `extraRoutes` hook (sync `matches` + async `handle`) |

The registry directory is the **only** contract between the two languages:

```
%USERPROFILE%\.overdare\mcp\studios\<uuid>.json      (prod)
%USERPROFILE%\.overdare-dev\mcp\studios\<uuid>.json  (dev, --agent-env=dev)
```

Written by `resolveRegistryDir()` (`studio-registry.ts`), read by `registry_dir()` (`studio_registry.rs`). **If you change one, change the other** — `studio-registry.test.ts` asserts the TS side and `studio_registry.rs`'s `registry_dir_is_env_scoped_under_the_storage_namespace` asserts the Rust side, but nothing cross-checks them automatically.

---

## 2. Getting to a green baseline on Windows

```powershell
bun install
cargo test  --manifest-path apps/overdare-ai-agent/Cargo.toml
cargo build --manifest-path apps/overdare-ai-agent/Cargo.toml --release
bun test ./apps/overdare-ai-agent/sidecar/test/
bun run typecheck
bun run lint
```

Expected, based on the macOS run:

- `cargo test` — 141 pass, 0 fail
- `bun test` (sidecar) — 745 pass, **3 pre-existing failures unrelated to P071**: two `procedural Luau dummy JSON runtime` cases and `app branding respects VITE_APP_PROJECT_NAME`. These fail on a clean checkout too (verified by stashing); do not chase them.

**Windows-specific things already handled** so the suite should not fail for portability reasons:

- `deadPid()` spawns `process.execPath --version`, not `sh` (which does not exist on Windows).
- Registry-path assertions use `join()` rather than `/`-separated literals.
- The `0600` mode-bit assertion is skipped on `win32` (see §3.1 — that skip is the open question, not a workaround for a bug).

If something *else* fails on Windows, it is a real finding — the whole change set has only ever run on darwin-arm64.

---

## 3. Remaining work

### 3.1 Record privacy on Windows — the one open design question

The record contains a **bearer token** that grants tool execution inside a Studio project. On POSIX it is protected by `chmod 0600` on the file and `0700` on the directory (`studio-registry.ts`, `ensureDir` / `writeRecord`). On Windows **both chmod calls are silent no-ops**, so privacy rests entirely on the default `%USERPROFILE%` ACL.

What to do:

```powershell
icacls %USERPROFILE%\.overdare\mcp\studios
icacls %USERPROFILE%\.overdare\mcp\studios\<uuid>.json
```

Then decide:

- **If the inherited ACL is already user-only** (plus SYSTEM/Administrators, which is normal): document that in `docs/guide/overdare-mcp.md` under "Security" and re-enable the mode assertion as a POSIX-only test with a comment explaining why Windows needs none. Lowest-effort correct outcome, and the likely one.
- **If the ACL is broader than expected** (e.g. an inherited grant to `Users` or `Everyone` from a customized profile or a redirected home): tighten it explicitly. Options, cheapest first: (a) `icacls /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F` on the `studios` directory at creation time, invoked from `ensureDir` on `win32`; (b) drop the token from the file entirely and have the router obtain it over a per-boot handshake. (b) is a much larger change — only go there if (a) proves insufficient.

Do not leave this undecided. A token readable by other local accounts is the only genuinely security-relevant loose end in this change.

### 3.2 Real MCP client verification

All protocol testing so far used a hand-written JSON-RPC harness (correct, but not a real client). Verify with **Claude Code** and **Claude Desktop**:

```jsonc
{
  "mcpServers": {
    "overdare": {
      "command": "C:\\path\\to\\overdare-ai-agent.exe",
      "args": ["start-mcp-router"]
    }
  }
}
```

Checklist:

1. One Studio open → tools work with no selection step.
2. Two Studios open → a Studio tool refuses, and **the model actually recovers** by calling `list_overdare_studios` then `set_active_overdare_studio`. This is the part most worth watching: if the model does not recover on its own, the fix is wording in `ROUTER_INSTRUCTIONS` (`mcp_router.rs`) and in `ambiguous_error()` (`studio_router.rs`), not mechanism.
3. Whether the client **hides or surfaces** the three session tools, and whether it lets the user invoke them.
4. **`listChanged` handling**: connect the client with no Studio open (only 3 session tools appear), then open Studio. Within ~2 s the router sends `notifications/tools/list_changed`; confirm the client re-lists and the count goes to 3 + 38 = **41**. If a client ignores the notification, note it in the guide's troubleshooting section — the fallback is "reconnect the client".
5. Diligent's own MCP client connecting to the router.

### 3.3 Packaging stability — the original motivation

The whole point of hosting the router in the launcher is that its path survives a runtime update. That has **not** been proven end to end:

1. Configure a client against the packaged `overdare-ai-agent.exe start-mcp-router`.
2. Apply a runtime update (the sidecar path changes).
3. Confirm the client still connects and tools still work with **no config change**.

If the launcher's own path can also move in some install flow, the mitigation in the plan's risk table applies: the installer owns writing the MCP client config.

### 3.4 Optional improvement

`list_overdare_studios` currently reports **sidecar** reachability, not Studio RPC reachability. So a sidecar whose Studio has detached still lists as available. Adding a Studio RPC probe would let the tool distinguish "sidecar up, Studio detached". Deliberately out of scope; decide whether it is worth it after using the router for real.

---

## 4. Invariants not to break

These are load-bearing; each one exists because the alternative was tried or reasoned through and is wrong.

1. **stdout is protocol-only.** Any stray `println!` in the router corrupts JSON-RPC framing and the client drops the session mid-turn. Diagnostics go to stderr. A single writer task owns stdout so watcher notifications cannot interleave with responses.
2. **Experiment gating must stay in `registries()` (`server.ts`).** The first working version omitted it and the router advertised `studiorpc_procedural_run` and `agent-procedural-builder`, both gated off by default, while `mcp-serve` correctly hid them. Both surfaces must report the same tool count (38).
3. **Tool failures answer HTTP 200 with `isError`.** A 4xx reads to the router as a dead sidecar and wrongly clears the active selection. Only a *transport* failure should clear it.
4. **Ambiguity and "no Studio open" are tool errors, not JSON-RPC errors.** The model has to read them and act; a protocol-level failure gives it nothing to do.
5. **Registration must not block startup.** The launcher parses `DILIGENT_PORT` under a timeout, so the record is written as soon as the port is known and the catalog follows via `updateCatalog()`.
6. **`registration.stop()` is synchronous.** It runs from `process.on("exit")` and signal handlers, where an awaited unlink never completes.
7. **Session tools are never shadowed** by a Studio catalog entry of the same name, or selection becomes unreachable.
8. **`extraRoutes.matches` stays synchronous.** Making Bun's `fetch` async breaks the `/rpc` WebSocket upgrade.
9. **Auto-selection is sticky.** Once a single Studio is auto-selected, a second Studio opening must not silently retarget an in-flight session.

---

## 5. Reproducing the macOS manual test on Windows

Two sidecars against one temp home, then drive the router by piping JSON-RPC lines. Adapt paths for PowerShell:

```powershell
# terminal 1 and 2 — two sidecars, two project dirs, one shared HOME
$env:USERPROFILE="C:\temp\mcp-e2e\home"; $env:DILIGENT_STORAGE_NAMESPACE="overdare"
bun run apps/overdare-ai-agent/sidecar/src/server.ts --port=0 --cwd=C:\temp\mcp-e2e\proj1
bun run apps/overdare-ai-agent/sidecar/src/server.ts --port=0 --cwd=C:\temp\mcp-e2e\proj2

# terminal 3 — inspect the records, then drive the router
dir $env:USERPROFILE\.overdare\mcp\studios
Get-Content requests.jsonl | .\apps\overdare-ai-agent\target\release\overdare-ai-agent.exe start-mcp-router
```

`requests.jsonl`, one JSON object per line:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_overdare_studios"}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ensure_system_prompt","arguments":{}}}
```

What the macOS run produced, for comparison:

| Scenario | Result |
|----------|--------|
| One Studio | auto-selected; `ensure_system_prompt` returned the real prompt through the HTTP proxy |
| Two Studios | Studio tools refused; after `set_active_overdare_studio` only the selected sidecar received the call |
| `tools/list` | 3 session + 38 Studio = 41 |
| SIGTERM a sidecar | record deleted immediately; survivor auto-selected |
| SIGKILL a sidecar | record lingers, ignored after the 15 s staleness window |
| Legacy `mcp-serve` | still initializes, lists 38 tools, stdout clean |

On Windows the SIGTERM equivalent is a graceful close; a `Stop-Process -Force` stands in for SIGKILL. Note that the sidecar's cleanup runs from `exit`/`SIGTERM`/`SIGINT` handlers — if Windows terminates it without running those, the record is left to expire by heartbeat, which is the designed fallback and not a bug.

---

## 6. When this can be marked complete

Close out §3.1 (a decision, not necessarily code), §3.2, and §3.3; record the results in the plan's "Remaining before this can be marked complete" section and flip `status: active` to `complete`. §3.4 is optional and can be split into its own plan.
