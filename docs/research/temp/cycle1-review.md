# Cycle 1 Full Review & Evaluation

## Purpose

Evaluate Cycle 1 results to determine whether Cycle 2 is needed, per the outer loop criteria in `research-process.md`.

---

## 1. Open Questions Resolution Audit

Mapping every open question from every research file against the 69 decisions.

### L0: REPL Loop (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Event granularity | D004 (pi-agent level ~10-15 events) | ✅ Resolved |
| 2 | Message model (unified vs parts) | D005 (unified, not part-based) | ✅ Resolved |
| 3 | Streaming transport | D007 (custom EventStream) | ✅ Resolved |
| 4 | State persistence | D006/D036 (JSONL append-only) | ✅ Resolved |
| 5 | Provider SDK usage | D003 (roll own, not ai-sdk) | ✅ Resolved |
| 6 | Server architecture | D046 (no server between TUI and core) | ✅ Resolved |
| 7 | Context overflow handling | D037/D038 (LLM compaction, auto-trigger) | ✅ Resolved |
| 8 | Steering/interruption | D009 (AbortController; steering deferred) | ✅ Resolved |
| 9 | Turn context vs session state | D008 (immutable TurnContext + mutable SessionState) | ✅ Resolved |
| 10 | Doom loop detection | D031 (same tool+input 3x) | ✅ Resolved |

**Result: 10/10 resolved** ✅

### L1: Tool System (9 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Schema system | D012 (Zod) | ✅ Resolved |
| 2 | Registry complexity | D014 (Map registry) | ✅ Resolved |
| 3 | Parallel execution | D015 (sequential, parallel-ready) | ✅ Resolved |
| 4 | Approval integration | D016 (placeholder hook in context) | ✅ Resolved |
| 5 | Lazy initialization | D026 deferred | ✅ Deferred |
| 6 | Tool result format | D020 (string + metadata) | ✅ Resolved |
| 7 | Streaming during execution | Implied by D004/D007 (EventStream) | ⚠️ Implicit |
| 8 | Doom loop detection | D031 | ✅ Resolved |
| 9 | ProviderTransform | Deferred to implementation | ✅ Deferred |

**Result: 8/9 resolved, 1 implicit** — Q7 is covered by the EventStream design but not explicitly stated as a decision.

### L2: Core Tools (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Minimum tool set | D017/D022 (7 tools, ripgrep for glob) | ✅ Resolved |
| 2 | Edit strategy | D018/D024 (exact+fuzzy) | ✅ Resolved |
| 3 | Shell output handling | D019/D025 (Bun.spawn, auto-truncation) | ✅ Resolved |
| 4 | Read modes | D026 deferred (simple offset/limit) | ✅ Deferred |
| 5 | Operations abstraction | D026 deferred | ✅ Deferred |
| 6 | Binary detection | D023 | ✅ Resolved |
| 7 | External tool dependencies | Not decided | ⚠️ Gap |
| 8 | LSP integration | D026 deferred | ✅ Deferred |
| 9 | Tree-sitter bash | D044 deferred | ✅ Deferred |
| 10 | FileTime locking | D026 deferred | ✅ Deferred |

**Result: 9/10 resolved, 1 gap** — Q7 (ripgrep bundling/auto-download) is an implementation detail, not architectural.

### L3: Approval & Sandbox (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Approval granularity | D027 (rule-based, wildcard patterns) | ✅ Resolved |
| 2 | Sandbox at MVP | D030 (no OS sandbox) | ✅ Resolved |
| 3 | Rule format | D027 (wildcard patterns, not Starlark) | ✅ Resolved |
| 4 | Approval persistence | D029 (session-only for MVP) | ✅ Resolved |
| 5 | Network sandboxing | D030 deferred | ✅ Deferred |
| 6 | Escalation pattern | Not decided | ⚠️ Gap |
| 7 | Integration point | D028 (ctx.ask() inline) | ✅ Resolved |
| 8 | Doom loop detection | D031 (part of L3) | ✅ Resolved |
| 9 | Disabled tools (remove from LLM view?) | Not decided | ⚠️ Gap |
| 10 | "Always" cascading | D029 | ✅ Resolved |

**Result: 8/10 resolved, 2 gaps** — Q6 (escalation) is not needed for MVP. Q9 (disabled tools from LLM view) is a design choice that should be decided.

