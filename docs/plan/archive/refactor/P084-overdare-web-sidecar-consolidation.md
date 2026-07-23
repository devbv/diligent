---
id: P084
status: planned
created: 2026-07-23
---

# Consolidate the OVERDARE Web Host into the Sidecar

## Purpose

This document hands off the removal of the standalone `@diligent/web` workspace package.

The current Web server, React client, and OVERDARE sidecar are one shipped product unit:

- the sidecar executable hosts `DiligentAppServer` over WebSocket;
- the same executable serves the built React client;
- the runtime bundle always ships the executable and `dist/client` together;
- the only in-repository consumers of `@diligent/web` are the OVERDARE sidecar;
- the Web surface already contains OVERDARE-owned consent, Studio bridge, tool presentation,
  and first-run behavior.

The target is therefore one product-owned TypeScript workspace at
`apps/overdare-ai-agent/sidecar`. The Web implementation remains modular inside that workspace,
but it is no longer presented as a generic Diligent package.

## Decision summary

Move all source, tests, build configuration, and static client assets from `packages/web` into
`apps/overdare-ai-agent/sidecar`.

Use the following ownership model:

```text
apps/overdare-ai-agent/
  src/                         Rust launcher and updater
  bootstrap/                   Product-managed runtime content
  sidecar/                     One TypeScript product runtime workspace
    src/
      server.ts                Final OVERDARE process entrypoint
      web/
        server/                HTTP, WebSocket, images, static hosting
        client/                React application
        shared/                Web-local contracts and route helpers
      tools/                   OVERDARE bundled tool providers
      mcp-server.ts            MCP subcommand of the same executable
    test/
      web/                     Moved Web client/server/shared tests
      tools/                   Existing product tool tests
    index.html
    vite.config.ts
    tailwind.config.ts
    postcss.config.cjs
    package.json
    tsconfig.json
    dist/client/               Generated Vite output
```

`createWebServer()` remains a separate module under `sidecar/src/web/server`. The package boundary
is removed; the module boundary is retained.

The `@diligent/web` package name, exports, and workspace dependency are deleted. The existing
`@overdare/ai-agent-sidecar` package absorbs the React and Vite dependencies.

Do not create a replacement `@overdare/*-web` package. There is no second consumer that justifies
another package boundary.

## Architectural rationale

### The deployment unit is already the sidecar

`scripts/build-overdare-runtime-bundle.ts` builds the Web client, compiles
`apps/overdare-ai-agent/sidecar/src/server.ts`, and places both outputs in the same versioned runtime
bundle. The Rust launcher starts that executable and expects it to serve the bundled client.

The separately named Web package does not have an independent release, launcher, or production
consumer.

### The current abstraction is inverted

Today, the larger Web server implementation lives in `packages/web`, while the product sidecar
entrypoint is a thin wrapper that injects bundled tools, experiments, and consent. This makes the
product-owned host appear generic even though:

- `packages/web/src/shared/consent-protocol.ts` explicitly defines an OVERDARE product contract;
- the client contains Studio RPC presentation and `AgentNativeBridge` integration;
- the client renders OVERDARE asset search and human Studio edits;
- the production build is only assembled by the OVERDARE runtime bundle flow.

Moving the code under the sidecar makes the filesystem boundary match the runtime and product
boundary.

### Shared behavior remains shared through protocol and runtime

This consolidation does not move agent behavior into the client. The existing responsibilities
remain:

- `packages/runtime` owns agent/session behavior and `DiligentAppServer`;
- `packages/protocol` owns shared Diligent JSON-RPC contracts;
- `apps/overdare-ai-agent/sidecar/src/web` owns the OVERDARE browser host and presentation;
- `apps/overdare-ai-agent/sidecar/src/tools` owns OVERDARE product tools and hooks.

If another real product later needs a Web host, extract only the demonstrated common modules at
that time. Do not preserve a speculative generic Web package in this refactor.

## Scope

