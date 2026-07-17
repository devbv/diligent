# Architecture

Diligent is a transparent, debuggable coding agent built as a Bun + TypeScript strict-mode monorepo.

This document describes the architecture that exists in the repository today. It is intentionally implementation-oriented: package boundaries, runtime flows, protocol surfaces, and frontend/backend responsibilities are described based on the current codebase rather than historical phase plans.

## Goals

The architecture is organized around four product goals:

- **Continuity without hidden state** — long-running work should survive compaction, resume, and multi-turn collaboration.
- **Project-local transparency** — sessions, knowledge, config, and instructions live with the project in `.diligent/`.
- **One runtime, multiple clients** — CLI/TUI, Web, and Desktop should share the same backend behavior.
- **Debuggable layers** — provider calls, tool execution, session persistence, and protocol traffic should be inspectable and testable.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript with strict mode
- **Workspace model:** Bun workspaces / monorepo packages
- **Validation:** Zod schemas across config, tools, and protocol boundaries
- **External CLI dependency:** `rg` (ripgrep) for `glob` and `grep` tools

## Repository Structure

| Path | Responsibility |
|---|---|
| `packages/core` | Reusable agent engine: providers, model registry, agent loop, tool interfaces, shared LLM-facing types |
| `packages/runtime` | Diligent runtime assembly: app server, sessions, tools, approval, knowledge, skills, config, collaboration |
| `packages/protocol` | Shared JSON-RPC method constants and schema-only frontend/backend contract |
| `packages/plugin-sdk` | Public SDK types and contracts for external JavaScript tool plugins |
| `packages/cli` | Bun CLI entrypoint, stdio app-server transport, TUI client |
| `packages/web` | Bun web server + React web client over WebSocket JSON-RPC |
| `packages/debug-viewer` | Viewer for inspecting `.diligent/` data |
| `packages/e2e` | End-to-end tests spanning protocol and runtime behavior |
| `packages/evals` | Live-model behavioral evaluations for core capabilities; separate from deterministic end-to-end tests |
| `apps/overdare-ai-agent` | Rust CLI launcher for the Overdare product: bootstraps the TypeScript runtime, manages self-update, and launches the Bun web server as a child process. Owns compile-time storage namespace defaults, migration from legacy `.diligent/` directories, and launcher-managed bootstrap assets. |
| `apps/overdare-ai-agent/sidecar` | OVERDARE-owned TypeScript sidecar assembly. Imports the generic `@diligent/web/server`, injects product bundled tool providers, and is compiled as the packaged `diligent-web-server` sidecar. |
| `apps/vscode-extension` | VS Code extension host: provides an activity bar entry, thread tree view, and conversation panel backed by a stdio JSON-RPC transport to the Diligent runtime. Shares the same protocol contract as the CLI and Web clients. |

## Architecture Overview

At a high level, Diligent is split into four layers:

1. **Core engine** — model/provider abstraction, agent loop, tool contract
2. **Runtime assembly** — session orchestration, prompt building, built-in tools, approvals, knowledge, collaboration
3. **Protocol contract** — typed JSON-RPC requests, notifications, and shared data models
4. **Thin clients** — CLI/TUI, Web, Desktop

```text
CLI/TUI                         Web UI
   │                              │
   │ stdio JSON-RPC               │ WebSocket JSON-RPC
   │                              │
   ├───────────────┬──────────────┴───────────────┤
   │               │                              │                │
   │         DiligentAppServer (@diligent/runtime)                │
   │      thread/session orchestration, RPC dispatch,             │
   │      approvals, user input, tool/runtime integration         │
   │               │                                              │
   │         SessionManager + RuntimeAgent                        │
   │               │                                              │
   │         Agent loop + providers (@diligent/core)              │
   │               │                                              │
   └──────────── model providers / file system / shell ───────────┘
```

## Documentation Map

Use this document for repository-wide architectural invariants, layer boundaries, and ownership rules.

## Application Hosts (apps/)

The `apps/` directory contains application hosts that wrap the TypeScript runtime for specific product delivery targets. They are not monorepo packages and do not export shared types.

### overdare-ai-agent: Rust launcher → TypeScript runtime

`apps/overdare-ai-agent` is a Rust CLI binary that acts as the process supervisor and bootstrapper for the Overdare product variant:

