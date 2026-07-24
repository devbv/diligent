# Local Development / Integration Test Guide

How to run the web backend, frontend, and sidecar (Studio integration) locally for testing.

## Overview

The runtime splits into three processes.

```
Browser (5174, Vite)  --HTTP/HMR-->  Vite dev server
        |
        +-- /rpc (WebSocket) --proxy-->  Backend RPC server (7433)
                                              |
                                              +-- (sidecar only) TCP -->  OVERDARE Studio (STUDIO_PORT, default 13377)
```

The product sidecar is the only browser-host entrypoint. It supports two development modes; the only difference is *whether the Studio integration tools are attached*.

| Backend | Entrypoint | Studio tools | Web UI | Store | Use |
| --- | --- | --- | --- | --- | --- |
| **UI-only sidecar** | `apps/overdare-ai-agent/sidecar/src/server.ts` with `STUDIO_DISABLED=1` | none | yes | `.overdare` | web UI work only |
| **Studio sidecar** | `apps/overdare-ai-agent/sidecar/src/server.ts` | `studiorpc_*` | yes | `.overdare` | Studio integration testing |

> Key point: UI-only development still runs the product sidecar. `STUDIO_DISABLED=1` skips the Studio RPC provider, the gateway-backed consent service, and record transmission, so it makes no Studio or gateway network requests.

Vite proxies `/rpc` to `ws://localhost:7433` (`apps/overdare-ai-agent/sidecar/vite.config.ts`), so both sidecar modes use the same frontend connection.

### Make target mapping

| What you want | One-line command | Manual (see modes below) |
| --- | --- | --- |
| UI-only sidecar + frontend (one command) | **`make web-dev`** | Mode A |
| UI-only sidecar backend only | `STUDIO_DISABLED=1 bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev` | — |
| frontend only (Vite) | `bun run --cwd apps/overdare-ai-agent/sidecar web:dev` | Mode A or B manual |
| sidecar + frontend (local Studio) | **`make dev-agent`** | Mode B |
| sidecar + frontend, no Studio (no 13377) | **`make dev-agent-nostudio`** | — |
| sidecar + frontend (remote Studio) | **`make dev-cross`** | [`mac-agent-windows-studio.md`](./mac-agent-windows-studio.md) |

---

## Prerequisites

```bash
bun install
```

- AI provider (to run chat): connect in the app UI under `Config -> AI connection`, or it is used automatically if credentials are in the keychain / `.env.local`.
- Conversation history, skills, and config are stored under `<cwd>/.overdare/` (or `.overdare-dev/` when selected by the product environment). The sidecar sets the product namespace for direct development runs.

---

## Mode A — UI-only sidecar (no Studio tools)

Lightest option when you only want to see web UI changes (code blocks, copy button, Config panel, etc.). (`studiorpc_*` tools are not attached.)

```bash
make web-dev
#   Starts both, together (Ctrl+C stops both):
#     - sidecar backend RPC (:7433) with STUDIO_DISABLED=1
#     - Vite frontend (:5174)
```

Browser: **http://localhost:5174**

Need just one half? Run the backend alone with `STUDIO_DISABLED=1 bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev`, or the frontend alone with `bun run --cwd apps/overdare-ai-agent/sidecar web:dev`.

---

## Mode B — sidecar (Studio integration included)

Attaches the `studiorpc_*` tools and talks to Studio over TCP. Store is `.overdare`.

**Recommended: one command** (runs sidecar + Vite together; port cleanup, bundle-skill symlink, and `.overdare` correction are automatic):

```bash
make dev-agent                 # connect to a local Studio (localhost)
#   If Studio is on another machine -> make dev-cross (see mac-agent-windows-studio.md)
```

**Manual (to understand the moving parts, two terminals):**

```bash
# Terminal 1 — sidecar backend (7433) + STUDIO_PORT
STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$(pwd)"

# Terminal 2 — frontend (Vite, 5174)
# Run Vite directly; `make web-dev` would start a second backend on 7433.
bun run --cwd apps/overdare-ai-agent/sidecar web:dev
```

Browser: **http://localhost:5174**

Extra Studio-related env (only when you need those tools):

```bash
STUDIO_PORT=13377 \
STUDIO_HOST=localhost \          # when Studio is on a different host
HUB_DOMAIN=hub.example.com \     # hub-token / publish-family tools
OVERDARE_PROJECT_ID=proj-123 \   # project-scoped tools
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$(pwd)"
```

