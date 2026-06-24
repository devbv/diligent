# apps/overdare-ai-agent

Rust CLI for OVERDARE runtime bootstrap, plugin/bootstrap ownership, and webserver launch.

It currently provides two commands:

- `init` — show current/latest version and ensure the runtime is downloaded; updates unless `--skip-update` is used
- `start` — run the active runtime's `diligent-web-server` binary as a subprocess (see [Runtime install layout](#runtime-install-layout))

## Release env selection

A single global flag `--agent-env=<env>[@<version>]` controls which release channel the agent talks to.

- `<env>` is `prod` or `dev`.
- `@<version>` is optional. When omitted, the agent fetches the **latest** release for that env. When supplied, the agent pins to that exact version and skips drift checks.

Resolution priority (high → low):

1. `--agent-env=<env>[@<version>]` CLI flag
2. `DILIGENT_ENV` environment variable (same grammar)
3. `option_env!("DILIGENT_ENV")` baked at build time
4. Default: `prod` (latest)

The flag may be placed either before or after the subcommand.

### Storage isolation

Each env writes to its own root, so prod and dev installs coexist on one machine:

| Env | Global root |
|---|---|
| `prod` | `~/.overdare/` |
| `dev` | `~/.overdare-dev/` |

Project-local storage follows the same rule (`<cwd>/.overdare/` vs `<cwd>/.overdare-dev/`). Switching env in one terminal session does not touch the other env's state.

### Manifest URLs

| Selection | Manifest URL |
|---|---|
| `prod` (latest) | `releases/latest/download/update-manifest-prod.json` |
| `dev` (latest) | `releases/download/dev-latest/update-manifest-dev.json` (rolling) |
| `prod@<version>` | `releases/download/prod-v<version>/update-manifest-prod.json` |
| `dev@<version>` | `releases/download/dev-v<version>/update-manifest-dev.json` |

Override the manifest URL entirely with `DILIGENT_UPDATE_URL` (runtime env var) for diagnostics or local mirroring. The downloaded manifest must still carry an `env` field that matches the requested env, otherwise the agent rejects it.

## Runtime install layout

Runtime bundles install into version-specific directories inside the env-specific
updates root, and a small pointer file selects the active version. An update
installs the new bundle **beside** the active one and atomically flips the
pointer, so an update never deletes a runtime that a running sidecar may still be
using (this matters most on Windows, where a running `diligent-web-server.exe` is
locked).

```text
~/.overdare/updates/
  runtime-current.json     # active-version pointer (single version)
  runtime-v1.2.3/          # diligent-web-server, dist/client/, bootstrap/, version.json
  runtime-v1.2.4/
```

- **`runtime-current.json`** is the source of truth for the active runtime. It
  holds exactly one version (the one a no-pin `start` launches) — it is not a
  list and does not track previous versions.
- **`updates/runtime`** (flat, unversioned) is the legacy layout and is used only
  as a fallback for installs that predate versioning. On the next `init`, a flat
  install is migrated into the versioned layout: the flat directory is copied to
  `runtime-v<version>` (copied, not moved, so a running sidecar is undisturbed)
  and the pointer is written. This runs even when the version is already up to
  date, so pinned `start` (`@<version>`) works without waiting for a real update.
  Migration is best-effort; if it fails, the no-pin legacy fallback still boots
  the agent.
- Each `runtime-v<version>/` keeps the same internal bundle shape (sidecar
  binary, `dist/client`, `bootstrap/`, optional `rg`, `version.json`).

### Version-pinned start

`start --agent-env=<env>@<version>` launches that exact installed version,
independent of the pointer — so multiple agents can run different versions
concurrently. If the pinned version is not installed, `start` fails with a clear
"run init first" message and never falls back to a different version. Without a
pin, `start` uses `runtime-current.json` (then the legacy fallback).

### Old-version retention

After the pointer switch, the updater best-effort cleans up idle, non-active
version directories. It never deletes the active runtime or a version still in
use, and a cleanup failure can never fail an otherwise-successful update.

- **Windows:** before deleting, it probes whether a version's sidecar binary is
  locked (in use) and skips the whole directory if so, so a running version is
  preserved and partially-deleted directories are avoided.
- **mac / Linux:** not targeted by Studio yet, so destructive cleanup is not run
  there (POSIX would let an in-use runtime be unlinked). Old directories simply
  accumulate until this is enabled with explicit in-use detection.

Both prod (`~/.overdare/`) and dev (`~/.overdare-dev/`) roots follow this layout.

## Commands

```bash
# Build the Rust CLI
cargo build --manifest-path apps/overdare-ai-agent/Cargo.toml --release

# Or via repo root shortcut
bun run overdare-ai-agent:build

# Initialize runtime, print current/latest version, and apply update if needed
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- init

# Same, but target the dev env (downloads/stores under ~/.overdare-dev/)
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- --agent-env=dev init

# Pin to a specific version (no auto-update beyond this version)
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- --agent-env=prod@1.2.3 init

# Skip update only if runtime was already downloaded before
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- init --skip-update

# Start the active local web server runtime
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- start --cwd=/path/to/project

# Start a specific installed version (must have been init'd first); independent of the active pointer
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- --agent-env=prod@1.2.3 start --cwd=/path/to/project

# Start the web server and forward a Studio RPC port to plugins via STUDIO_PORT
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- start --cwd=/path/to/project --studio-rpc-port=13377

# Start the web server on a fixed port (instead of random)
cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- start --cwd=/path/to/project --web-server-port=3000

# Run Rust tests
bun run overdare-ai-agent:test

# Initialize from a custom manifest URL
DILIGENT_UPDATE_URL=https://example.com/update-manifest.json cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- init
```

## Notes

- `start` does not execute repo TypeScript directly; it launches the updated runtime subprocess
- `start` prints the selected runtime port as `WEBSERVER_PORT=<port>` on stdout
- `start --studio-rpc-port=<port>` forwards that value to the runtime subprocess as `STUDIO_PORT`
- `start --web-server-port=<port>` requests a fixed runtime web server port (omit to use random port)
- `start` forwards both `DILIGENT_ENV` and an env-correct `DILIGENT_STORAGE_NAMESPACE` to the runtime child so it routes to the same storage root
- `init` downloads the runtime bundle shape used by OVERDARE CLI: sidecar binary, `dist/client`, optional `rg`, and runtime defaults (`bootstrap/` preferred, legacy `defaults/` fallback)
- on first run, `init --skip-update` is rejected until the runtime exists locally at least once
- if `~/.overdare/config.jsonc` (or `~/.overdare-dev/config.jsonc` for dev) sets `"updateMode": "disabled"`, runtime update behavior follows that config
- `init --skip-update` intentionally exits with code `1` when no runtime has been downloaded yet
- repo root shortcuts:
  - `bun run overdare-ai-agent:build`
  - `bun run overdare-ai-agent:test`
  - `bun run overdare-ai-agent:init`
  - `bun run overdare-ai-agent:webserver -- --cwd=/path/to/project`

Additional OVERDARE-owned assets now live here as well:

- `apps/overdare-ai-agent/bootstrap/`
- `apps/overdare-ai-agent/plugins/`
- `apps/overdare-ai-agent/scripts/deploy.ts`
- `apps/overdare-ai-agent/scripts/tool-cli.ts`