1. `init` command — resolves storage namespace, performs `.diligent/` → `.overdare/` directory migration if needed, and initializes the local project directory.
2. `webserver` command — extracts the bundled Bun runtime, normalizes the working directory path (including Windows `/c/path` → `C:\path` conversion), and launches the packaged TypeScript sidecar over stdio.

The Rust launcher owns **migration** and **process lifecycle**. The TypeScript runtime owns **directory creation** and **all agent/session logic**. Both sides resolve the storage namespace via the `DILIGENT_STORAGE_NAMESPACE` environment variable.

The launcher also accepts a global `--agent-env=<prod|dev>[@<version>]` flag that selects the release channel and (optionally) pins a specific version. The env value determines the storage namespace forwarded to the runtime (`overdare` for prod, `overdare-dev` for dev) so dev and prod installs are fully isolated on disk. The launcher additionally forwards `DILIGENT_ENV` to the runtime child for downstream env-conditional behavior. Manifest URLs are derived from env + pin: prod-latest uses GitHub's `/releases/latest/download/...` redirect (which skips pre-releases), dev-latest uses a workflow-maintained rolling `dev-latest` tag, and pinned versions resolve to immutable `{env}-v<version>` tags.

`apps/overdare-ai-agent/sidecar` owns OVERDARE TypeScript runtime composition. It depends on the product-neutral web server entrypoint (`@diligent/web/server`) and supplies bundled product tool providers from `apps/overdare-ai-agent/sidecar/src/tools`. Product tools must stay here rather than in `packages/runtime` or `packages/web`; those packages only expose generic bundled-provider plumbing. Migrated bundled providers may declare `supersedesPluginPackages` so stale first-party plugin copies are suppressed by the runtime catalog while external plugins remain supported.

### Dual-language storage namespace

The configurable storage namespace is implemented independently in Rust and TypeScript:

| Aspect | Rust (`apps/overdare-ai-agent/src/storage.rs`) | TypeScript (`packages/runtime/src/infrastructure/diligent-dir.ts`) |
|--------|-----------------------------------------------|---------------------------------------------------------------------|
| Default | `"overdare"` (compile-time, Overdare product) | `"diligent"` (runtime, generic Diligent) |
| Source | `option_env!("DILIGENT_STORAGE_NAMESPACE")` | `process.env.DILIGENT_STORAGE_NAMESPACE` |
| Migration | Yes — renames `.diligent/` → `.{namespace}/` | No — creates directories only |
| Validation | None (compile-time constant) | Regex `/^[a-z0-9-]+$/` |

The divergent defaults are intentional per-product. The Rust launcher always runs before the TypeScript runtime in the Overdare deployment, so migration always happens before directory creation. Any future change to directory layout or namespace rules must be coordinated across both implementations — there is no shared type contract between them (see D099 in `docs/plan/decisions.md`).

Feature-specific behavior should be documented under `docs/guide/`. Those guides should hold detailed examples, edge cases, and step-by-step change procedures.

Current guides:

- Session lifecycle: `docs/guide/session-lifecycle.md`
- Collaboration: `docs/guide/collaboration.md`
- Provider auth: `docs/guide/provider-auth.md`
- Compaction: `docs/guide/compaction.md`
- Packaging: `docs/guide/packaging.md`
- Tool settings: `docs/guide/tool-settings.md`
- Tool rendering: `docs/guide/tool-rendering.md`
- AgentNativeBridge: `docs/guide/agent-native-bridge.md`
- Product experiments: `docs/guide/experiments.md`

## Frontend Protocol Philosophy

Diligent uses **one backend protocol with multiple transports**.

`DiligentAppServer` in `packages/runtime` is the source of truth for thread lifecycle, turn execution, approvals, user-input requests, and event broadcasting. Frontends differ mainly in transport and presentation:

- **CLI/TUI** launches `diligent app-server --stdio` and speaks NDJSON-framed JSON-RPC over stdio.
- **Web** runs a Bun server exposing `/rpc` as a WebSocket JSON-RPC endpoint.

The same rule applies to any additional clients such as a VS Code extension/plugin: they may add a client-local transport bridge or UI reducer, but they must still consume the existing shared protocol rather than inventing a client-specific protocol surface.

Practical consequences:

