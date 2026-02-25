# Implementation Phases vs Research Layers

## Why They Differ

Research layers are organized by **functional concern** — each layer is a coherent subsystem (Provider, Tool System, Approval, etc.). This is optimal for understanding: you study one concern deeply, then the next.

Implementation phases are organized by **usable increments** — what's the minimum work needed to produce a testable, demonstrable artifact at each stage. This requires cutting *across* multiple layers simultaneously.

```
Research (horizontal):       Implementation (vertical):
┌─────────────────────┐      ┌──┬──┬──┬──┬──┐
│ L0: Provider        │      │P0│P1│P2│P3│P4│
├─────────────────────┤      │  │  │  │  │  │
│ L1: Agent Loop      │      │  │  │  │  │  │
├─────────────────────┤      │  │  │  │  │  │
│ L2: Tool System     │      │  │  │  │  │  │
├─────────────────────┤      │  │  │  │  │  │
│ L3: Core Tools      │      │  │  │  │  │  │
├─────────────────────┤      │  │  │  │  │  │
│ L4: Approval        │      │  │  │  │  │  │
├─────────────────────┤      │  │  │  │  │  │
│ ...                 │      │  │  │  │  │  │
└─────────────────────┘      └──┴──┴──┴──┴──┘
  (one layer at a time)      (thin slices across layers)
```

### Key Insight: Each Layer Has "Minimal" and "Complete" Forms

A layer doesn't need to be fully implemented before the next layer begins. For example:
- **L0 minimal**: Single Anthropic provider, basic streaming → needed in Phase 1
- **L0 complete**: Multiple providers, full error classification, cost tracking → Phase 3

This "progressive deepening" means layers are revisited across multiple phases.

---

## Structural Differences from D078

D078 (research-derived implementation order):
```
L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9 → L10
```

This is the **dependency order** — correct for understanding, but not for building. Three major shifts are needed:

### 1. TUI (L7) Moves to Phase 1

D078 places L7 seventh. But without any TUI, you cannot:
- Enter a user message
- See agent responses
- Observe tool execution

Even the simplest test requires input/output. A minimal TUI (readline + stdout) is a **Phase 1 prerequisite**, not a Phase 7 feature.

### 2. Config (L5) Splits Across Phases

D078 places L5 fifth. But the agent needs configuration (API key, model name) from the very first run. The full config system (JSONC, 3-layer hierarchy, CLAUDE.md discovery) is complex and can wait, but a minimal env-based bootstrap cannot.

- **Phase 1**: Env vars only (`ANTHROPIC_API_KEY`, `DILIGENT_MODEL`)
- **Phase 3**: Full JSONC config, hierarchy, CLAUDE.md

### 3. Approval (L4) Defers Relative to L5/L6/L7

D078 places L4 before L5/L6/L7. But for early development:
- Auto-approving everything is safe (developer testing on own machine)
- Permission UI requires TUI overlays (L7 complete)
- Rule-based matching requires config schema (L5 complete)

L4 is best implemented *after* the systems it depends on for full functionality.

---

## Implementation Phases

### Phase 0: Project Skeleton ✅ COMPLETE (2026-02-24)

**Goal**: Build infrastructure, development tools, core type definitions.

**Scope**:
- Monorepo scaffolding (Bun workspace: `packages/core`, `packages/cli`)
- TypeScript strict mode, linting, formatting
- Test runner setup (Bun test)
- Core type definitions — interfaces only, no implementation:
  - `AgentEvent` union type (D004)
  - `Tool` interface (D013)
  - `ToolContext` type (D016)
  - `EventStream<T, R>` class (D007)
  - `Provider` interface (D003)
- CI pipeline (lint + typecheck + test)

**Artifact**: Empty project that compiles and runs empty tests.

**Layers touched**: None implemented, but interfaces from L0, L1, L2 defined.

---

### Phase 1: Minimal Viable Agent ✅ COMPLETE (2026-02-24)

**Goal**: An agent that can converse with an LLM and execute a basic tool.