### In scope

- Move all tracked files under `packages/web` into the sidecar workspace.
- Merge package dependencies, scripts, TypeScript settings, and Vite/Tailwind configuration.
- Replace `@diligent/web` imports with sidecar-local imports.
- Remove the `@diligent/web` workspace package and lockfile entry.
- Make the sidecar the only Web backend entrypoint.
- Route UI-only development through the sidecar with Studio tools disabled.
- Update runtime bundle assembly to build and stage the sidecar-owned client.
- Strengthen bundle tests around client asset staging.
- Update current architecture, development, packaging, and feature guides.
- Update current source comments that name `packages/web`.
- Record the durable ownership decision in `docs/plan/decisions.md`.

### Non-goals

- Do not redesign the React application.
- Do not change UI copy, visual design, default branding, or Vite browser targets.
- Do not change shared protocol schemas or runtime behavior.
- Do not move OVERDARE tools into `packages/runtime`.
- Do not merge `createWebServer()` into the top-level `server.ts`.
- Do not change consent wire behavior or gateway policy.
- Do not change the Rust launcher/runtime bundle layout visible to installed clients.
- Do not rename the packaged `diligent-web-server` executable in this refactor.
- Do not add a generic Web host package without a concrete second consumer.
- Do not bulk-rewrite historical `docs/plan`, `docs/review`, `docs/superpowers`, or
  `.diligent/knowledge` entries that describe the old path.

## Current state

### Package boundary

`packages/web/package.json` exports:

- `@diligent/web/server`;
- `@diligent/web/consent-protocol`.

The only current source consumers are:

- `apps/overdare-ai-agent/sidecar/src/server.ts`;
- `apps/overdare-ai-agent/sidecar/src/tools/gateway/consent.ts`.

The root workspace already includes `apps/*/sidecar`, so consolidation does not require adding a
new workspace glob.

### Runtime assembly

The current product entrypoint:

1. sets the OVERDARE storage namespace for direct development runs;
2. parses Web server arguments;
3. configures process logging and the parent watchdog;
4. creates the gateway consent service;
5. creates OVERDARE bundled tool providers and experiments;
6. calls `createWebServer()`;
7. prints the launcher-parsed port line;
8. exposes the `mcp-serve` subcommand from the same executable.

All of these responsibilities remain in the sidecar package.

### Client packaging

The runtime bundle currently reads Web sources and `dist/client` from `packages/web`. After the
move, all Web build and staging paths must resolve from `apps/overdare-ai-agent/sidecar`.

The installed artifact shape must remain:

```text
runtime-v<version>/
  diligent-web-server[.exe]
  dist/client/
  assets/
  defaults/
  version.json
```

## Target module boundaries

### `sidecar/src/server.ts`

Keep this as the only process entrypoint for browser-hosted operation.

It owns:

- product environment defaults;
- process-level exception handling;
- parent lifecycle handling;
- product logging context;
- product consent service creation;
- product tool and experiment injection;
- launcher port announcement;
- `mcp-serve` subcommand dispatch.

It imports `createWebServer`, `enableProcessLogFile`, and `parseArgs` from a relative Web server
module instead of from `@diligent/web/server`.

### `sidecar/src/web/server/`

Move the existing Bun server implementation here.

It continues to own:

- `DiligentAppServer` creation;
- WebSocket JSON-RPC transport;
- `/health`;
- persisted image routes;
- static client serving;
- process and thread log helpers;
- Web-local RPC interception;
- legacy Web config migration;
- server argument parsing.

Remove the old direct-execution block from the moved server module. Process startup, signal
handlers, the parent watchdog, and top-level error handling are already owned by
`sidecar/src/server.ts`.

Keep `parseArgs()` and the logging helpers exported because the product entrypoint uses them.

### `sidecar/src/web/client/`

Move the React application without behavior changes. Continue consuming only shared
`@diligent/protocol` contracts for Diligent methods and Web-local contracts for product methods
such as consent.