1. **Server logic is shared.** Session lifecycle, provider auth wiring, tool execution, mode changes, effort changes, approvals, and steering belong in runtime, not in individual frontends.
2. **Protocol is the contract.** Anything that crosses the frontend/backend boundary should be modeled in `@diligent/protocol`.
3. **Transport adapters stay small.** Stdio and WebSocket layers only adapt messages; they should not own business logic.
4. **New clients follow the same contract.** A VS Code plugin or any future client must compose shared `@diligent/protocol` payloads and must not introduce a parallel client-specific Diligent protocol.

### Error diagnostics, presentation, and recovery

Errors crossing the frontend boundary keep three responsibilities separate:

- Core classifies provider failures and preserves raw diagnostics, retry metadata, status, upstream codes, and stable Diligent reasons. Core messages do not describe client commands, controls, or navigation.
- Runtime adds a common user-facing message and, when applicable, one semantic recovery intent such as configuring a provider, starting a new thread, or explicitly retrying a turn. Persisted session errors remain raw diagnostics.
- Web, TUI, and non-interactive clients render the runtime message and translate the recovery intent into their own button, picker, or command hint. Recovery never runs automatically, and clients fall back to the raw diagnostic when connected to an older server.

Detailed guidance for the current structured tool-rendering flow lives in `docs/guide/tool-rendering.md`.

## Package Responsibilities

### `@diligent/core`

`packages/core` contains reusable agent-engine concerns that are intentionally not Diligent-app specific:

- provider abstraction and model resolution
- `ProviderManager` and stream proxying
- agent loop and core event stream
- synchronous, trusted in-process agent-loop hook contracts and failure-isolated dispatch
- tool interfaces and execution contracts
- shared LLM message types
- provider/auth primitives used by runtime wiring

Core should not know about project-local persistence, `.diligent/`, JSON-RPC transport, or frontend behavior.

Core's public package surface uses explicit capability boundaries instead of source-layout wildcard exports. Consumers
should use subpaths such as `@diligent/core/tool-contract`, `model-registry`, `provider-contract`,
`message-contract`, and `providers/chatgpt`. Runtime lint rules reject imports outside the approved boundary list, so
moving an internal core file does not implicitly change the package API.

Provider authentication checks remain core mechanisms and report structured `ProviderError` diagnostics. Provider
display names, onboarding hints, and client-facing validation messages are runtime-owned; the corresponding
`ProviderDescriptor` is carried by the shared protocol so Web and TUI consume the same metadata.

### `@diligent/evals`

`packages/evals` runs small live-model behavioral evaluations against the public core capability boundaries. It owns
isolated task worlds, runner budgets, deterministic evaluators, redacted versioned reports, and the canonical provider
profile set. It must not import runtime tools or runtime assembly. It complements `packages/e2e`, which remains the
home for deterministic full-stack protocol and runtime tests.

### `@diligent/runtime`

`packages/runtime` is the main integration layer. It composes core primitives into a working coding agent runtime:

- `DiligentAppServer`
- `SessionManager`
- runtime-owned `AgentEvent` extensions
- built-in tools and plugin loading
- config loading and system prompt construction
- approval engine and user-input bridging
- knowledge store and prompt injection
- skill discovery and rendering
- collaboration/sub-agent orchestration
- Agent-scoped hook policy assembly and internal-context persistence/visibility
- infrastructure around `.diligent/` paths
- transport-neutral RPC helpers and bindings

Runtime is where shared product behavior should be added when both Web and TUI must behave the same way.

Filesystem-backed provider/tool infrastructure is also assembled here. Core keeps image conversion/downscaling and
tool-output truncation policy, while runtime supplies `LocalImageLoader` and `ToolOutputStore` adapters for persisted
image reads and full-output temp-file storage.

### `@diligent/protocol`

`packages/protocol` is the shared frontend/backend contract. It contains:

- JSON-RPC method constants
- request/response schemas
- notification schemas
- shared UI-facing data models

This package should remain schema/model oriented. Behavioral adapters and runtime-specific mapping logic should live outside protocol. Client-local bridges are allowed only as transport/presentation layers over these shared payloads, not as alternate protocol definitions.

### `@diligent/plugin-sdk`

`packages/plugin-sdk` exposes the public SDK used by external JavaScript tool plugins.

It is intentionally small and contract-focused:

- plugin-facing tool types
- result and approval payload shapes
- shared schema helpers used by plugin authors

Runtime consumes this package when loading plugins, but plugin authoring concerns should not leak into unrelated runtime/core modules.

