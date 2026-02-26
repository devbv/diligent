# Architecture

Diligent is a transparent, debuggable coding agent built with Bun + TypeScript (strict mode).

## Runtime & Stack

- **Runtime**: Bun (fast startup, native TS, Bun.spawn, Bun test runner)
- **Language**: TypeScript in strict mode
- **Monorepo**: Bun workspaces
- **External dependency**: ripgrep (`rg`) required for glob and grep tools (D022)

## Packages

| Package | Purpose |
|---|---|
| `packages/core` | Agent loop, provider abstraction, tool system, tools (the engine) |
| `packages/cli` | CLI entry point, TUI rendering, user interaction |
| `packages/debug-viewer` | Standalone web UI for inspecting `.diligent/` session data |
| `packages/e2e` | End-to-end tests against the full agent |

## Layer Architecture (11 layers, L0-L10)

Each layer is a functional subsystem. Layers are progressively deepened across implementation phases.

| Layer | Name | Status | Key Decisions |
|---|---|---|---|
| L0 | Provider | Multi-provider (Phase 3b) | D001, D003, D009, D010 |
| L1 | Agent Loop | Implemented (Phase 2) + compaction events (3b) | D004, D007, D008 |
| L2 | Tool System | Implemented (Phase 2) | D013, D014, D015, D025 |
| L3 | Core Tools | 8 tools (Phase 3b: +add_knowledge) | D017-D024, D082 |
| L4 | Approval | Stub (auto-approve, future) | D027-D031 |
| L5 | Config | 3-layer JSONC + knowledge/compaction wired | D032-D035 |
| L6 | Session | Persistent + compaction + knowledge | D036-REV, D037-D043, D080-D084 |
| L7 | TUI & Commands | Component framework + overlay system (Phase 4a) | D045-D051 |
| L8 | Skills | Planned (Phase 4b, merged with slash commands) | D052-D053 |
| L9 | MCP | Planned | D056-D061 |
| L10 | Multi-Agent | Planned | D062-D065 |

Deep research per layer: `docs/research/layers/NN-*.md`

## Key Design Patterns

- **EventStream** (D007): Custom async iterable for streaming LLM responses and agent events. Producer pushes events, consumer uses `for await`, completion via `.result()` promise. ~86 lines.
- **AgentEvent union** (D004): 15 tagged-union event types covering lifecycle, turns, message streaming, tool execution, status, usage, and errors. `MessageDelta` type prevents provider events leaking into L1.
- **Tool interface** (D013): `{ name, description, parameters (Zod schema), execute(args, ctx) }`. One file per tool in `packages/core/src/tools/`.
- **TurnContext** (D008): Immutable per-turn config (model, tools, policies) separated from mutable session state. Agent loop is a pure stateless function.
- **Provider abstraction** (D003): Common `Provider` interface with custom `StreamFunction`. Anthropic and OpenAI (Responses API) providers. Model registry with alias resolution.
- **Session persistence** (D006/D036-REV): JSONL append-only files with tree structure (id/parentId). Project-local at `.diligent/sessions/`. SESSION_VERSION 2 with CompactionEntry.
- **Compaction** (D037-D039): Token-based trigger with LLM summarization. Proactive (pre-turn check) and reactive (context_overflow recovery). File operation tracking across compactions.
- **Knowledge** (D081-D083): JSONL append-only store with 5 typed entries. Ranked injection into system prompt with 30-day time decay and token budget. `add_knowledge` tool for autonomous recording.
- **Project data directory** (D080): `.diligent/` stores sessions, knowledge, and skills. Auto-generated `.gitignore` excludes sessions and knowledge.

## Key Decisions Summary

| ID | Decision | Rationale |
|---|---|---|
| D001 | Bun + TypeScript strict | Fast startup, native TS, good DX |
| D003 | Custom provider abstraction (not ai-sdk) | Full control, no heavy dependency |
| D004 | 18 AgentEvent types (tagged union) | Middle ground between codex-rs (40+) and pi-agent (12). Phase 3b added compaction_start/end, knowledge_saved |
| D006 | JSONL append-only sessions | Simple, no data loss, supports branching |
| D008 | Immutable TurnContext + mutable SessionState | Prevents accidental mutation during tool execution |
| D013 | Tool = object with Zod schema + execute() | Clean, testable, one file per tool |
| D036-REV | Sessions in `.diligent/sessions/` (project-local) | Portable, shareable, easy backup |
| D080 | `.diligent/` project data directory | Separates config (global) from data (project-local) |
| D086 | Codex protocol alignment (SessionManager + itemId + serialization) | Future web UI as thin wrapper, not deep refactor |

Full decision log: `docs/plan/decisions.md` (D001-D087)

## Dev Commands

```bash
bun test                  # Run all tests (Bun test runner)
bun run lint              # Lint (Biome)
bun run lint:fix          # Lint + auto-fix
bun run typecheck         # TypeScript type checking
```