### `sidecar/src/web/shared/`

Keep the consent protocol and image route helpers local to the Web host. The sidecar gateway consent
implementation imports the consent types through a relative path.

### `sidecar/src/tools/`

No tool implementation moves are required. Only imports from the deleted Web package change.

## Standalone Web entrypoint retirement

The direct `packages/web/src/server/index.ts --dev` path currently creates a generic-looking backend
with no Studio providers and the default `.diligent` namespace. It is not the production OVERDARE
host.

Retire that independent backend path instead of recreating it under the sidecar.

For UI-only development, start the real sidecar with:

```sh
STUDIO_DISABLED=1 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts \
  --dev \
  --port=7433 \
  --cwd="$(pwd)"
```

Run Vite from the sidecar workspace in a second process. This path uses the same product assembly and
`.overdare` namespace as production while skipping the Studio RPC provider.

Consequences:

- local UI development becomes product-realistic;
- the duplicate generic process entrypoint disappears;
- `make web-dev` may remain as a convenience target, but it must start the sidecar with
  `STUDIO_DISABLED=1`;
- documentation must no longer describe a generic Web product or a `.diligent` Web-only mode.

## File migration manifest

### Move into `apps/overdare-ai-agent/sidecar`

| Current path | Target path | Notes |
|---|---|---|
| `packages/web/src/client/**` | `apps/overdare-ai-agent/sidecar/src/web/client/**` | Preserve behavior and test coverage. |
| `packages/web/src/server/**` | `apps/overdare-ai-agent/sidecar/src/web/server/**` | Remove only the redundant direct-run process block. |
| `packages/web/src/shared/**` | `apps/overdare-ai-agent/sidecar/src/web/shared/**` | Keep contracts Web-local. |
| `packages/web/test/**` | `apps/overdare-ai-agent/sidecar/test/web/**` | Preserve package-level test convention. |
| `packages/web/index.html` | `apps/overdare-ai-agent/sidecar/index.html` | Update client entry path. |
| `packages/web/vite.config.ts` | `apps/overdare-ai-agent/sidecar/vite.config.ts` | Update shared helper import paths. |
| `packages/web/tailwind.config.ts` | `apps/overdare-ai-agent/sidecar/tailwind.config.ts` | Scan `src/web/client`. |
| `packages/web/postcss.config.cjs` | `apps/overdare-ai-agent/sidecar/postcss.config.cjs` | No behavior change expected. |
| `packages/web/README.md` | merge into `apps/overdare-ai-agent/README.md` | Describe one product runtime. |

Preserve moves as renames where practical so Git history remains reviewable.

### Merge and modify

| File | Required change |
|---|---|
| `apps/overdare-ai-agent/sidecar/package.json` | Absorb Web dependencies and Vite scripts; remove `@diligent/web`. |
| `apps/overdare-ai-agent/sidecar/tsconfig.json` | Add JSX and DOM libs; include all moved sources and tests. |
| `apps/overdare-ai-agent/sidecar/src/server.ts` | Import the local Web server module. |
| `apps/overdare-ai-agent/sidecar/src/tools/gateway/consent.ts` | Import local Web consent types. |
| `package.json` | Point scripts and typecheck at the sidecar; remove package-path commands. |
| `bun.lock` | Remove the `packages/web` workspace entry and merge dependencies under sidecar. |
| `Makefile` | Run sidecar + Vite for Web development; update build/start targets. |
| `scripts/dev-cross-studio.sh` | Run Vite from the sidecar workspace. |
| `scripts/build-overdare-runtime-bundle.ts` | Build and stage `sidecar/dist/client`. |
| `scripts/build-overdare-sidecar.ts` | Verify paths remain sidecar-local; no artifact shape change. |

### Update current documentation and comments

