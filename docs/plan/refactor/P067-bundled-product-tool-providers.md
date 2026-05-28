---
id: P067
status: in_progress
created: 2026-05-28
---

# Bundled Product Tool Providers

## Goal

OVERDARE-specific tools can ship inside the packaged runtime binary and be registered in-process as product-owned bundled tool providers, without copying first-party plugin folders into user storage or routing typed launcher arguments through plugin environment variables.

The generic Diligent external plugin system remains available for user-installed and third-party extensions, while product runtimes get a first-class path for bundled first-party tools.

## Current Direction Update

Do **not** put OVERDARE domain tool implementations in `packages/runtime` or `packages/web`. Those packages stay generic:

- `packages/runtime` owns the generic bundled-provider contract, catalog merge, hook dispatch, and app-server plumbing.
- `packages/web` owns the generic Bun web server and accepts `bundledToolProviders` as injected runtime options.
- `apps/overdare-ai-agent` remains the Rust launcher/update/bootstrap host; it should not grow TypeScript tool source.
- `apps/overdare-ai-agent/sidecar` owns OVERDARE TypeScript runtime assembly and bundled product tools. It imports `@diligent/web/server`, creates product-owned providers, and is the sidecar entrypoint compiled into `diligent-web-server` for OVERDARE builds.

This split avoids leaking product logic into generic runtime/web packages while still allowing the packaged OVERDARE sidecar to ship product tools in-process.

## Prerequisites

- Existing runtime tool contract in `@diligent/core/tool/types` and plugin-facing SDK contract in `packages/plugin-sdk/src/index.ts`.
- Existing catalog merge behavior in `packages/runtime/src/tools/catalog.ts`.
- Existing app-server/runtime creation path through `packages/runtime/src/tools/defaults.ts`, `packages/runtime/src/app-server/factory.ts`, and `packages/web/src/server/index.ts`.
- Existing OVERDARE launcher namespace/update flow in `apps/overdare-ai-agent`.

## Artifact

A packaged OVERDARE runtime starts with OVERDARE tools already available from the runtime binary:

```text
overdare-ai-agent start --cwd=/project --studio-rpc-port=8123 --project-id=abc

Runtime:
- creates generic Diligent built-in tools,
- creates OVERDARE bundled tool providers from typed product options,
- merges bundled tools through the same catalog conflict/toggle path as plugins,
- still loads any user-installed external plugins from .overdare/plugins when present.
```

The launcher no longer needs to deploy bundled first-party tool packages into `~/.overdare/plugins`. Environment variables are kept only for true process-boundary settings such as storage namespace, server version, and runtime process bootstrap values.

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| `packages/runtime/src/tools/` | Introduce bundled tool provider types and merge them into the tool catalog beside external plugins. |
| `packages/runtime/src/tools/defaults.ts` | Accept product-provided bundled tool providers when building default tools. |
| `packages/runtime/src/app-server/` | Thread bundled provider options through app-server config and thread runtime creation. |
| `packages/web/src/server/` | Stay product-neutral; expose `createWebServer({ bundledToolProviders })` so product runners can inject providers. |
| `apps/overdare-ai-agent/sidecar/` | Add product-owned TypeScript sidecar runner and bundled tool implementations. This runner imports `@diligent/web/server` and supplies OVERDARE providers. |
| `scripts/build-overdare-sidecar.ts` | Compile `apps/overdare-ai-agent/sidecar/src/server.ts` instead of the generic `packages/web/src/server/index.ts`. |
| `apps/overdare-ai-agent/src/` | Stop copying first-party tool plugin folders as bootstrap artifacts once equivalent bundled providers exist. Keep external/user plugin behavior intact. |
| `apps/overdare-ai-agent/bootstrap/` | Remove first-party tool plugin deployment artifacts from the plugin bootstrap path, while preserving skills/agents/defaults that are still file-based assets. |
| `docs/guide/` | Document the distinction between built-in tools, bundled product tools, and external plugins. |

### What does NOT change

- No removal of the external plugin SDK or filesystem plugin loading path.
- No change to user-installed external plugin discovery under the selected storage namespace.
- No movement of OVERDARE domain tools into generic Diligent core built-ins.
- No product-specific protocol surface for Web/TUI/VS Code clients.
- No change to launcher-owned storage namespace migration rules.
- No attempt to make all current bootstrap assets in-process; skills, agents, config defaults, and static documentation can remain file-based.

### Related policy for agents and skills