### `@diligent/cli`

`packages/cli` provides:

- the `diligent` executable
- stdio app-server launching for local child-process transport
- interactive TUI
- non-interactive runner for piped/flag-driven execution

The CLI is both a client and a launcher, but not a separate source of agent truth.

### `@diligent/web`

`packages/web` contains two pieces:

- a Bun server that creates `DiligentAppServer`, exposes `/rpc`, serves static assets, and hosts persisted images
- a React client that renders thread state and communicates over JSON-RPC

The web server should stay thin: runtime behavior belongs in `@diligent/runtime`.

## Current Runtime Flow

### 1. Startup and config assembly

Both CLI and Web load a shared `RuntimeConfig` through `packages/runtime/src/config/runtime.ts`.

That loader is responsible for:

- reading merged config sources
- discovering `AGENTS.md` instructions
- building the system prompt
- loading knowledge for prompt injection
- discovering skills
- constructing the `ProviderManager`
- loading provider auth state
- creating the shared stream function
- creating the permission engine

This keeps startup behavior aligned across frontends.

### 2. App-server construction

`createAppServerConfig()` in runtime builds a `DiligentAppServerConfig` from `RuntimeConfig` and wires:

- agent creation
- model availability
- tool configuration getters/setters
- provider auth integration
- compaction settings
- permission engine
- skill names

Both CLI and Web reuse this factory to avoid diverging initialization logic.

### 3. Connection and transport handling

`DiligentAppServer` supports multiple concurrent connections. Each connection tracks:

- current cwd
- selected mode
- selected effort
- thread subscriptions
- pending server requests

The app server accepts client requests, injects session defaults when needed, dispatches thread/turn/config/auth/tool handlers, and broadcasts notifications to subscribed peers.

Thread-scoped notifications follow a subscription fanout model: subscribed peers receive thread events first, while fallback broadcast and initiator-aware suppression help reduce duplicate echoes when multiple clients are connected.

### 4. Thread and turn execution

Per thread, runtime maintains a `ThreadRuntime` that centers on `SessionManager`.

`SessionManager` is responsible for:

- session create/resume/list/reconcile
- append-only persistence
- visible context/transcript building
- agent reuse across turns
- compaction orchestration
- steering queues
- model/mode/effort change persistence
- in-memory error tracking
- relaying runtime/core events to subscribers

It is a central coordination point in the current implementation.

### 5. Event publication

Core/runtime agent events are mapped into protocol notifications by `app-server/event-mapper.ts`.

Clients consume those notifications and may adapt them again into local UI events. Runtime also provides `ProtocolNotificationAdapter` so both Web and TUI can share protocol-to-agent-event mapping logic on the client side.

## Session Model and Persistence

Sessions are project-local and live under `.diligent/`.

Key characteristics:

- **Storage format:** append-only JSONL
- **Location:** `.diligent/sessions/`
- **Shape:** tree-structured entries with `id` / `parentId`
- **Capabilities:** resume, branching history, compaction entries, mode/model/effort changes, steering persistence, collab metadata

Child sessions created by collaboration flows carry explicit parent linkage and child-agent metadata, distinguishing them structurally from top-level sessions.

Runtime derives two different views from session data:

- **context view** for future model calls, including replayable internal messages
- **transcript view** for human-facing UI/history rendering

Message entries may carry `visibility: "internal"`, an opaque `source`, and optional runtime-owned
presentation metadata. Their model message remains in the session parent chain and provider replay
without becoming a user bubble or visible message count. When presentation metadata is present,
runtime derives a structured context notice for live clients and thread snapshots; otherwise the
entry is omitted from human transcripts entirely. This split is important because raw persisted
entries are not identical to the display-oriented event stream used during live turns.

## Agent-loop and external lifecycle hooks

Diligent has two intentionally separate hook tiers:

- Core `AgentLoopHook` instances are synchronous, trusted in-process extensions. Core dispatches
  restore, prompt-start, before-turn, tool-result, and after-turn phases, isolates failures by
  disabling the throwing instance, and only permits structured user-context injections.
- Runtime owns hook policies, constructs a fresh hook set for each main or child Agent, and uses
  bundled tool providers as the product registration path. Built-in runtime hooks run before
  bundled-provider hooks.