### L4: Config System (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Config format | D032 (JSONC) | ✅ Resolved |
| 2 | Number of layers | D033 (3 layers) | ✅ Resolved |
| 3 | Schema validation | D032 (Zod) | ✅ Resolved |
| 4 | Project instructions | D035 (CLAUDE.md findUp) | ✅ Resolved |
| 5 | Constrained values | Deferred | ✅ Deferred |
| 6 | File locking | Not decided | ⚠️ Gap |
| 7 | Config editing (JSONC-preserving) | Not decided | ⚠️ Gap |
| 8 | Markdown-based config | D052 (SKILL.md) | ✅ Resolved |
| 9 | Template substitution | D044 deferred | ✅ Deferred |
| 10 | Remote config | Deferred | ✅ Deferred |

**Result: 7/10 resolved, 3 gaps** — Q6 and Q7 are implementation details (config file locking, JSONC-preserving edits).

### L5: Session & Persistence (12 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Storage format | D036 (JSONL) | ✅ Resolved |
| 2 | Tree structure | D036 (tree with id/parentId) | ✅ Resolved |
| 3 | Compaction strategy | D037 (iterative summary) | ✅ Resolved |
| 4 | Two-phase compaction | D044 deferred | ✅ Deferred |
| 5 | Token estimation | D038 (chars/4) | ✅ Resolved |
| 6 | File operation tracking | D039 | ✅ Resolved |
| 7 | Context re-injection | D041 | ✅ Resolved |
| 8 | Session listing/resume | D040 | ✅ Resolved |
| 9 | Compaction template | D037 (structured template) | ✅ Resolved |
| 10 | Deferred persistence | D042 | ✅ Resolved |
| 11 | Per-session permissions | D044 deferred | ✅ Deferred |
| 12 | Version migration | D043 | ✅ Resolved |

**Result: 12/12 resolved** ✅

### L6: TUI (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Alternate vs inline | D045 (inline) | ✅ Resolved |
| 2 | TUI framework | D045 (custom ANSI) | ✅ Resolved |
| 3 | Client-server | D046 (no server) | ✅ Resolved |
| 4 | Markdown rendering | D047 (marked + ANSI) | ✅ Resolved |
| 5 | Streaming visualization | D047 (newline-gated) | ✅ Resolved |
| 6 | Component model | D045 (pi-agent Component interface) | ✅ Resolved |
| 7 | Syntax highlighting | D055 deferred | ✅ Deferred |
| 8 | LSP in TUI | D055 deferred | ✅ Deferred |
| 9 | Overlay system | D050 | ✅ Resolved |
| 10 | Multi-mode | D054 (Interactive + Print) | ✅ Resolved |

**Result: 10/10 resolved** ✅

### L7: Slash Commands & Skills (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Skills vs commands | D051/D052 (separate) | ✅ Resolved |
| 2 | Command dispatch | D051 (registry pattern) | ✅ Resolved |
| 3 | User-defined commands | Partially via D052 (SKILL.md) | ⚠️ Partial |
| 4 | Skill format | D052 (SKILL.md + frontmatter) | ✅ Resolved |
| 5 | Implicit vs explicit | D053 (both) | ✅ Resolved |
| 6 | Skill dependencies | Not decided | ⚠️ Gap |
| 7 | Remote skill discovery | D055 deferred | ✅ Deferred |
| 8 | Extension system scope | D055 deferred | ✅ Deferred |
| 9 | Command palette | D055 deferred | ✅ Deferred |
| 10 | D044 resolution | D052 | ✅ Resolved |

**Result: 8/10 resolved, 2 gaps** — Q3 (user-defined commands beyond skills) and Q6 (skill dependencies validation).

### L8: MCP (10 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | SDK choice | D056 (official SDK) | ✅ Resolved |
| 2 | Transport priority | D057 (stdio + StreamableHTTP) | ✅ Resolved |
| 3 | MCP tool naming | D059 (serverName_toolName) | ✅ Resolved |
| 4 | MCP prompts as commands | D066 deferred | ✅ Deferred |
| 5 | OAuth | D066 deferred | ✅ Deferred |
| 6 | MCP server mode | D066 deferred | ✅ Deferred |
| 7 | Dynamic server management | D061 (startup + refresh) | ✅ Resolved |
| 8 | Permission granularity | D059 (same rules as built-in) | ✅ Resolved |
| 9 | D014/D055 connection | D059 (convert to registry) | ✅ Resolved |
| 10 | Elicitation | D066 deferred | ✅ Deferred |

**Result: 10/10 resolved** ✅

### L9: Multi-Agent (12 questions)