> WARNING: **OVERDARE Studio (the editor) must be listening for RPC on that port** for the connection to work. In dev, put the port your local Studio is actually listening on into `STUDIO_PORT`.

---

## Port / environment variable reference

| Item | Value | Notes |
| --- | --- | --- |
| Vite frontend | `5174` | `server.port` in `apps/overdare-ai-agent/sidecar/vite.config.ts` |
| Backend RPC | `7433` | change with `--port=`, default if unset. Vite proxy target |
| Studio RPC | `13377` | change with `STUDIO_PORT`, default if unset |

Common sidecar backend args (`parseArgs`, shared by both Studio modes):

| Arg | Meaning |
| --- | --- |
| `--port=N` | backend HTTP/WS port (default 7433) |
| `--dev` | dev mode (no static file serving; Vite handles the frontend) |
| `--cwd=PATH` | working directory (base path for sessions/config) |
| `--userid=...` | user ID |
| `--dist-dir=PATH` | build dir for production serving (not needed in dev) |

Sidecar-only env (injects the studio bundle tools):

| env | Meaning |
| --- | --- |
| `STUDIO_PORT` | Studio RPC port |
| `STUDIO_HOST` | Studio RPC host (default localhost) |
| `HUB_DOMAIN` | hub-token / publish family |
| `OVERDARE_PROJECT_ID` | project-scoped tools |

---

## How the Studio RPC port is decided

In the released exe, `--studio-rpc-port` is **converted to the `STUDIO_PORT` environment variable** and injected into the sidecar.

```
exe arg  --studio-rpc-port=N
  -> (apps/overdare-ai-agent/src/webserver.rs)  injects env STUDIO_PORT=N into the child sidecar
  -> (apps/overdare-ai-agent/sidecar/src/server.ts)  reads process.env.STUDIO_PORT
  -> createStudioBundledToolProviders({ studioRpcPort })  -> injected as bundledToolProviders
  -> studiorpc tools connect over TCP to localhost:STUDIO_PORT
```

Runtime resolution order (`sidecar/src/tools/studiorpc/rpc.ts`):

1. `STUDIO_PORT` / `STUDIO_HOST` environment variables
2. config file `~/.overdare/overdare.jsonc` (or `~/.diligent/overdare.jsonc` if missing)
   ```jsonc
   { "host": "localhost", "port": 13377 }
   ```
3. default `localhost:13377`

So in dev, passing `STUDIO_PORT` as env matches the exe behavior. If specifying it every time is tedious, write it once into the config file above.

---

## Sanity check (smoke test)

Confirm it booted:

```bash
lsof -nP -iTCP:7433 -sTCP:LISTEN   # backend
lsof -nP -iTCP:5174 -sTCP:LISTEN   # frontend
```

The backend log shows this when healthy:

```
DILIGENT_PORT=7433
RPC endpoint: ws://localhost:7433/rpc
```

- **Web UI**: open http://localhost:5174 -> the chat UI appears (not a blank page) and the connection status (top-right) is connected.
- **Studio (Mode B)**: ask the agent to do something like `studiorpc_level_browse` and check that Studio responds. On failure, first check `STUDIO_PORT` and whether Studio is listening.

---

## Shutdown / cleanup

```bash
# kill by port
lsof -ti:7433 | xargs kill
lsof -ti:5174 | xargs kill
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| UI loads but RPC won't connect | Backend (7433) is not up. The Vite proxy target is fixed at 7433 — set the backend port to 7433 |
| `studiorpc_*` tools not visible | Started with `STUDIO_DISABLED=1`. Restart the sidecar without it (`make dev-agent`) |
| Studio connection timeout | `STUDIO_PORT` unset/wrong, or Studio is not listening on that port |
| Copy button works on localhost but not over LAN (past bug) | `navigator.clipboard` is secure-context only (HTTPS/localhost) — non-secure uses the fallback path |
| Port conflict (`EADDRINUSE`) | Kill the existing process (shutdown command above) and rerun |

---

## Reference (code locations)

- sidecar entrypoint: `apps/overdare-ai-agent/sidecar/src/server.ts`
- web host modules: `apps/overdare-ai-agent/sidecar/src/web/`
- studio bundle tools: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/`
- exe arg -> env conversion: `apps/overdare-ai-agent/src/webserver.rs`
- Vite proxy config: `apps/overdare-ai-agent/sidecar/vite.config.ts`