- Shell and filesystem-plugin lifecycle hooks remain coarse-grained runtime hooks around outer
  prompts, stops, and durable appends. They may perform I/O and are never run in the sampling loop.

Core does not know runtime tool names, persisted visibility rules, bundled-provider types, or
client behavior. The raw core `context_injected` event is consumed by runtime and never added to
the shared protocol. Runtime may validate opaque injection metadata and emit a separate structured
`context_notice`; this is the common path used by Studio human-edit detection in Web, TUI, and
non-interactive clients.

## Prompt Construction

System prompt construction happens in runtime, not in the frontends.

The effective prompt is assembled from:

- base prompt template
- environment variables such as current date, cwd, and platform
- discovered `AGENTS.md` instructions
- optional config-level custom instructions
- ranked knowledge injection
- discovered skills section
- mode-specific suffixes (`default`, `plan`, `execute`)

This ensures prompt behavior stays consistent no matter which client starts the turn.

## Model and Provider Layer

Providers are abstracted in core behind a shared stream interface. Runtime wires real auth and config into that abstraction.

Current provider-related behavior includes:

- known model registry and model resolution
- provider-specific streaming through `ProviderManager`
- API-key-backed providers from `~/.diligent/auth.jsonc`
- runtime-managed external auth bindings such as ChatGPT OAuth
- shared stream proxy creation for agent execution
- provider-aware native compaction support where available

Runtime supports both API-key-backed provider auth and runtime-managed ChatGPT OAuth token handling.

Thinking effort is a first-class runtime concept with model/provider capability mapping, persisted effort changes, and turn-time effort snapshots in the app server.

Compaction uses a proportional reserve threshold and can incorporate actual assistant usage tokens when available, rather than relying only on a fixed heuristic buffer.

The design goal is to keep provider-specific mechanics reusable while leaving user-facing auth flows to runtime.

## Tool System

### Tool contract

At the core level, tools follow a schema-driven interface with a name, description, input schema, and async execution function.

### Built-in runtime tools

Runtime assembles the default tool set, including:

- `bash`
- `read`
- `apply_patch`
- `ls`
- `glob`
- `grep`
- `plan`
- `skill`
- `request_user_input`
- `search_knowledge`
- `update_knowledge` (when knowledge storage is available)
- collaboration tools such as `spawn_agent`, `wait`, `send_input`, `close_agent`

Tool availability is mode-sensitive and config-sensitive.

### Tool catalog and plugins

Runtime resolves the final catalog by combining:

- built-in tools
- immutable tool rules
- project/global tool toggles
- auto-discovered and explicitly configured plugins
- plugin conflict policy

This produces both:

- the final enabled tool list for the agent
- rich state metadata for UI display and debugging

## Collaboration and Modes

Diligent has two related runtime concepts:

### Collaboration modes

Thread mode changes how the agent is expected to behave:

- `default`
- `plan`
- `execute`

Mode affects system-prompt suffixes and tool filtering. For example, `plan` mode narrows the tool set to a read-oriented subset.

### Sub-agent collaboration

Runtime also supports non-blocking multi-agent work through collaboration tools backed by `AgentRegistry`.

That layer handles:

- child agent spawn
- wait/join behavior
- steering messages to running children
- child shutdown
- restoration of historical sub-agent references on resume

These flows are surfaced through both tool results and dedicated collaboration notifications.

## Approval and User Input

Approval and clarification are separate mechanisms.

### Approval

The approval system is a rule-based permission engine in runtime. It supports:

- configured permission rules
- session-scoped remembered decisions
- blocking approval requests sent from server to client
- yolo/auto-approve mode

Core consumes approval hooks; it does not own the policy engine.

### User input

`request_user_input` is a general clarification tool, not an approval substitute. It pauses execution and asks the connected frontend to collect structured answers from the user.

## Knowledge and Skills

### Knowledge

Knowledge is persisted separately from sessions and injected back into the system prompt.

- storage: append-only JSONL
- API surface: `knowledge/list` and `knowledge/update`
- runtime tools: `search_knowledge` and `update_knowledge`
- write actions: `upsert` and `delete`

Knowledge ranking and injection are runtime concerns, not frontend concerns.

### Skills

Skills are discovered from configured directories and rendered into the prompt as an indexed capability layer. The `skill` tool loads skill content into context without exposing it as ordinary file reads.

## Protocol Surface