| # | Question | Resolved By | Status |
|---|----------|-------------|--------|
| 1 | Architecture choice | D062 (TaskTool, child sessions) | ✅ Resolved |
| 2 | Interactive vs one-shot | D066 deferred (one-shot for MVP) | ✅ Resolved |
| 3 | Depth limit | D064 (implicit via permission deny) | ✅ Resolved |
| 4 | Agent type definition | D063 (code + config override) | ✅ Resolved |
| 5 | Parallel execution | D066 deferred | ✅ Deferred |
| 6 | Permission isolation | D064 (explicit deny rules) | ✅ Resolved |
| 7 | Resume support | D065 (session_id for resume) | ✅ Resolved |
| 8 | Agent discovery | D066 deferred | ✅ Deferred |
| 9 | D014/D055 connection | D062 (single task tool in registry) | ✅ Resolved |
| 10 | Agent generation | D066 deferred | ✅ Deferred |
| 11 | Event/status system | D066 deferred | ✅ Deferred |
| 12 | Connection to L6 | D066 deferred | ✅ Deferred |

**Result: 12/12 resolved** ✅

---

## 2. Summary Scorecard

| Layer | Total Qs | Resolved | Gaps | Score |
|-------|----------|----------|------|-------|
| L0 REPL Loop | 10 | 10 | 0 | 100% |
| L1 Tool System | 9 | 8 | 1 (implicit) | 89% |
| L2 Core Tools | 10 | 9 | 1 (implementation) | 90% |
| L3 Approval | 10 | 8 | 2 (minor) | 80% |
| L4 Config | 10 | 7 | 3 (implementation) | 70% |
| L5 Session | 12 | 12 | 0 | 100% |
| L6 TUI | 10 | 10 | 0 | 100% |
| L7 Slash/Skills | 10 | 8 | 2 (minor) | 80% |
| L8 MCP | 10 | 10 | 0 | 100% |
| L9 Multi-Agent | 12 | 12 | 0 | 100% |
| **TOTAL** | **103** | **94** | **9** | **91%** |

---

## 3. Gap Analysis

The 9 unresolved gaps, classified by severity:

### Implementation Details (resolve during implementation, no research needed)
- **L1 Q7**: Streaming during tool execution — covered by EventStream design (D004/D007), just needs explicit wiring
- **L2 Q7**: Ripgrep bundling/auto-download — implementation choice, not architecture
- **L4 Q6**: Config file locking for concurrent access — implementation detail
- **L4 Q7**: JSONC-preserving edits for `/settings` — implementation detail

### Minor Design Choices (can be decided without further research)
- **L3 Q6**: Escalation pattern (retry without sandbox on failure) — not needed for MVP, codex-rs-specific
- **L3 Q9**: Disabled tools removed from LLM view vs let-fail — **worth deciding now**
- **L7 Q3**: User-defined commands beyond SKILL.md — skills cover this use case
- **L7 Q6**: Skill dependencies validation — nice-to-have, not blocking

### Worth Deciding Now
- **L3 Q9**: Should denied tools be completely removed from the LLM's tool list, or should they remain visible and return an error when called?
  - opencode removes them (cleaner, saves tokens)
  - Letting them fail gives better LLM error messages
  - **Recommendation**: Remove denied tools from LLM view (follows opencode, saves context tokens)

---

## 4. Layer Decomposition Reassessment (Step 3a)

### Decomposition Axis
The decomposition cuts along **functional capability boundaries** (REPL, Tools, Approval, Config, Session, TUI, Commands, MCP, Multi-Agent). All three reference projects organize code along similar boundaries. No alternative axis suggests itself.

### Layer Identity
Each layer represents a **coherent, distinct concept**:
- No "grab bag" layers — each has a clear problem domain
- L4 (Config) and L5 (Session) are the most independent; all others have clear dependency chains

### Granularity
- No over-splitting: no two layers are always implemented together
- No under-splitting: no layer contains unrelated concerns
- L3 (Approval & Sandbox) could theoretically split into Approval + Sandbox, but D030 defers sandboxing entirely, so they remain one layer

### Missing Concepts
No core concept discovered during research that doesn't map to an existing layer. The hook/plugin system is distributed across layers (L1 tool hooks, L7 skill system, L8 MCP) rather than being its own layer — this is correct since hooks are cross-cutting, not a standalone capability.

**Verdict: No changes to layer decomposition.** ✅

---

## 5. Layer Boundary & Structure Reassessment (Step 3b)

