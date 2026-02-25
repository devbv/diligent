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
| L0 | Provider | Implemented (Phase 2) | D001, D003, D010 |
| L1 | Agent Loop | Implemented (Phase 2) | D004, D007, D008 |
| L2 | Tool System | Implemented (Phase 2) | D013, D014, D015, D025 |
| L3 | Core Tools | Implemented (Phase 2) | D017-D024 |
| L4 | Approval | Stub (auto-approve) | D027-D031 |
| L5 | Config | Env-only | D032-D035 |
| L6 | Session | In-memory only | D036-REV, D040-D043, D080 |
| L7 | TUI & Commands | Minimal (readline + markdown + spinner) | D045-D051 |
| L8 | Skills | Planned | D052-D053 |
| L9 | MCP | Planned | D056-D061 |
| L10 | Multi-Agent | Planned | D062-D065 |

Deep research per layer: `research/layers/NN-*.md`

## Key Design Patterns

- **EventStream** (D007): Custom async iterable for streaming LLM responses and agent events. Producer pushes events, consumer uses `for await`, completion via `.result()` promise. ~86 lines.
- **AgentEvent union** (D004): 15 tagged-union event types covering lifecycle, turns, message streaming, tool execution, status, usage, and errors. `MessageDelta` type prevents provider events leaking into L1.
- **Tool interface** (D013): `{ name, description, parameters (Zod schema), execute(args, ctx) }`. One file per tool in `packages/core/src/tools/`.
- **TurnContext** (D008): Immutable per-turn config (model, tools, policies) separated from mutable session state. Agent loop is a pure stateless function.
- **Provider abstraction** (D003): Common `Provider` interface with custom `StreamFunction`. Currently Anthropic only; OpenAI planned for Phase 3b.
- **Session persistence** (D006/D036-REV): JSONL append-only files with tree structure (id/parentId). Project-local at `.diligent/sessions/`.
- **Project data directory** (D080): `.diligent/` stores sessions, knowledge, and skills. Auto-generated `.gitignore` excludes sessions and knowledge.

## Key Decisions Summary

| ID | Decision | Rationale |
|---|---|---|
| D001 | Bun + TypeScript strict | Fast startup, native TS, good DX |
| D003 | Custom provider abstraction (not ai-sdk) | Full control, no heavy dependency |
| D004 | 15 AgentEvent types (tagged union) | Middle ground between codex-rs (40+) and pi-agent (12) |
| D006 | JSONL append-only sessions | Simple, no data loss, supports branching |
| D008 | Immutable TurnContext + mutable SessionState | Prevents accidental mutation during tool execution |
| D013 | Tool = object with Zod schema + execute() | Clean, testable, one file per tool |
| D036-REV | Sessions in `.diligent/sessions/` (project-local) | Portable, shareable, easy backup |
| D080 | `.diligent/` project data directory | Separates config (global) from data (project-local) |
| D086 | Codex protocol alignment (SessionManager + itemId + serialization) | Future web UI as thin wrapper, not deep refactor |

Full decision log: `plan/decisions.md` (D001-D086)

## Dev Commands

```bash
bun test                  # Run all tests (Bun test runner)
bun run lint              # Lint (Biome)
bun run lint:fix          # Lint + auto-fix
bun run typecheck         # TypeScript type checking
```