Agents and skills should not follow the same migration path as executable tool plugins by default. They are content/instruction assets, not in-process executable integrations, so keeping them file-based is still valuable for transparency, inspection, and product updates.

Preferred long-term split:

| Asset kind | Recommended source | Update behavior |
|------------|--------------------|-----------------|
| Generic Diligent skills/agents | User/project `.diligent` or selected namespace roots | User-owned; never overwritten by product updates. |
| OVERDARE product skills/agents | Product-managed bundled asset root, for example updated runtime `bootstrap/skills` and `bootstrap/agents` | Read-only or managed; updated with the product runtime. |
| User-custom OVERDARE skills/agents | User/project `.overdare/skills` and `.overdare/agents` | User-owned; loaded in addition to product assets. |

This does not mean product assets never get copied anywhere. Packaged builds may still need to extract or sync product assets into a launcher/runtime-managed update directory such as `~/.overdare/updates/runtime/bootstrap/skills`. The distinction is ownership: product assets can be copied into a managed product asset root, but should not be deployed into user-owned roots like `~/.overdare/skills` unless compatibility requires it.

If product skills/agents are copied into user-owned storage for compatibility, the launcher should treat them as managed defaults rather than user-owned custom assets: copy missing entries on fresh install, avoid overwriting locally modified files unless a manifest says they are product-managed, and prefer runtime discovery from the product-managed asset root in a later cleanup.

## File Manifest

### packages/runtime/src/tools/

| File | Action | Description |
|------|--------|-------------|
| `bundled-provider.ts` | CREATE | Define runtime-facing `BundledToolProvider`, bundled hook, and bundled tool metadata types. |
| `catalog.ts` | MODIFY | Merge bundled providers before/alongside external plugins while preserving conflict policy, per-tool toggles, and state reporting. |
| `defaults.ts` | MODIFY | Accept `bundledToolProviders` in `BuildDefaultToolsOptions` and pass them into catalog construction. |
| `plugin-loader.ts` | MODIFY | Reuse validation/wrapping helpers for bundled providers or extract shared wrapping logic so bundled tools use the same runtime host bridge. |

### packages/runtime/src/app-server/

| File | Action | Description |
|------|--------|-------------|
| `factory.ts` | MODIFY | Add bundled provider plumbing to `createRuntimeAgent()` and `createAppServerConfig()`. |
| `server.ts` | MODIFY | Include bundled hooks in combined hook execution without requiring dynamic plugin import. |

### packages/runtime/src/config/

| File | Action | Description |
|------|--------|-------------|
| `schema.ts` | MODIFY | Add optional bundled provider/tool toggles only if product tools need user-configurable enablement distinct from plugin package names. Prefer reusing existing per-tool toggles first. |

### packages/runtime/test/

| File | Action | Description |
|------|--------|-------------|
| `tools/catalog.test.ts` | MODIFY | Verify bundled providers merge deterministically, respect conflicts, and coexist with external plugins. |
| `tools/defaults.test.ts` | MODIFY | Verify `buildDefaultTools()` includes bundled providers and passes host capabilities. |
| `app-server/factory.test.ts` | MODIFY / CREATE | Verify thread runtime creation carries bundled providers across fresh and resumed runtimes. |

### packages/web/src/server/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | MODIFY | Accept optional `bundledToolProviders` and pass them to `createAppServerConfig()`. Do not import OVERDARE code here. |
| `package.json` | MODIFY | Export `@diligent/web/server` so product runners can import the generic web server entrypoint. |

### apps/overdare-ai-agent/sidecar/

| File | Action | Description |
|------|--------|-------------|
| `package.json` | CREATE | Product-owned TypeScript workspace package for OVERDARE Studio runtime assembly. |
| `src/server.ts` | CREATE | Product sidecar runner: parses web server args, creates OVERDARE bundled providers, and calls `createWebServer()`. |
| `src/tools/**` | CREATE | Product-owned bundled tool providers. Start with `hello_world` smoke tool, then port real OVERDARE tools here. |
| `test/**` | CREATE | Product-owned tests for provider assembly and tool schemas. |

### apps/overdare-ai-agent/src/

| File | Action | Description |
|------|--------|-------------|
| `init.rs` | MODIFY | Stop deploying bundled first-party tool plugins from bootstrap into global plugin storage. Continue deploying non-tool bootstrap assets that remain file-based. |
| `webserver.rs` | MODIFY | Keep process-boundary env vars, but avoid launcher-specific env forwarding whose only purpose was configuring in-process first-party tools once typed runtime options replace it. |

