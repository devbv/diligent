# Project Status

## Current Phase

**Phase 3b** — Compaction + Knowledge system + Multi-provider (OpenAI)

Implementation spec: `plan/impl/phase-3b-compaction-knowledge-multiprovider.md`

### Scope
- **Compaction**: Token-based trigger (D038), LLM summarization (D037), simple cut points (turn boundaries only), file operation tracking (D039), context re-injection (D041)
- **Knowledge**: JSONL store (D081), `add_knowledge` tool (D082), system prompt injection with 8192 token budget (D083), autonomous recording via system prompt instruction
- **Multi-provider**: OpenAI Responses API provider, model registry with known model definitions, provider selection by model prefix

### Key Decisions
- Simple cut points only — no split-turn compaction
- System prompt instruction for knowledge nudge — no per-turn injection
- OpenAI Responses API (not Chat Completions)
- Pre-compaction knowledge flush simplified to system prompt instruction (D084 full form deferred)

### Risk Areas
- Compaction summary quality (test with real sessions)
- Token estimation accuracy (chars/4 heuristic)
- OpenAI Responses API event format verification
- SESSION_VERSION 1→2 backward compatibility

## Phases Complete

| Phase | Completed | Key Artifacts |
|---|---|---|
| Phase 0: Skeleton | 2026-02-24 | Monorepo scaffolding, core type definitions (AgentEvent, Tool, EventStream, Provider interfaces) |
| Phase 1: Minimal Agent | 2026-02-24 | Agent loop (180 lines), EventStream (86 lines), Anthropic provider, bash tool, readline TUI, E2E test package |
| Phase 2: Functional Coding Agent | 2026-02-25 | All 7 core tools, full 15 AgentEvent types, retry with exponential backoff, markdown rendering, spinner, auto-truncation (D025), ~2,300 lines of production code |
| Phase 3a: Config & Session Persistence | 2026-02-25 | D086 protocol readiness (itemId, SerializableError, ApprovalResponse), .diligent/ directory convention, JSONC config (3-layer hierarchy, Zod schema, env overrides), CLAUDE.md discovery (findUp + .git boundary), JSONL session persistence (DeferredWriter, tree structure), context builder (tree→linear), SessionManager mediator, EventStream.subscribe() observer, CLI --continue/--list flags, 254 tests |