```
User → "list files in current directory"
Agent → calls bash tool → "ls" → returns output
Agent → "Here are the files: ..."
```

**Scope per layer**:

| Layer | What's Needed | What's Deferred |
|---|---|---|
| L0 (Provider) | Single Anthropic provider, basic streaming, `EventStream` | Multi-provider, error classification, cost tracking |
| L1 (Agent Loop) | Minimal loop: user→LLM→tool→LLM→response. ~5 event types | Full 15 event types, retry, compaction trigger, steering |
| L2 (Tool System) | Tool interface, Map registry, basic executor | Auto-truncation, progress events, parallel-ready |
| L3 (Core Tools) | `bash` tool only | read, write, edit, glob, grep, ls |
| L5 (Config) | Env-based config (`ANTHROPIC_API_KEY`, `DILIGENT_MODEL`) | JSONC, hierarchy, CLAUDE.md |
| L7 (TUI) | Readline input, raw stdout with basic formatting | Markdown, ANSI components, overlays, commands |

**Not touched**: L4 (auto-approve all), L6 (in-memory only), L8, L9, L10

**Artifact**: Interactive CLI agent that can run bash commands and respond.

**Testing milestone**: Manual conversation test — ask agent to run a command, verify it works.

**Implementation notes**:
- Detailed spec: `plan/impl/phase-1-minimal-agent.md`
- Agent loop implemented in 180 lines (functional pattern per D008)
- EventStream implemented in 86 lines (matching pi-agent's ~88 line reference)
- E2E tests established in `packages/e2e/` workspace package

---

### Phase 2: Functional Coding Agent ✅ COMPLETE (2026-02-25)

**Goal**: An agent that can read, edit, and search a codebase.

```
User → "find all TODO comments and list them"
Agent → calls grep tool → finds TODOs → summarizes
User → "fix the typo in config.ts line 42"
Agent → calls read tool → sees the typo → calls edit tool → fixes it
```

**Scope per layer**:

| Layer | What's Added | What's Deferred |
|---|---|---|
| L0 (Provider) | Error classification (retryable/non-retryable), retry-after header | Multi-provider, cost tracking |
| L1 (Agent Loop) | Full 15 event types, retry with exponential backoff, abort handling | Compaction trigger, steering |
| L2 (Tool System) | Auto-truncation (D025), progress callback (D071) | Parallel execution |
| L3 (Core Tools) | All 7 tools: read, write, edit, bash, glob, grep, ls | Advanced edit strategies, FileTime |
| L7 (TUI) | Markdown rendering (marked), spinner, streaming display | Overlays, commands, Kitty protocol |

**Not touched**: L4 (still auto-approve), L5 (still env-based), L6 (still in-memory), L8, L9, L10

**Artifact**: Coding agent that can read/edit files, search code, run commands.

**Testing milestone**: Ask agent to make a code change across files. Verify correctness.

**Implementation notes**:
- Detailed spec: `plan/impl/phase-2-functional-coding-agent.md`
- D012 refined: `z.toJSONSchema()` replaced with `zod-to-json-schema` library (simpler, more reliable)
- D004 confirmed: 15 AgentEvent types implemented. `MessageDelta` type introduced to prevent ProviderEvent leak into L1 events (commit `4252fd6`)
- D015 `supportParallel` flag deferred — not needed until parallel execution is implemented
- D024 fuzzy match deferred — Phase 2 implements exact match only as planned
- All 7 tools functional, ~2,300 lines of production code added
- Tech debt addressed in dedicated cleanup commit (`eb1ea9c`)

---

### Phase 3: Configuration & Persistence

**Goal**: User can configure the agent per-project and resume sessions.

```
User → creates diligent.jsonc with custom model/instructions
User → creates CLAUDE.md with project context
User → starts agent, agent respects both configs
User → exits, resumes → conversation continues with summary
```

**Scope per layer**:

| Layer | What's Added | What's Deferred |
|---|---|---|
| L5 (Config) | Full JSONC + Zod validation, 3-layer hierarchy, CLAUDE.md discovery, template substitution (D032-D035) | Enterprise config, config editing UI |
| L6 (Session) | JSONL persistence, tree structure, compaction (LLM summarization), resume/fork, deferred persistence (D036-REV, D037-D043) | Version migration (add when format changes) |
| L6 (Knowledge) | Knowledge store `.diligent/knowledge/` (D081), `add_knowledge` tool (D082), knowledge injection in system prompt (D083), pre-compaction knowledge flush (D084) | Export/import (D085, add when needed) |
| L1 (Agent Loop) | Compaction trigger hook, context re-injection after compaction (D041), knowledge flush prompt before compaction (D084) | — |
| L0 (Provider) | Multiple providers (add OpenAI), model switching | Cost tracking (add when needed) |
| Infrastructure | `.diligent/` project data directory convention (D080), auto-generated `.gitignore` | — |

**Not touched**: L4 (still auto-approve), L7 (no new TUI features), L8, L9, L10

**Artifact**: Configurable, persistent agent. Sessions survive restarts. Knowledge accumulates across sessions.

**Testing milestone**: Start session, make edits, exit, resume — verify compaction summary is accurate and files are tracked. Verify knowledge persists across sessions.

**Known complexity risks**:
- LLM compaction (D037) is the riskiest feature — touches L1, L6, and L0. Consider splitting Phase 3 into sub-phases (3a: config + basic persistence, 3b: compaction + knowledge + multi-provider) if implementation complexity is high.
- Temp file cleanup from Phase 2's D025 implementation should be resolved when session directories are introduced.

---

### Phase 4: Safety & UX Polish

**Goal**: Permission system protects against unwanted actions. Full TUI with slash commands, overlays, multi-mode.

```
Agent → wants to delete a file → approval overlay appears
User → "always allow" → rule saved for session
User → /model → model picker overlay
User → echo "fix bug" | diligent → print mode, outputs to stdout
```

**Scope per layer**:

| Layer | What's Added | What's Deferred |
|---|---|---|
| L4 (Approval) | Full rule-based matching, ctx.ask(), "always" caching, doom loop detection, denied tool filtering | OS-level sandboxing, tree-sitter bash parsing |
| L7 (TUI) | Input: Kitty protocol, bracketed paste. Output: ANSI components, overlay system. Commands: slash command registry (~15 commands). Multi-mode: Interactive + Print | Command palette, custom themes |
| L5 (Config) | Permission rules in config, session-scoped "always" rules | Config editing with comment preservation |

**Not touched**: L8, L9, L10

**Artifact**: Safe, polished coding agent with full terminal UX.

**Testing milestone**: Verify permission prompts appear for destructive operations. Verify slash commands work. Verify print mode piping.

---

### Phase 5: Extensibility

**Goal**: Skills, MCP servers, and multi-agent delegation.

This phase can be split into three sub-phases since L8, L9, L10 are relatively independent:

#### Phase 5a: Skills (L8)
- SKILL.md discovery from global/project/config paths
- Frontmatter parsing, progressive disclosure
- Implicit (LLM-driven) + explicit (`/skill:name`) invocation
- System prompt injection of skill metadata

#### Phase 5b: MCP (L9)
- Official `@modelcontextprotocol/sdk` integration
- Stdio + StreamableHTTP transports
- MCP tools → registry conversion (D059)
- Startup parallel connection, ToolListChangedNotification
- Permission integration (same rules as built-in tools)

#### Phase 5c: Multi-Agent (L10)
- TaskTool (single tool, child sessions)
- Agent types: `general` (full access), `explore` (read-only)
- Permission isolation (deny rules for sub-agents)
- Result wrapping, resume via task_id

**Artifact**: Fully extensible coding agent with skill system, MCP support, and sub-agent delegation.

---

## Phase-Layer Matrix

Shows which layers are active in each phase and at what depth.

```
         Phase 0   Phase 1   Phase 2   Phase 3       Phase 4   Phase 5
         Skeleton  Min Agent Coding    Config+       Safety+   Extend
         ✅        ✅        ✅        Persist+Know  UX

L0  Prov  types    minimal   +retry    +multi        —         —
L1  Loop  types    minimal   +full     +compact      —         —
L2  Tool  types    minimal   +trunc    +knowledge    —         —
L3  Core  —        bash      +all 7    +add_knowl    —         —
L4  Appr  —        (auto)    (auto)    (auto)        FULL      —
L5  Conf  —        env-only  —         FULL          +perm     —
L6  Sess  —        (memory)  (memory)  FULL+knowl    —         —
L7  TUI   —        readline  +md+spin  —             FULL      —
L8  Skil  —        —         —         —             —         FULL
L9  MCP   —        —         —         —             —         FULL
L10 Mult  —        —         —         —             —         FULL
Infra     scaffold CI+E2E    +e2e-pkg  .diligent/    —         —
```

Legend: `types` = interfaces only, `minimal` = bare minimum, `+X` = incremental addition, `FULL` = complete implementation, `(auto)` / `(memory)` = placeholder/stub, `—` = no change, `✅` = complete

---

## Comparison: Research Order vs Implementation Order

| Aspect | Research (D078) | Implementation (Phases) |
|---|---|---|
| **Organizing principle** | Dependency order by concern | Usable increment per milestone |
| **L7 (TUI)** | 8th | 1st (minimal), 5th (complete) |
| **L5 (Config)** | 6th | 1st (env), 4th (full) |
| **L4 (Approval)** | 5th | 5th (after L5, L6, L7 are complete) |
| **L6 (Session)** | 7th | 4th (after coding tools work) |
| **Layer depth** | Complete one layer, then next | Progressive deepening across phases |
| **First testable artifact** | After L0+L1+L2+L3 (4 layers full) | After Phase 1 (6 layers minimal) |
| **Dependencies** | Respected in both | Respected, but stubs fill gaps |

---

## Interface-First Strategy

To support progressive deepening, **define interfaces before implementing**:

Phase 0 defines core interfaces → Phase 1 implements minimal versions → Later phases fill in.

This means the `Tool` interface (D013) is defined once and never changes. What changes is:
- How many tools are registered (Phase 1: 1, Phase 2: 7, Phase 5: +MCP tools)
- How the executor works (Phase 1: basic, Phase 2: +truncation, Phase 4: +permission)
- What ToolContext provides (Phase 1: abort signal, Phase 4: +ctx.ask())

The `ctx.ask()` hook (D016/D028) is defined in Phase 0 as part of the interface but implemented as auto-approve until Phase 4 fills it in. This is the **extension point pattern** — design the hooks early, implement them late.

---

## Risk Areas by Phase

| Phase | Risk | Mitigation |
|---|---|---|
| 1 | EventStream design locks in too early | Study pi-agent's EventStream (~88 lines) carefully before implementing |
| 1 | Minimal TUI too minimal to be useful | Add Ctrl+C handling, basic multi-line input from the start |
| 2 | Edit tool fuzzy matching is surprisingly hard | Start with exact match only, add fuzzy in a follow-up |
| 3 | Compaction summaries lose critical context | Test with real coding sessions, not toy examples |
| 3 | JSONL session format hard to change later | Version header (D043) from day one |
| 4 | Approval UI interrupts flow too often | Tune default rules to minimize prompts for common operations |
| 5 | MCP server startup slows agent launch | Parallel connection (D061), timeout per server |

---

## Summary

Research layers and implementation phases serve different purposes:
- **Layers** answer "what are the subsystems and how do they work?"
- **Phases** answer "what do we build first to get something working?"

The key structural differences:
1. **TUI and Config bootstrap early** (Phases 1-2) despite being "late" layers (L5, L7)
2. **Approval defers** (Phase 4) despite being an "early" layer (L4)
3. **Each layer is progressively deepened** across multiple phases, not completed all at once
4. **Each phase produces a testable artifact** — no phase ends with "nothing works yet"

D078 remains valid as the dependency-aware research order. This document defines the complementary **delivery-aware implementation order**.