The shared protocol is JSON-RPC based and currently includes requests such as:

- lifecycle: `initialize`
- threads: `thread/start`, `thread/resume`, `thread/list`, `thread/read`, `thread/delete`, `thread/compact/start`
- turns: `turn/start`, `turn/interrupt`, `turn/steer`
- thread state: `mode/set`, `effort/set`
- knowledge: `knowledge/list`, `knowledge/update`
- tools: `tools/list`, `tools/set`
- auth/config: `config/set`, `auth/list`, `auth/set`, `auth/remove`, `auth/oauth/start`
- subscriptions: `thread/subscribe`, `thread/unsubscribe`
- assets: `image/upload`

Server-driven protocol messages include:

- thread lifecycle notifications
- thread status changes
- item start/delta/completion notifications
- turn completion/interruption notifications
- approval and user-input server requests
- usage, error, knowledge, steering, and collaboration notifications

The protocol layer is shared by TUI and Web, even if each client renders the data differently.

## Adding a New Protocol Method

The pattern for extending the protocol with a new request/response pair has four steps, each in a dedicated layer:

1. **Define the method name** — add a constant to `DILIGENT_CLIENT_REQUEST_METHODS` in `packages/protocol/src/methods.ts`.

2. **Define schemas** — add `Params`, `Response`, and `z.object({ method, params/result })` entries to `packages/protocol/src/client-requests.ts`. Both the request union (`DiligentClientRequest`) and the response union must include the new variant.

3. **Implement the handler** — add a `handleXxx(ctx, params)` function to the appropriate handler file in `packages/runtime/src/app-server/`:
   - `thread-handlers.ts` — thread lifecycle (start, resume, list, delete, read, compact)
   - `config-handlers.ts` — config, auth, consent, and image upload
   - `knowledge-handlers.ts` — knowledge list and update
   - Create a new `*-handlers.ts` file when the new area is distinct enough to warrant its own module.

4. **Register the handler** — add a `case` branch in `packages/runtime/src/app-server/request-dispatcher.ts` that calls the handler and returns its result.

5. **Add client-side calls** — if the method is user-facing, implement the client call in `packages/web` (React) and `packages/cli` (TUI). Frontends should call the method through the shared protocol; they must not implement the behavior locally.

The consent feature (`consent/set`) is a concrete reference example that follows every step of this pattern.

## Data Locality and `.diligent/`

Project-local data is a first-class architectural decision.

`.diligent/` is used for runtime data such as:

- sessions
- knowledge
- project config
- generated ignore rules
- persisted images and related runtime artifacts

User-global auth remains under `~/.diligent/`, while project continuity stays inside the repository boundary.

## Important Boundaries

When changing the system, these boundaries matter most:

- **Core vs Runtime** — reusable engine logic belongs in core; Diligent product assembly belongs in runtime.
- **Runtime vs Protocol** — protocol defines transport-facing schemas; runtime owns mapping and behavior.
- **Runtime vs Frontends** — frontends should render and collect input, not duplicate backend business logic.
- **Logging vs Protocol** — first-party diagnostics use the leaf `@diligent/logging` package. Records carry structured context, while hosts own console, file, or remote sinks. Logs are not protocol messages, and user-facing or machine-readable stdout must not be routed through the diagnostic logger.
- **Web vs Desktop** — desktop should reuse web/server behavior rather than fork it.

## Current Architectural Realities

Some important implementation realities are worth calling out explicitly:

- `SessionManager` is currently a major orchestration hub and coupling point.
- `thread/read` and live notifications are not yet perfectly symmetrical in shape; clients still perform some hydration work.
- Runtime already contains client-facing helpers such as notification adapters to reduce duplicated frontend logic.
- Structured tool rendering now uses protocol-defined payloads and block schemas, while Web and TUI presentation details still evolve per client.

These are not necessarily problems, but they are useful context when planning refactors.

## Development Commands

```bash
bun test
bun run lint
bun run lint:fix
bun run typecheck
```

## Summary

The current architecture is best understood as:

- a **shared core agent engine**,
- assembled by a **Diligent runtime**,
- exposed through a **single JSON-RPC protocol**,
- and consumed by **thin CLI, Web, and Desktop clients**.

If a new feature must behave the same in TUI and Web, it almost certainly belongs in `@diligent/runtime` and should cross the client boundary through `@diligent/protocol`.
