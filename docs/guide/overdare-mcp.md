# OVERDARE MCP router

The OVERDARE AI agent exposes OVERDARE Studio's tools to any [MCP](https://modelcontextprotocol.io) client (Claude Code, Claude Desktop, Diligent itself) through the dedicated `overdare-mcp` executable.

Two problems the router solves:

- **A stable command to configure.** The Bun sidecar's path changes with every runtime update, so pointing an MCP client at it breaks on the next update. The router is installed beside the stable launcher and does not move.
- **A distinct process identity.** Studio launchers may identify a running product by executable name. A dedicated router name prevents one stdio process per MCP client from being mistaken for an already-running Studio.
- **Multiple Studio windows.** Studio tools used to be bound to a single `STUDIO_PORT` chosen when the server started. With two projects open, a tool call had no defined target. The router discovers every open Studio and routes each call to the one you selected.

## Setup

Point your MCP client directly at the dedicated router executable:

```jsonc
{
  "mcpServers": {
    "overdare": {
      "command": "C:\\path\\to\\overdare-mcp.exe"
    }
  }
}
```

Pass `--agent-env=dev` to target the dev release channel, which uses a separate storage namespace (`~/.overdare-dev`) and therefore a separate set of Studio instances:

```jsonc
{ "command": "...\\overdare-mcp.exe", "args": ["--agent-env=dev"] }
```

To pin one Studio instance without a tool call — useful in a wrapper script — pass `--studio-id=<id>`. An id that is not running is dropped on first use rather than failing every call.

No Studio-specific ports, paths, or tokens go into the client config. The router discovers all of that at run time.

## Working with multiple Studios

The router adds three tools on top of the Studio tools:

| Tool | Purpose |
|------|---------|
| `list_overdare_studios` | Show every open Studio: id, project folder, cwd, Studio RPC address, and which is active |
| `set_active_overdare_studio` | Choose which Studio subsequent tool calls target (takes an `id`) |
| `get_active_overdare_studio` | Report the current target |

Selection behavior:

| Situation | What happens |
|-----------|--------------|
| One Studio open | Auto-selected. No extra tool calls needed. |
| No Studio open | Studio tools return a clear error asking you to open a Studio project. |
| Several open, none selected | Studio tools **refuse**, and the error tells the agent to call `list_overdare_studios` then `set_active_overdare_studio`. Guessing would edit the wrong project. |
| Selection stays put | Once selected (including by auto-select), the target does not move when another Studio opens. |
| Selected Studio closes | The selection is released and the next call re-resolves, with an error explaining what happened. |

Selection lives in the router process. Because stdio gives each MCP client its own router process, two clients can target two different Studios at the same time without interfering.

The general `overdare-ai-agent start-mcp-router` command remains available for compatibility, but new client configuration should use `overdare-mcp` so those per-client processes cannot be confused with Studio's launcher.

## How it works

```
MCP client ──stdio──> overdare-mcp
                           │  reads ~/.overdare/mcp/studios/*.json
                           │  (one record per open Studio)
                           └──HTTP──> the selected Studio's sidecar
                                       /mcp-router/tools/call
```

Each Studio's sidecar registers itself on startup, writing a record containing its id, project folder, Studio RPC address, sidecar URL, a bearer token, its pid, and a snapshot of its MCP tool/prompt catalog. It refreshes a heartbeat every 5 s and deletes the record on clean shutdown.

The router reads those records to list instances and to resolve a target, then forwards the call to that sidecar's authenticated loopback endpoint. **Tool behavior stays in the sidecar** — approvals, rollback snapshots, render payloads, and skills all run exactly as they do over `mcp-serve`, including experiment gating. The router adds routing and nothing else.

Because the catalog snapshot is in the record, the router can advertise the Studio tools without contacting a sidecar first, and it declares MCP's `listChanged` capability: open a Studio after connecting your client and the tool list updates without reconnecting.

### Security

Everything is loopback-only. Records live under your user-private storage directory (`0700`, records `0600`) and each carries a per-process bearer token the router must present. A hard-killed sidecar's record is ignored once its heartbeat expires (15 s), and the router health-probes candidates before disambiguating, so a leftover record never makes the target look ambiguous.

## Legacy `mcp-serve`

The previous single-Studio entrypoint still works unchanged:

```jsonc
{ "command": "/path/to/diligent-web-server", "args": ["mcp-serve"] }
```

It runs one MCP server bound to one Studio via `STUDIO_PORT`. Prefer `start-mcp-router` — `mcp-serve` needs the moving runtime path and has no notion of multiple Studios.

## Troubleshooting

**"No OVERDARE Studio is currently open"** — no live record. Confirm a Studio project is open and that its sidecar started, then check `~/.overdare/mcp/studios/` for a `.json` file. `--agent-env` mismatch is a common cause: the dev channel reads `~/.overdare-dev`.

**Studio tools refuse as ambiguous** — more than one Studio is open. Call `list_overdare_studios`, then `set_active_overdare_studio`. If a project you closed is still listed, its record has not expired yet; it disappears within 15 s.

**Only the three session tools appear** — no catalog has been published yet. The sidecar writes it shortly after startup. Clients honoring `listChanged` pick it up automatically; otherwise reconnect.

**"Lost contact with OVERDARE Studio"** — the selected sidecar went away. The selection is already cleared; select again and retry.

**Diagnostics** — the router logs to stderr, never stdout (stdout is the JSON-RPC stream). Check your MCP client's server log for `[mcp-router]` lines, which include the registry directory being watched.

## See also

- [MCP servers](./mcp-servers.md) — configuring Diligent as an MCP *client*
- `docs/plan/feature/P071-overdare-mcp-router.md` — design rationale and decisions