- `AGENTS.md`
- `README.md`
- `ARCHITECTURE.md`
- `docs/guide/local-development.md`
- `docs/guide/mac-agent-windows-studio.md`
- `docs/guide/packaging.md`
- `docs/guide/tool-settings.md`
- `docs/guide/tool-rendering.md`
- `docs/guide/provider-auth.md`
- `docs/guide/compaction.md`
- `packages/runtime/src/rpc/ws-peer.ts`
- `packages/protocol/src/content-blocks.ts`

Do not rewrite old plan/review documents merely to eliminate historical `packages/web` text.

## Package configuration details

### Sidecar package manifest

Keep the package name:

```json
{
  "name": "@overdare/ai-agent-sidecar",
  "private": true,
  "type": "module"
}
```

Merge the Web runtime and development dependencies into this manifest. Preserve the existing MCP,
runtime, and product dependencies.

Recommended sidecar scripts:

```json
{
  "scripts": {
    "start": "bun run src/server.ts",
    "mcp-serve": "bun run src/server.ts mcp-serve",
    "web:dev": "vite",
    "web:build": "vite build",
    "web:build:dev": "vite build --mode development",
    "web:test": "bun test test/web",
    "test": "bun test"
  }
}
```

Root scripts should use product-qualified canonical names such as:

```text
overdare-ai-agent:web:dev
overdare-ai-agent:web:build
overdare-ai-agent:web:test
```

Retain the short `web:*` aliases only if repository-external automation is confirmed to depend on
them. Do not keep aliases speculatively.

### TypeScript

The sidecar `tsconfig.json` must support both server and browser code:

```json
{
  "compilerOptions": {
    "outDir": "dist",
    "jsx": "react-jsx",
    "lib": ["ESNext", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

Continue extending the repository root config through the correct relative path.

### Vite and static asset paths

Update:

- `index.html` entry from `/src/client/main.tsx` to `/src/web/client/main.tsx`;
- Tailwind content from `src/client/**` to `src/web/client/**`;
- Vite imports from `src/shared/**` to `src/web/shared/**`;
- any test fixture or config path that assumes `packages/web`.

The Vite output remains `sidecar/dist/client`.

### Server static path resolution

The compiled binary lookup remains:

```text
<directory containing diligent-web-server>/dist/client
```

Update only the source-tree fallback because the server module gains another directory level:

```text
sidecar/src/web/server -> sidecar/dist/client
```

Add or adjust a test so an incorrect fallback cannot silently produce a server that starts but
cannot serve `index.html`.

## Implementation sequence

Follow this order so tests protect the packaged contract before ownership changes.

### Task 1: Establish the baseline and packaging guard

Before modifying paths:

1. run the existing Web, sidecar, and runtime bundle tests;
2. run Web and sidecar typechecks;
3. build the current Web client;
4. add a focused runtime-bundle test proving client staging includes `dist/client/index.html` and
   nested assets;
5. add or strengthen a server test for source and packaged client directory resolution.

Prefer extracting a small `stageWebClient(clientDist, stageDir)` helper from
`build-overdare-runtime-bundle.ts` and test the observable staged layout with synthetic fixtures.
Do not write a test that merely asserts the source directory string.

### Task 2: Consolidate the workspace atomically

Move Web source, tests, and build configuration into the sidecar. Merge `package.json` and
`tsconfig.json` in the same change so no intermediate package boundary is treated as intentional.

Update all relative imports in moved source and tests. Remove `@diligent/web` exports and the
sidecar workspace dependency.

Run `bun install` to regenerate workspace resolution and the lockfile.

### Task 3: Make the product entrypoint authoritative

Change the top-level sidecar entrypoint to import local Web modules. Remove the direct-run startup
block and duplicate parent-watchdog implementation from the moved Web server.

Preserve:

- the exact launcher-parsed port output;
- signal cleanup;
- uncaught exception and rejection handling;
- product logging metadata;
- MCP subcommand detection;
- consent and bundled-provider assembly.

Do not rename `DILIGENT_PORT` or any launcher contract as part of this move. If current docs disagree
with the executable output, document the implemented contract and handle any launcher compatibility
change separately.

### Task 4: Rewire client build and runtime packaging

Update all build scripts to use `apps/overdare-ai-agent/sidecar` as the client workspace and
`sidecar/dist/client` as the built output.

The runtime bundle must still place the client under the installed top-level `dist/client`, not
under `sidecar/dist/client`.

Ensure release builds do not reuse stale client output. A clean CI checkout already forces a build,
but the local operator path should either always build or verify that the output corresponds to the
current source. If changing this behavior would expand the refactor, record it as a follow-up rather
than silently preserving a known stale-artifact risk.

### Task 5: Replace generic Web development modes

Update Make targets, root scripts, `dev-cross-studio.sh`, and current guides.

There are only two supported browser development modes after this refactor:

1. sidecar with Studio enabled;
2. sidecar with `STUDIO_DISABLED=1`.

Both use `.overdare` or `.overdare-dev` according to the product environment. Remove documentation
that describes an independent `.diligent` Web backend.

### Task 6: Update architectural ownership

Update `ARCHITECTURE.md` and `AGENTS.md` so future changes route correctly:

- shared behavior belongs in runtime/protocol;
- the OVERDARE Web client and Bun host live under the sidecar;
- Web-only product concerns do not require TUI support;
- shared Diligent user-facing capabilities still require protocol-backed client handling where
  applicable;
- new generic Web packages require a concrete non-OVERDARE consumer.

Add the next decision-log entry after D105 to record that the browser host, static client, and
product runtime are one sidecar-owned deployment unit.

After implementation, follow `docs/plan/README.md`: promote current truth to architecture/guides and
remove or archive this plan rather than leaving it as the sole source of truth.

## Testing and verification

### Focused tests

Run during the move:

```sh
bun test apps/overdare-ai-agent/sidecar/test/web
bun test apps/overdare-ai-agent/sidecar/test/tools
bun test apps/overdare-ai-agent/test/scripts
```

### Type and lint checks

```sh
bun run typecheck
bun run lint
```

The root typecheck command must no longer reference `packages/web/tsconfig.json`. One sidecar
TypeScript invocation should cover product server, tools, browser source, and relevant tests
according to the repository's established typecheck split.

### Build checks

```sh
bun run overdare-ai-agent:web:build
bun run overdare-ai-agent:build-sidecar
```

Build a Windows x64 development runtime bundle using a disposable version and inspect the archive:

```sh
bun run overdare-ai-agent:build-runtime-bundle -- \
  --version 0.0.0-web-sidecar-move \
  --platform windows-x64 \
  --agent-env dev
```

Verify:

- `diligent-web-server.exe` exists;
- `dist/client/index.html` exists;
- hashed JS/CSS assets exist;
- sidecar assets and defaults are unchanged;
- no `packages/web` path is embedded as an operational requirement.

### Full verification

```sh
bun run verify
```

### Manual smoke tests

#### UI-only mode

- start the sidecar with `STUDIO_DISABLED=1`;
- start Vite from the sidecar workspace;
- open `http://localhost:5174`;
- verify connection, thread creation, streaming, approval, user input, settings, and image rendering;
- verify no Studio RPC provider is registered.

#### Studio mode

- start through the normal sidecar development path with a reachable Studio port;
- verify Studio tools appear and execute;
- verify AgentNativeBridge context items render and reach prompts;
- verify human edit notices and OVERDARE tool rendering still work.

#### Packaged mode

- launch through the Rust launcher against a freshly assembled runtime;
- verify the launcher reads the sidecar port;
- verify the sidecar serves `dist/client` without Vite;
- verify consent initialization and updates;
- verify storage stays under the selected OVERDARE namespace.

## Definition of done

- `packages/web` no longer exists.
- `@diligent/web` no longer appears in current source, manifests, or `bun.lock`.
- The only product Web implementation lives under `apps/overdare-ai-agent/sidecar/src/web`.
- The sidecar package owns all React, Vite, Tailwind, and browser dependencies.
- `sidecar/src/server.ts` is the only browser-host process entrypoint.
- UI-only development uses the real sidecar with Studio disabled.
- The runtime bundle still contains the unchanged installed `dist/client` layout.
- Web tests live under `apps/overdare-ai-agent/sidecar/test/web`.
- Web, sidecar, packaging, typecheck, lint, and full test suites pass.
- Current architecture and guides describe sidecar ownership.
- Historical plans and knowledge records remain historically accurate rather than being rewritten.

Use a scoped search that excludes historical material for the final path check:

```sh
rg -n "packages/web|@diligent/web" \
  AGENTS.md ARCHITECTURE.md README.md package.json bun.lock Makefile \
  apps packages scripts docs/guide .github
```

Expected result: no current operational references.

## Primary risks and mitigations

### Client omitted from the runtime bundle

**Risk:** The sidecar executable builds successfully, but installed users receive no client assets.

**Mitigation:** Add client staging tests before the move and inspect a real runtime archive.

### Compiled and source static paths diverge

**Risk:** Development works through Vite while the compiled binary returns `404`.

**Mitigation:** Test source fallback and explicit packaged `distDir`; smoke-test the compiled
artifact without Vite.

### Browser dependencies leak into the compiled server

**Risk:** Merging manifests causes the compiled sidecar to include unnecessary React/Vite code.

**Mitigation:** Keep browser modules out of the server import graph. Verify executable size and Bun
compile output before and after. A shared package manifest does not require a shared import graph.

### Duplicate process lifecycle handling

**Risk:** Retaining the old direct-run Web block creates duplicate signal handlers or watchdogs.

**Mitigation:** Keep process lifecycle only in `sidecar/src/server.ts`; keep the Web server module
factory-style.

### Development namespace changes

**Risk:** Developers using the old generic Web backend expect `.diligent` sessions.

**Mitigation:** Document the deliberate switch to the product `.overdare` namespace. Do not migrate
or delete existing `.diligent` development data as part of this refactor.

### Unknown external `@diligent/web` consumer

**Risk:** A repository-external consumer imports the current package exports.

**Mitigation:** The repository contains no such consumer. Before implementation, confirm with the
team or package registry that `@diligent/web` is not published or consumed externally. If it is,
stop and define a compatibility window; do not add a shim by default.

### Large rename obscures review

**Risk:** Mechanical path changes hide unintended behavior changes.

**Mitigation:** Keep the implementation in reviewable phases:

1. tests and packaging guard;
2. atomic source/config move;
3. scripts and documentation;
4. generated lockfile update and verification.

Avoid formatting unrelated moved files.

## Rollback

This is a source-ownership refactor; installed runtime data and artifact layout do not change.

If packaging or startup regressions are found before release, revert the consolidation commit and
restore the prior `@diligent/web` dependency. No storage migration or user-data rollback is needed.

If a bad runtime bundle is published, publish a corrected runtime version through the existing
versioned updater. Do not mutate an already installed version directory in place.

## References

- `ARCHITECTURE.md`
- `packages/web/package.json`
- `packages/web/src/server/index.ts`
- `packages/web/src/client/App.tsx`
- `packages/web/src/shared/consent-protocol.ts`
- `apps/overdare-ai-agent/sidecar/src/server.ts`
- `apps/overdare-ai-agent/sidecar/package.json`
- `scripts/build-overdare-sidecar.ts`
- `scripts/build-overdare-runtime-bundle.ts`
- `apps/overdare-ai-agent/test/scripts/build-runtime-bundle.test.ts`
- `docs/guide/local-development.md`
- `docs/guide/packaging.md`
- P067 (`docs/plan/refactor/P067-bundled-product-tool-providers.md`)
- P083 (`docs/plan/refactor/P083-overdare-consent-ownership-handoff.md`)