### apps/overdare-ai-agent/bootstrap/

| File | Action | Description |
|------|--------|-------------|
| `plugins/**` | MODIFY / DELETE | Remove or shrink first-party tool plugin folders after their tool implementations move to bundled providers. |

### packages/plugin-sdk/

| File | Action | Description |
|------|--------|-------------|
| `src/index.ts` | MODIFY | Only if needed: export shared provider-facing types without forcing bundled runtime code to depend on filesystem plugin packaging semantics. |

### docs/guide/

| File | Action | Description |
|------|--------|-------------|
| `tool-settings.md` | MODIFY | Document built-in vs bundled product vs external plugin behavior and configuration. |
| `packaging.md` | MODIFY | Document that OVERDARE first-party tools are bundled in the runtime binary, not deployed as global plugin folders. |

## Implementation Tasks

### Task 1: Define the runtime bundled provider contract

**Files:** `packages/runtime/src/tools/bundled-provider.ts`, `packages/runtime/src/tools/plugin-loader.ts`
**Decisions:** D013, D014, D020, D027, D028

Add a runtime-owned provider contract that represents in-process first-party tool bundles. The contract should return the same host `Tool[]` shape consumed by the agent loop and optionally expose lifecycle hooks using the existing plugin hook types.

Code sketch:

```typescript
import type { Tool } from "@diligent/core/tool/types";
import type { PluginHookFn } from "../hooks/runner";
import type { RuntimeToolHost } from "./capabilities";

export interface BundledToolProviderContext {
  cwd: string;
  host?: RuntimeToolHost;
}

export interface BundledToolProvider {
  id: string;
  displayName?: string;
  createTools(ctx: BundledToolProviderContext): Promise<Tool[]> | Tool[];
  onUserPromptSubmit?: PluginHookFn;
  onStop?: PluginHookFn;
}
```

Provider `id` must be stable and package-like, for example `@overdare/studio-tools`, so existing state/config concepts can use it without introducing a completely separate identity model.

**Verify:** TypeScript compile catches providers that do not return valid runtime tools.

### Task 2: Merge bundled providers through the catalog pipeline

**Files:** `packages/runtime/src/tools/catalog.ts`, `packages/runtime/test/tools/catalog.test.ts`
**Decisions:** D014, D027, D034

Extend `buildToolCatalog()` to accept bundled providers in addition to external plugin configs.

Code sketch:

```typescript
export interface BuildToolCatalogOptions {
  bundledProviders?: BundledToolProvider[];
}

export async function buildToolCatalog(
  builtinTools: Tool[],
  toolsConfig: DiligentConfig["tools"],
  cwd: string,
  host?: RuntimeToolHost,
  options: BuildToolCatalogOptions = {},
): Promise<ToolCatalogResult>;
```

Bundled tools should use the same conflict policy and final enabled-tool ordering rules as plugin tools. State reporting can initially treat them as `source: "plugin"` with a provider/package id to minimize UI churn, but the preferred end state is to add `source: "bundled"` if client displays need to distinguish product-owned bundled tools.

Ordering rule:

1. generic built-ins,
2. bundled product providers,
3. explicit external plugins,
4. auto-discovered external plugins.

This lets immutable generic tools remain protected while allowing product tools to appear before user-installed external plugins.

**Verify:** tests cover bundled-vs-builtin conflict, bundled-vs-external conflict, disabled tool toggles, invalid provider tool state, and deterministic ordering.

### Task 3: Thread bundled providers through default tool assembly and app-server creation

**Files:** `packages/runtime/src/tools/defaults.ts`, `packages/runtime/src/app-server/factory.ts`, `packages/runtime/src/app-server/server.ts`, `packages/runtime/test/tools/defaults.test.ts`
**Decisions:** D046, D055

Add `bundledToolProviders` to runtime construction options so all clients and resumed thread runtimes use the same tool set.

Code sketch:

```typescript
export interface BuildDefaultToolsOptions {
  cwd: string;
  bundledToolProviders?: BundledToolProvider[];
  // existing fields...
}
```

For hooks, avoid `collectPluginHooks()` being the only source of non-shell hooks. Add bundled hooks to the app-server hook path:

```typescript
const pluginHooks = await collectPluginHooks(config.toolConfig?.getTools(), cwd);
const bundledHooks = collectBundledHooks(config.bundledToolProviders ?? []);

await runCombinedHooks(shellHandlers, [...pluginHooks.onStop, ...bundledHooks.onStop], input, cwd);
```

**Verify:** a new turn and a resumed thread both see identical bundled tools; bundled `onStop` / `onUserPromptSubmit` hooks run without filesystem plugin imports.

### Task 4: Add a product-owned Studio runtime runner for OVERDARE

**Files:** `packages/web/src/server/index.ts`, `packages/web/package.json`, `apps/overdare-ai-agent/sidecar/src/server.ts`, `apps/overdare-ai-agent/sidecar/src/tools/**`, `scripts/build-overdare-sidecar.ts`
**Decisions:** D046, D099

Create a product-owned TypeScript sidecar runner that lets packaged OVERDARE builds choose product bundled providers without adding OVERDARE domain logic to generic runtime or web modules.

The cleanest shape is:

1. `packages/web/src/server/index.ts` exports the generic `createWebServer()` and accepts `bundledToolProviders`.
2. `apps/overdare-ai-agent/sidecar/src/server.ts` imports `@diligent/web/server`, creates OVERDARE providers from typed options, and passes them into `createWebServer()`.
3. `scripts/build-overdare-sidecar.ts` compiles `apps/overdare-ai-agent/sidecar/src/server.ts` as the OVERDARE `diligent-web-server` sidecar.

```typescript
interface ProductRuntimeOptions {
  cwd: string;
  studioRpcPort?: number;
  hubDomain?: string;
  projectId?: string;
}

export function createStudioBundledToolProviders(options: ProductRuntimeOptions): BundledToolProvider[] {
  return [createOverdareStudioToolProvider(options)];
}
```

The product runner can still read process-boundary values from env vars passed by the Rust launcher, such as `STUDIO_PORT`, `HUB_DOMAIN`, and `OVERDARE_PROJECT_ID`. The important boundary is that once inside TypeScript product runtime assembly, provider configuration is typed and passed directly to tool factories rather than re-discovered through copied plugin package files.

**Verify:** generic source web server startup constructs `DiligentAppServer` with no product providers by default; OVERDARE sidecar builds compile the product runner and include the product-owned tools.

### Task 4a: Add a temporary hello_world bundled tool smoke test

**Files:** `apps/overdare-ai-agent/sidecar/src/tools/hello-world.ts`, `apps/overdare-ai-agent/sidecar/test/tools/hello-world.test.ts`

Add a tiny `hello_world` bundled tool with a real Zod schema to verify that provider-owned tools survive schema conversion and can be listed/called through the normal tool path.

This tool is intentionally a smoke test. It should be removed or replaced once the first real OVERDARE tool provider is ported.

**Verify:** `hello_world` appears in Tools settings after launching an OVERDARE sidecar built from `apps/overdare-ai-agent/sidecar/src/server.ts`, and prompt-driven invocation succeeds without `def.typeName` schema errors.

### Task 5: Port one OVERDARE plugin into an in-process bundled provider

**Files:** new product tool provider files under the selected product/runtime area, associated tests
**Decisions:** D013, D020, D028

Start with the smallest currently copied OVERDARE tool plugin and port it without changing its LLM-facing tool names or parameters. This first migration validates the provider abstraction before moving all tool plugins.

Implementation rule:

- preserve tool names and schema shapes,
- preserve approval and user-input behavior through `RuntimeToolHost`,
- preserve rendered tool payloads,
- avoid reading launcher-specific env vars inside individual tools when the values can be passed as provider options.

**Verify:** existing prompts/tools continue to work with no plugin folder present in global storage.

### Task 6: Remove first-party tool plugin deployment from the OVERDARE launcher

**Files:** `apps/overdare-ai-agent/src/init.rs`, `apps/overdare-ai-agent/src/webserver.rs`, `apps/overdare-ai-agent/bootstrap/plugins/**`, launcher tests
**Decisions:** D099

After migrated tools are bundled, remove the need for `init.rs` to copy those first-party tool plugin folders into global storage. Keep deployment for file-based bootstrap assets that still intentionally live in user storage.

Recommended compatibility transition:

1. stop shipping the migrated plugin folders in `bootstrap/plugins`,
2. keep external plugin discovery untouched,
3. do not delete user-existing `~/.overdare/plugins/...` folders automatically,
4. make bundled provider IDs conflict predictably with stale external copies so the bundled provider wins or stale copies are ignored by explicit policy.

