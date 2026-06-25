# OVERDARE Dev Switchboard

Use this workflow when a Windows test machine must keep one fixed URL while the
Mac swaps between multiple Diligent/OVERDARE dev worktrees.

## Shape

```text
Windows
  http://<mac-ip>:11000

Mac
  dev-switchboard :11000
    active target -> <worktree-host>.localhost

  portless proxy :11001
    diligent.localhost             -> main worktree Vite port
    fix-autoplay.diligent.localhost -> feature worktree Vite port

  each worktree
    sidecar backend -> private free port
    Vite web server -> PORT assigned by Portless
    Vite /rpc proxy -> that worktree's sidecar backend
```

The Windows URL stays fixed. The Mac changes only the active switchboard target.

## One-Time Local Env

Portless is installed from the root dev dependencies, so `bun install` is enough.

Create `.env.overdare.local` at the repository root. It is ignored by git.

```sh
OVERDARE_PROJECT_CWD=/Volumes/overdare-newgame
DILIGENT_STORAGE_NAMESPACE=overdare
DILIGENT_ENV=prod
STUDIO_HOST=10.40.32.100
STUDIO_PORT=13377
OVERDARE_WINDOW_MCP_URL=http://10.40.32.100:8765/mcp
OVERDARE_WINDOW_MCP_TOKEN=replace-with-local-token
```

Shell environment variables override values from this file.

## Start Dev Worktrees

Run this from each git worktree you want available:

```sh
bun run dev:overdare
```

The first run also starts the fixed Windows-facing gateway. Later worktrees
detect the gateway and only start their own Portless-managed dev instance.

Open the control UI from either machine:

```text
http://<mac-ip>:11000/_dev
```

The launcher starts both processes:

```text
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=<free-port> --cwd=$OVERDARE_PROJECT_CWD
bun run --cwd packages/web dev --host $HOST --port $PORT
```

It also wires Vite's `/rpc` proxy to the matching sidecar backend using
`DILIGENT_WEB_RPC_TARGET`.

## Switch Targets

Use the GUI at `/_dev`, or switch from the terminal:

```sh
bun run dev:overdare use fix-autoplay.diligent.localhost
bun run dev:overdare list
```

Refresh the Windows browser or test runner after switching. Existing WebSocket
connections may still point at the previous active target until they reconnect.

## Useful Overrides

Use a fixed sidecar backend port:

```sh
bun run dev:overdare -- --backend-port 7445
```

Use a different OVERDARE project cwd:

```sh
bun run dev:overdare -- --project-cwd /Volumes/other-game
```

Use a custom Portless state directory or an already-running Portless proxy:

```sh
bun run dev:overdare \
  --routes-file ~/.portless-lan/routes.json \
  --portless http://127.0.0.1:11001
```

Use explicit subcommands only when debugging the wrapper or running the gateway
without an instance:

```sh
bun run dev:overdare gateway
bun run dev:overdare instance
bun run dev:overdare-instance --help
bun run dev:switchboard --help
```
