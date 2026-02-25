# Project Status

## Current Phase

**Phase 3** — Configuration & Persistence (split into 3a and 3b)
- **Phase 3a**: Config (JSONC + hierarchy + CLAUDE.md discovery) + Session persistence (SessionManager + JSONL)
- **Phase 3b**: Compaction + Knowledge system + Multi-provider (OpenAI)

Implementation spec: `plan/impl/phase-3a-config-persistence.md`

## Phases Complete

| Phase | Completed | Key Artifacts |
|---|---|---|
| Phase 0: Skeleton | 2026-02-24 | Monorepo scaffolding, core type definitions (AgentEvent, Tool, EventStream, Provider interfaces) |
| Phase 1: Minimal Agent | 2026-02-24 | Agent loop (180 lines), EventStream (86 lines), Anthropic provider, bash tool, readline TUI, E2E test package |
| Phase 2: Functional Coding Agent | 2026-02-25 | All 7 core tools, full 15 AgentEvent types, retry with exponential backoff, markdown rendering, spinner, auto-truncation (D025), ~2,300 lines of production code |

## Phase 3 Scope

### Phase 3a: Config + Persistence
- JSONC config with Zod validation, 3-layer hierarchy (D032-D035)
- CLAUDE.md discovery via findUp (D035)
- **SessionManager** mediator class — wraps `agentLoop()`, owns session lifecycle (D086)
- JSONL session persistence with tree structure (D036-REV, D040-D043)
- `.diligent/` project data directory (D080)
- `itemId` on grouped AgentEvent subtypes (D086)
- Expanded `ApprovalRequest`/`ApprovalResponse` types (D086, D028, D029)
- JSON serialization roundtrip test convention (D086)
- CLI: `--continue`, `--list`

### Phase 3b: Compaction + Knowledge + Multi-Provider
- LLM-based compaction with iterative summary updating (D037)
- Knowledge store in `.diligent/knowledge/` (D081-D084)
- `add_knowledge` tool (D082)
- OpenAI provider (D003)

## Risk Areas

- **LLM compaction** (D037) touches L1/L6/L0 — the riskiest Phase 3 feature
- **SessionManager** design (D086) must be right before persistence — it's the core↔consumer boundary
- **Serialization contract** (D086) — all types crossing core↔consumer must be JSON-serializable

## Backlog

- [ ] Add context budget management for compaction
- [ ] Implement background async piggyback pattern
- [ ] Sync debug-viewer shared types when Phase 3 implements session persistence

Full backlog: `BACKLOG.md`

## Recent Decisions

| ID | Decision | Date |
|---|---|---|
| D080 | `.diligent/` project data directory convention | 2026-02-24 |
| D081 | Knowledge store — JSONL append-only with typed entries | 2026-02-24 |
| D082 | Knowledge extraction via `add_knowledge` tool | 2026-02-24 |
| D083 | Knowledge injection — system prompt with token budget | 2026-02-24 |
| D084 | Knowledge-compaction interaction — flush before compact | 2026-02-24 |
| D085 | Export/import mechanism for `.diligent/` data | 2026-02-24 |
| D086 | Codex protocol alignment — SessionManager + itemId + serialization | 2026-02-25 |

Full decision log: `plan/decisions.md` (D001-D086)

## Available Skills

| Skill | Trigger | What it does |
|---|---|---|
| `/backlog` | Backlog management | Add, complete, view backlog items in `BACKLOG.md` |
| `/impl-plan` | Create implementation plans | Generate phase specs under `plan/impl/` |
| `/research` | Structured research | Investigate topics, write findings to `research/` |

---

*Last updated: 2026-02-25*