Add an explicit legacy first-party plugin suppression list for packages that have been migrated into bundled providers:

```typescript
export interface BundledToolProvider {
  id: string;
  supersedesPluginPackages?: string[];
  createTools(ctx: BundledToolProviderContext): Promise<Tool[]> | Tool[];
}
```

Conflict policy during update:

| Existing state after update | Runtime behavior |
|-----------------------------|------------------|
| Old first-party plugin folder remains in `~/.overdare/plugins` but is only auto-discovered | Suppress it silently or report `superseded_by_bundled` in tool state; do not load it. |
| Old first-party plugin is explicitly listed in `tools.plugins` | Do not load it; show a clear `superseded_by_bundled` warning and keep the bundled provider active. |
| Third-party/user plugin exports the same tool name as a bundled product tool | Treat as a normal conflict, but default to bundled product tool winning unless the bundled tool is explicitly marked overrideable. |
| User has unrelated third-party plugins | Continue loading exactly as before. |

Do not remove user files automatically. Suppression should happen at runtime catalog resolution, not by deleting `~/.overdare/plugins/*`, so rollback and user inspection remain safe.

**Verify:** fresh install has no first-party tool plugin folders; existing installs do not break if old folders remain.

### Task 7: Document the new three-way tool ownership model

**Files:** `docs/guide/tool-settings.md`, `docs/guide/packaging.md`, `ARCHITECTURE.md` if package responsibility text needs updating
**Decisions:** D014, D033, D099

Document the operational distinction:

```text
Built-in tools: generic Diligent runtime tools available everywhere.
Bundled product tools: first-party product tools compiled into a product runtime binary.
External plugins: user-installed or third-party filesystem/package extensions.
```

Also document why bundled product tools should not be deployed through the global plugin folder: they do not need dynamic package resolution, user-storage copying, or env-var based configuration.

**Verify:** guide explains how a product package adds bundled providers and how users still add external plugins.

## Acceptance Criteria

1. Packaged OVERDARE runtime can start with migrated first-party tools available when `~/.overdare/plugins` does not contain those tool plugin packages.
2. External plugin discovery and explicit `tools.plugins` config continue to work unchanged for user-installed plugins.
3. Bundled tools pass through the same approval, user-input, result rendering, conflict, and enable/disable paths as existing runtime tools.
4. Bundled lifecycle hooks run without dynamic plugin package imports.
5. Generic Diligent CLI/Web source workflows do not load OVERDARE bundled providers by default.
6. Launcher bootstrap no longer copies migrated first-party tool plugin folders into global storage.
7. Tests cover catalog merge behavior, default tool assembly, and launcher bootstrap behavior.

## Testing Strategy

| Category | What to Test | How |
|----------|--------------|-----|
| Unit | Bundled provider catalog merge and conflicts | `bun test packages/runtime/test/tools/catalog.test.ts` |
| Unit | Default tool assembly receives bundled providers | `bun test packages/runtime/test/tools/defaults.test.ts` |
| Unit | App-server hook collection includes bundled hooks | `bun test packages/runtime/test/app-server/*.test.ts` |
| Unit | Product-owned OVERDARE tool provider schema/execute path | `cd apps/overdare-ai-agent/sidecar && bun test test/tools/hello-world.test.ts` |
| Unit | Launcher no longer deploys migrated plugin folders | `cargo test --manifest-path apps/overdare-ai-agent/Cargo.toml` |
| Integration | Packaged-like runtime starts with no global plugin folder | targeted packaging/runtime smoke test or manual dry run |
| Manual | OVERDARE Studio tool call works from bundled provider | launch `overdare-ai-agent start` with Studio RPC port and invoke a migrated tool |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Duplicate stale plugin folders conflict with bundled providers | Existing installs may see duplicate tool names | Use stable provider IDs and deterministic conflict policy; prefer bundled provider over auto-discovered stale first-party plugin packages during transition. |
| Catalog/UI state assumes only `builtin` or `plugin` sources | Tool settings UI may mislabel bundled tools | Initially reuse plugin-like state if necessary; add `bundled` source only with protocol/UI updates. |
| Hook loading remains tied to dynamic plugin import | Bundled providers lose lifecycle behavior | Add bundled hook collection in app-server config, not in filesystem plugin loader. |
| Product logic leaks into generic runtime | Diligent core becomes OVERDARE-specific | Keep provider factories in product/web packaging seam; runtime only knows generic bundled provider interface. |
| Product logic leaks into generic web server | Generic Diligent web builds unexpectedly expose OVERDARE tools | Keep product tools in `apps/overdare-ai-agent/sidecar`; `packages/web` only exposes an injection seam. |
| Removing plugin copy too early breaks tools not yet ported | Packaged OVERDARE loses capabilities | Migrate one plugin first, verify, then remove only migrated plugin deployment. |
| Env-var cleanup removes real process-boundary config | Packaged startup breaks across Rust→TS boundary | Keep namespace/version/path/port env or args until a typed CLI argument path exists; only remove env usage that exists solely to configure in-process tools. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D013 | Tools are objects with schema and execute function | Bundled provider tool shape |
| D014 | Tool registry/catalog builder owns tool resolution | Catalog merge path |
| D020 | Tool results separate output and metadata | Tool compatibility acceptance |
| D027 | Rule-based permission system | Approval preservation |
| D028 | Tools request approval through context | Runtime host bridge |
| D033 | Config hierarchy and CLI override model | Config/toggle compatibility |
| D034 | Config merge and plugin array behavior | External plugin coexistence |
| D046 | Shared backend protocol with thin clients | No product-specific client protocol |
| D055 | App server is shared source of runtime behavior | App-server provider plumbing |
| D099 | Rust launcher and TypeScript runtime coordinate but keep ownership boundaries | OVERDARE launcher/runtime seam |