### Key Interfaces
- **L0↔L1**: Agent loop invokes tools via registry. Clean boundary via `ToolRegistry.get(name)` → `tool.execute(args, ctx)`.
- **L1↔L3**: Permission check via `ctx.ask()` hook in ToolContext (D016/D028). Clean boundary.
- **L1↔L8**: MCP tools converted to regular tool objects (D059). Clean boundary.
- **L1↔L9**: Task tool registered as regular tool (D062). Clean boundary.
- **L0↔L5**: Session persistence wraps the loop (D036). JSONL append on message events. Clean boundary.
- **L0↔L6**: TUI subscribes to agent events (D004). No server between them (D046). Clean boundary.
- **L4→all**: Config loaded at startup, consumed by all layers. Clean boundary via config object.

### No splits or merges needed
- All interfaces are natural
- No layer is too large or too small
- No capability spans multiple layers awkwardly

**Verdict: No changes to layer boundaries.** ✅

---

## 6. Round Grouping Reassessment (Step 3c)

Current grouping:
- Round 0: L0
- Round 1: L1 + L2
- Round 2: L3 + L4 + L5
- Round 3: L6 + L7
- Round 4: L8 + L9

This grouping worked well. Layers within each round are closely related:
- L1+L2: framework + implementations
- L3+L4+L5: cross-cutting infrastructure
- L6+L7: user-facing features
- L8+L9: extensibility

**Verdict: No changes to round grouping.** ✅

---

## 7. Layer Order Reassessment (Step 3d)

Dependencies confirmed correct:
```
L0 ← L1 ← L2
          ← L3 (approval needs tool system)
L0 ← L4 (config independent)
L0 ← L5 (session wraps loop)
L1 ← L6 (TUI renders tool results)
L1 ← L7 (commands are tool-adjacent)
L1 ← L8 (MCP tools in registry)
L1 ← L9 (task tool in registry)
     L3 ← L8 (MCP permissions)
     L3 ← L9 (sub-agent permissions)
     L5 ← L9 (child sessions)
```

D069 recommended: L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9, with L4/L5 parallelizable. This still holds.

**Verdict: No changes to layer order.** ✅

---

## 8. Outer Loop Decision: Is Cycle 2 Needed?

### Restart Criteria (restart if ANY is true)

| Criterion | Evaluation | Result |
|-----------|-----------|--------|
| Earlier research feels shallow | L0-L2 were re-researched in Cycle 1, detailed code analysis present | ❌ No |
| Cross-layer interfaces don't match | D068 confirmed consistency; L1 tool registry is the universal integration point | ❌ No |
| Decomposition needs rethinking | D067 validated; Section 4 above confirms | ❌ No |
| New reference insights would change decisions | No new projects; existing analysis is thorough | ❌ No |
| Open questions could now be answered | 9 gaps remain, but all are implementation details or minor design choices | ⚠️ Marginal |

### Stay Exited Criteria (exit if ALL are true)

| Criterion | Evaluation | Result |
|-----------|-----------|--------|
| Full cycle produced no fundamental new insights | After full review, no fundamental gaps found | ✅ Yes |
| All research files coherent end-to-end | D068 confirmed; review above confirms | ✅ Yes |
| Layer boundaries and dependencies stable | D067 confirmed; Sections 4-6 above confirm | ✅ Yes |
| Decisions consistent across all layers | D068 confirmed; no contradictions found | ✅ Yes |

### Decision

**Research has converged. Cycle 2 is NOT needed.**

The 9 remaining gaps are all implementation-level details that don't require re-researching the reference codebases. They can be resolved as new decisions (D070+) right now.

---

## 9. Remaining Gaps — New Decisions Needed

The following gaps should be resolved before moving to architecture/implementation:

1. **L3 Q9**: Denied tools — remove from LLM view or let fail?
2. **L1 Q7**: Tool execution streaming — explicit decision on how tools emit progress during execution
3. **L2 Q7**: Ripgrep dependency management — bundle, auto-download, or require system install?
4. **L4 Q6/Q7**: Config file locking and JSONC-preserving edits
5. **L7 Q6**: Skill dependency validation

These are minor and can be resolved in a single "gap-filling" pass without re-reading reference code.

---

## 10. Post-Convergence: Layer Redesign (D077)

After convergence was declared, a critical review of the layer decomposition itself revealed:

1. **L0 too fat**: Provider (LLM client) is an independent subsystem in all 3 reference projects but was lumped into L0 with the agent loop
2. **L7 conflated**: Slash commands (TUI actions) and Skills (LLM content) are different concerns with different consumers

**Redesign**: 10 → 11 layers. See `plan/layers.md` v2 and D077-D078 in `plan/decisions.md`.

This does NOT invalidate the convergence (D076). The research observations are unchanged — only the layer numbering and grouping changed. All 76 decisions remain valid.
