# Design Decisions Log

Decisions made during synthesis reviews, with rationale.

## Round 0 Decisions (L0: REPL Loop)

### D001: Runtime — Bun + TypeScript
- **Decision**: Use Bun as runtime, TypeScript in strict mode
- **Rationale**: Fast startup, native TypeScript support, good DX. Aligns with pi-agent's approach.
- **Date**: 2026-02-22

### D002: Monorepo structure — packages/core + packages/cli
- **Decision**: Bun workspace monorepo with core library and CLI as separate packages
- **Rationale**: Follows codex-rs's separation of core/cli. Allows core to be used as a library.
- **Date**: 2026-02-22

### D003: Provider abstraction from day one
- **Decision**: Abstract LLM providers behind a common `Provider` interface supporting both Anthropic and OpenAI
- **Rationale**: All three reference projects have this abstraction. Avoids vendor lock-in.
- **Date**: 2026-02-22

### D004: Op/Event pattern for agent communication
- **Decision**: Use tagged union Op (user→agent) and AgentEvent (agent→user) types
- **Rationale**: Follows codex-rs's protocol pattern. Clean separation of concerns, extensible.
- **Date**: 2026-02-22

## Round 1 Decisions (L1: Tool System + L2: Core Tools)

### D005: Schema system — Zod
- **Decision**: Use Zod for tool parameter schemas
- **Rationale**: Most popular TS validation library, used by opencode. Native JSON Schema export via `z.toJSONSchema()`. Better ecosystem support than TypeBox (pi-agent). Custom schema subsets (codex-rs) are too much maintenance in TS.
- **Date**: 2026-02-23

### D006: Tool definition — Interface with execute function
- **Decision**: Tools defined as objects with `name`, `description`, `parameters` (Zod schema), and `execute(args, ctx)` function. No lazy init pattern initially.
- **Rationale**: pi-agent's `AgentTool` pattern is the cleanest. opencode's lazy `init()` is useful but adds complexity we don't need yet. codex-rs's trait-based approach is Rust-specific.
- **Alternatives considered**: opencode's lazy init (deferred), codex-rs's ToolHandler trait (Rust pattern)
- **Date**: 2026-02-23

### D007: Tool registry — Simple Map with builder
- **Decision**: `ToolRegistry` as a `Map<string, Tool>` with a builder that collects tools. No filesystem discovery initially.
- **Rationale**: Middle ground between pi-agent (just an array) and opencode (filesystem + plugin discovery). Map gives O(1) lookup by name. Builder pattern allows conditional registration. Plugin/filesystem discovery can be added in L7/L8.
- **Date**: 2026-02-23

### D008: Sequential tool execution with parallel-ready interface
- **Decision**: Execute tools sequentially initially (like pi-agent), but design the ToolHandler interface to support parallel execution later. Each tool declares `supportParallel: boolean`.
- **Rationale**: Sequential is simplest and allows steering/interruption between tools. codex-rs's RwLock parallel approach is the eventual target but premature for MVP. The `supportParallel` flag can be used later without interface changes.
- **Date**: 2026-02-23

### D009: Tool context with approval hook placeholder
- **Decision**: `ToolContext` carries session info, abort signal, and an `approve(request)` function that initially auto-approves. L3 will replace the approve implementation.
- **Rationale**: codex-rs and opencode both integrate approval into tool execution context. Designing the hook now avoids L1 interface changes when L3 is implemented. pi-agent handles approval externally which requires more refactoring later.
- **Date**: 2026-02-23

### D010: Initial tool set — 7 core tools
- **Decision**: Start with read, write, edit, bash, glob, grep, ls. Matches pi-agent's tool set.
- **Rationale**: This covers all basic coding agent needs. Additional tools (batch, task, webfetch, apply_patch) can be added incrementally. pi-agent proves this set is sufficient for a functional agent.
- **Date**: 2026-02-23

### D011: Edit strategy — Exact text replacement
- **Decision**: File editing via exact oldText → newText replacement (like pi-agent and opencode), not patch format.
- **Rationale**: All three projects implement this pattern. It's simpler than patch format, LLM-friendly, and reliable. codex-rs's freeform patch format is an alternative for models that prefer it, but can be added later. Single-occurrence guard prevents ambiguous edits.
- **Date**: 2026-02-23

### D012: Shell execution — Bun.spawn with process tree kill
- **Decision**: Use Bun.spawn for shell execution with detached process groups and tree killing for timeout/abort.
- **Rationale**: Follows pi-agent's pattern adapted for Bun. Detached process groups enable clean tree kill. Timeout via setTimeout + kill. Output streaming via onData callback. Temp file fallback for large output (>1MiB).
- **Date**: 2026-02-23

### D013: Tool result format — String output + metadata object
- **Decision**: Tools return `{ output: string, metadata?: Record<string, unknown> }`. Output goes to LLM, metadata goes to events/UI.
- **Rationale**: Separating LLM-facing output (string) from UI-facing metadata follows opencode's pattern. Simpler than pi-agent's content blocks (text/image arrays) for initial implementation. Image support can be added to metadata later.
- **Date**: 2026-02-23

### D014: One file per tool, separate from framework
- **Decision**: Tool framework in `packages/core/src/tool/` (types, registry, executor). Individual tools in `packages/core/src/tools/` (read.ts, bash.ts, etc.).
- **Rationale**: All three projects separate framework from implementations. One file per tool is the universal pattern. Clear boundary between "how tools work" (L1) and "what tools exist" (L2).
- **Date**: 2026-02-23