## Revalidation

This plan remains preferable to making OVERDARE tools generic Diligent built-ins because OVERDARE Studio RPC, asset, and project concepts are product-domain capabilities rather than universal coding-agent primitives. It also addresses the concrete friction that triggered this discussion: first-party bundled tools should not be copied through a global plugin folder or configured indirectly through environment variables once they are already linked into the runtime binary.

The plan is also safer than deleting the plugin system. External plugins still need filesystem/package loading, config-based enablement, and user installation semantics. The change is therefore a loading-strategy split:

```text
same tool contract + same catalog policy
different provider source:
- generic built-ins from runtime,
- bundled product providers from product runtime assembly,
- external plugins from package/filesystem discovery.
```

The main implementation risk is compatibility with existing plugin-centric state and stale first-party plugin folders on upgraded installs. The migration should therefore be incremental: add bundled providers first, port one OVERDARE plugin, verify side-by-side behavior, then remove only migrated plugin bootstrap deployment.

## Implementation Handoff Snapshot

As of the first implementation slice:

- Generic bundled-provider plumbing is implemented in `packages/runtime`.
- `packages/web` remains generic and accepts injected `bundledToolProviders`.
- `apps/overdare-ai-agent/sidecar` has been introduced as the OVERDARE product-owned TypeScript sidecar runner.
- `scripts/build-overdare-sidecar.ts` compiles `apps/overdare-ai-agent/sidecar/src/server.ts` for OVERDARE runtime bundles.
- A temporary `hello_world` bundled tool exists under `apps/overdare-ai-agent/sidecar/src/tools/` for smoke testing.

Validation performed:

```bash
bun run typecheck
cd apps/overdare-ai-agent/sidecar && bun test test/tools/hello-world.test.ts
bun test packages/runtime/test/tools/catalog.test.ts packages/runtime/test/tools/defaults.test.ts packages/runtime/test/app-server/factory.test.ts
bun run scripts/build-overdare-sidecar.ts
bun run scripts/build-overdare-runtime-bundle.ts --version 0.0.1-local-studio-runner --platform darwin-arm64
```

Local macOS smoke bundle installed during development:

```text
~/.overdare/updates/runtime/diligent-web-server
dist/overdare-ai-agent-runtime-0.0.1-local-studio-runner-darwin-arm64.zip
```

Next implementation steps:

1. Manually verify `hello_world` appears in the OVERDARE Tools UI and can be called from a prompt.
2. Replace or augment `hello_world` with the first real product-owned tool provider under `apps/overdare-ai-agent/sidecar/src/tools/`.
3. Add `supersedesPluginPackages` to migrated providers so stale copied first-party plugin packages are suppressed at runtime.
4. Stop shipping/copying only the migrated plugin package from `apps/overdare-ai-agent/bootstrap/plugins` after the bundled equivalent is verified.
5. Update `ARCHITECTURE.md`, `docs/guide/tool-settings.md`, and `docs/guide/packaging.md` with the new `apps/overdare-ai-agent/sidecar` runner and bundled product tool model.
