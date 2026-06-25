# Packaging

This guide describes the current packaging model in Diligent.

## Verified contract

Diligent packaging spans three related product surfaces:

- CLI
- Web/server
- Desktop

The main packaging path today is the OVERDARE CLI runtime/sidecar packaging flow.

That flow owns:

- building the web client bundle used by the packaged runtime
- compiling the Bun sidecar server binary
- assembling default resources for packaged installs
- creating runtime update bundles under `dist/`
- generating update and release metadata

## Entry points

Current operator-facing entry points are:

- repo root: `bun run overdare-ai-agent:build-sidecar`
- sidecar-only helper: `scripts/build-overdare-sidecar.ts`

`scripts/build-overdare-sidecar.ts` is the current operator-facing build helper in this repo.

## Current pipeline shape

At a high level, packaging does the following:

1. build the web frontend used by the runtime
2. compile the sidecar server for the current native-build platform
3. assemble runtime defaults content from the OVERDARE CLI-owned asset roots
4. publish runtime bundles via the OVERDARE CLI release flow as needed

## Runtime packaging relationship

The sidecar serves the React client and hosts `DiligentAppServer` over WebSocket JSON-RPC. Packaging therefore needs to bundle both UI assets and runtime assets coherently for the OVERDARE CLI launcher.

For launcher/runtime coordination, the packaged sidecar announces its bound port on stdout as `WEBSERVER_PORT=<port>`. When the OVERDARE launcher is started with `--studio-rpc-port=<port>`, it forwards that value to the runtime subprocess so bundled product tools and any remaining packaged plugins can reach OVERDARE Studio RPC.

## Platform model

The current sidecar helper targets the current host platform via `scripts/build-overdare-sidecar.ts`.

Known targets currently include:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `linux-arm64`
- `windows-x64`

Each platform maps packaging-time concerns together:

- Bun compile target
- executable extension
- OS/architecture metadata

## Release env (prod / dev)

The runtime bundle release flow is parameterized by a `prod` / `dev` env that is selected at release time and threaded through every artifact name, manifest, and GitHub Release tag.

- Tag scheme: `prod-v<version>` (published, non-prerelease) and `dev-v<version>` (published, prerelease)
- Runtime bundle filename: `overdare-ai-agent-runtime-{env}-{version}-{platform}.zip`
- Agent launcher filename: `overdare-ai-agent-{env}-{version}-{platform}.exe`
- Manifest filename: `update-manifest-{env}.json` (carries an `"env"` field that matches)
- Manifest URL the agent fetches (resolved from env + optional pin):
  - prod latest → `releases/latest/download/update-manifest-prod.json` (relies on GitHub's "latest" skipping prereleases)
  - dev latest → `releases/download/dev-latest/update-manifest-dev.json` (rolling release re-created on every dev publish)
  - `{env}@<version>` pin → `releases/download/{env}-v<version>/update-manifest-{env}.json`

Dev publishes also re-create a rolling `dev-latest` release pointing at the same artifacts as the most recent `dev-v<version>` release, so the agent's dev-latest URL is always live. The release workflow verifies after creation that both releases are marked `prerelease=true` and aborts if not, to prevent dev artifacts from polluting the prod "latest" redirect.

For one to two prod release cycles after this contract lands, prod releases additionally upload legacy alias files (`update-manifest.json`, `release-meta.json`, `checksums.sha256`) so agents built before the env split keep updating cleanly. After the migration window those aliases are removed.

## Runtime install layout (on disk)

The published bundle contents are unchanged, but the agent installs them into a
versioned directory and selects the active version with a pointer file. This
keeps an update from deleting a runtime that a running sidecar still holds (a
locked `diligent-web-server.exe` on Windows).

```text
~/.overdare/updates/                 # ~/.overdare-dev/updates/ for dev
  runtime-current.json               # active-version pointer (single version)
  runtime-v<version>/                # one directory per installed version
    diligent-web-server[.exe]
    dist/client/
    bootstrap/
    version.json
```

- `runtime-current.json` is the source of truth for the active runtime: a single
  `{ version, dir, sha256, updated_at }` record (not a list). It is written
  atomically (temp-file + rename) after the new version directory is in place.
- `updates/runtime` (flat, unversioned) is the legacy layout, kept only as a
  fallback for installs predating versioning. The first successful versioned
  update writes the pointer and stops using the flat layout.
- An update installs to `runtime_staging_<version>/`, validates the layout
  (sidecar + `dist/client`), promotes it to `runtime-v<version>/`, then flips the
  pointer. The previously active version is **not** removed by the update step.
- `start --agent-env=<env>@<version>` launches that exact version directly; with
  no pin it follows the pointer (then legacy fallback). A pinned version that is
  not installed is an error, never a silent fallback.
- Old, idle version directories are cleaned up best-effort after the pointer
  switch, never deleting the active or an in-use version. On Windows this uses an
  exclusive-open probe before deleting; on mac/Linux destructive cleanup is not
  run yet (not targeted by Studio).

## Defaults resource assembly

OVERDARE-owned defaults now live under `apps/overdare-ai-agent/`:

- `apps/overdare-ai-agent/bootstrap/`
- `apps/overdare-ai-agent/plugins/`

At bundle assembly time these assets are staged under `defaults/` for compatibility with existing updater expectations. The launcher prefers an updated `bootstrap/` directory if present at runtime and otherwise falls back to the legacy `defaults/` path.

First-party executable TypeScript tools should move to bundled providers in `apps/overdare-ai-agent/sidecar/src/tools` instead of being shipped as copied plugin folders. During migration, a bundled provider can declare the legacy package in `supersedesPluginPackages` so stale plugin copies are suppressed. Only remove a plugin from `apps/overdare-ai-agent/plugins/` after the bundled equivalent has been verified.

## Sidecar build

The OVERDARE sidecar is compiled from `apps/overdare-ai-agent/sidecar/src/server.ts` using `bun build --compile`. That product entrypoint imports the generic `@diligent/web/server` and injects OVERDARE bundled tool providers without placing product code in `packages/web` or `packages/runtime`.

The sidecar helper script can build a fresh current-platform runtime binary for OVERDARE CLI diagnostics and launcher flows.

## Outputs and artifact layout

The current packaging flow assembles release artifacts under `dist/`.

Common outputs include the compiled sidecar binary and runtime bundle contents used by OVERDARE CLI.

## Change checklist

1. Decide whether the change affects sidecar build, runtime bundle assembly, or both.
2. If the shipped runtime contents change, update bootstrap/plugin ownership and runtime bundle layout together.
3. Verify whether OVERDARE CLI launcher/update expectations also need changes.
4. For first-party tool migrations, preserve tool names, schemas, render payloads, approval prompts, and user-input behavior before removing the legacy plugin artifact.

## Key code paths

- `scripts/build-overdare-sidecar.ts`
- `apps/overdare-ai-agent/sidecar/src/server.ts`
- `apps/overdare-ai-agent/sidecar/src/tools/`
- `apps/overdare-ai-agent/README.md`
- `apps/overdare-ai-agent/bootstrap/`
- `apps/overdare-ai-agent/plugins/`
- `package.json`
