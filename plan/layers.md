# Layer Definitions and Order

## Current Layer List (v2)

| Layer | Name | One-Line Definition | Decisions |
|---|---|---|---|
| L0 | Provider | LLM provider abstraction, streaming, API clients, token counting | D001-D003, D007 |
| L1 | Agent Loop | Core conversation loop, messages, events, turn/session state, cancellation, retry | D004-D005, D008-D011 |
| L2 | Tool System | Framework for defining, registering, invoking tools; result format, progress, truncation | D012-D016, D020-D021, D025, D071 |
| L3 | Core Tools | Built-in tools: read, write, edit, bash, glob, grep, ls | D017-D019, D022-D024, D072 |
| L4 | Approval | Rule-based permission system, ctx.ask(), doom loop detection | D027-D031, D070 |
| L5 | Config | JSONC config with Zod validation, 3-layer hierarchy, CLAUDE.md discovery | D032-D035, D073-D074 |
| L6 | Session | JSONL persistence, tree structure, compaction, resume/fork, version migration | D036-D043 |
| L7 | TUI & Commands | Terminal UI (inline ANSI, markdown, input, overlays) + built-in slash commands | D045-D051, D054 |
| L8 | Skills | SKILL.md discovery, frontmatter, implicit/explicit invocation, prompt injection | D052-D053, D075 |
| L9 | MCP | Model Context Protocol client, transports, tool conversion, lifecycle | D056-D061 |
| L10 | Multi-Agent | TaskTool, child sessions, agent types, permission isolation | D062-D066 |

Cross-cutting decisions: D067-D069, D076 (full review, convergence)

## Changes from v1

| Change | Reason |
|---|---|
| Old L0 (REPL Loop) → L0 (Provider) + L1 (Agent Loop) | L0 was overloaded: Provider is an independent subsystem in all 3 reference projects (codex-rs: `codex-api`, pi-agent: `ai`, opencode: `provider/`) |
| Old L7 (Slash Commands & Skills) → Commands merged into L7 (TUI), Skills split to L8 | Commands are TUI actions (imperative). Skills are LLM content (declarative). Different concerns, different consumers. |
| Total: 10 → 11 layers | Net +1 from splitting L0 and L7 |

## Dependencies

```
L0 (Provider)
  ← L1 (Agent Loop)         — loop calls provider for LLM responses
     ← L2 (Tool System)     — loop executes tools via registry
        ← L3 (Core Tools)   — tool implementations
        ← L4 (Approval)     — ctx.ask() permission hook in tool context
        ← L8 (Skills)       — skill metadata injected into system prompt
        ← L9 (MCP)          — MCP tools converted to registry entries
           L4 ← L9          — MCP tools use same permission system
           L5 ← L9          — MCP server config in JSONC
        ← L10 (Multi-Agent) — task tool registered in registry
           L4 ← L10         — sub-agent permission isolation
           L6 ← L10         — child sessions use session system
     ← L5 (Config)          — config loaded at agent init
     ← L6 (Session)         — session wraps the conversation loop
     ← L7 (TUI & Commands)  — UI renders events, commands dispatch actions
```

Key observations:
- L0 (Provider) is the foundation — no dependencies
- L1 (Agent Loop) depends only on L0
- L2 (Tool System) is the universal integration point for L3, L4, L8, L9, L10
- L5 (Config) and L6 (Session) are relatively independent
- L9 and L10 have the deepest dependency chains → implement last

## Implementation Order

```
L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9 → L10
                      ↕         ↕
                  L5 and L6 parallelizable with L3/L4
```

## Research Round Mapping

| Round | Old Layers | New Layers |
|---|---|---|
| 0 | L0 (REPL Loop) | L0 (Provider) + L1 (Agent Loop) |
| 1 | L1 (Tool System) + L2 (Core Tools) | L2 (Tool System) + L3 (Core Tools) |
| 2 | L3 + L4 + L5 | L4 (Approval) + L5 (Config) + L6 (Session) |
| 3 | L6 (TUI) + L7 (Slash Commands & Skills) | L7 (TUI & Commands) + L8 (Skills) |
| 4 | L8 (MCP) + L9 (Multi-Agent) | L9 (MCP) + L10 (Multi-Agent) |

Research content is unchanged — same analysis, same code, same observations. Only the layer numbering and grouping changed.

## Research Progress

All research complete. 78 decisions (D001-D078). D079 proposed (FileTime conflict detection).

- Cycle 1: 10-layer v1, 76 decisions (D001-D076). Converged. Layer redesign v2 (D077-D078).
- Cycle 2: 11-layer v2, 78 decisions (D001-D078). Full review pass complete. Converged. No Cycle 3 needed.
- Full review: `research/cycle2-review.md`

**RESEARCH CONVERGED. Next step: architecture design (`plan/architecture.md`).**

## Change History

| Date | Change | Reason |
|---|---|---|
| 2026-02-22 | Initial layer list created (v1, 10 layers) | Based on decomposition of coding agent capabilities |
| 2026-02-23 | Cycle 1: Rounds 0-4 research complete | Deep-dive across codex-rs, pi-agent, opencode |
| 2026-02-23 | Cycle 1: Full review pass + outer loop evaluation | 76 decisions, research converged (D076) |
| 2026-02-23 | Layer redesign v2 (10 → 11 layers) | L0 too fat (Provider split out), L7 conflated two concerns (Commands → TUI, Skills → separate layer) |
| 2026-02-23 | Cycle 2: Rounds 0-4 re-research complete | All 11 layers re-researched under v2 structure, 78 decisions (D001-D078) |
| 2026-02-23 | Cycle 2: Full review pass + outer loop evaluation | All files consistent, no updates needed, research converged, Cycle 3 NOT needed |
