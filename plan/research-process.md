# Diligent Research Process Plan

## What Is This

This is NOT an implementation plan. It is a **process plan for how to conduct iterative research**.

## Research Loop

Two nested loops: an **inner loop** (per-round iteration) and an **outer loop** (full restart from Round 0).

```
OUTER LOOP (Cycle N):
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   INNER LOOP (per-round):                               │
│   ┌─→ 1. Define/reorder layer sequence                  │
│   │      ↓                                              │
│   │   2. Deep research per layer (3 projects) → file    │
│   │      ↓                                              │
│   │   3. Synthesis review → reassess layers             │
│   │      ↓                                              │
│   └── If layers change → back to 1                      │
│       If more rounds remain → next round                │
│       If all rounds done → Full Review Pass (3g)        │
│                                                         │
│   Full Review Pass (3g)                                 │
│      ↓                                                  │
│   Evaluate: has understanding fundamentally deepened?   │
│      ↓                                                  │
└──── YES → restart from Round 0 (Cycle N+1)              │
      NO  → research stabilized, exit loop                │
──────────────────────────────────────────────────────────┘
```

**Why restart?** Later rounds (L6-L9) provide context that didn't exist when earlier rounds (L0-L2) were researched. Each full cycle produces deeper, more coherent research. The loop exits only when a full cycle produces no fundamental new insights — i.e., the understanding has converged.

**Cycle history is tracked** in the Round Plan table. Each restart overwrites research files with improved versions. The decisions log grows monotonically (new decisions added, old ones refined).

## Step 1: Layer Sequence Definition

**Initial Layer List (Hypothesis)**

Decomposition of a coding agent's capabilities. The order may change, layers may merge, or new layers may emerge through research.

- L0: REPL Loop (basic conversation)
- L1: Tool System (tool invocation framework)
- L2: Core Tools (read/write/edit/bash)
- L3: Approval & Sandbox
- L4: Config System
- L5: Session & Persistence
- L6: TUI
- L7: Slash Commands & Skills
- L8: MCP
- L9: Multi-Agent

This list is **reviewed at every loop iteration**.

**Layer sequence document:** `plan/layers.md`
- Current layer list and order
- One-line definition per layer
- Inter-layer dependencies
- Change history (why it changed)

## Step 2: Per-Layer Deep Research

**Proceeds in rounds.** Each round researches 2–3 layers.

### Research Targets

Analyze each layer's implementation across 3 projects:
- **codex-rs** — `research/references/codex-rs/`
- **pi-agent** — `research/references/pi-agent/`
- **opencode** — `research/references/opencode/`

### Research Questions (common to every layer)

1. **Problem definition**: What problem does this layer solve?
2. **Minimal implementation**: What is the simplest possible form?
3. **Each project's approach**: What patterns/structures are used?
4. **Key types/interfaces**: What abstractions were created?
5. **Layer boundaries**: How does it interface with layers above/below?
6. **Trade-offs**: Pros and cons of each approach?
7. **Open questions**: What remains undecided?

### Research Output

File location: `research/layers/NN-layer-name.md`

Each file's structure:
```
# Layer N: [Name]
## Key Questions
## codex-rs Analysis
## pi-agent Analysis
## opencode Analysis
## Comparison Table
## Open Questions
```

**NOTE: No design decisions for diligent are made in this step.** Pure observation and analysis only.

### Research Execution Method — Agent Hierarchy

Token management is critical. A single agent cannot hold all rounds of research in context. Use a **hierarchical agent structure** to isolate each round's context:

```
Main Agent (persistent session, thin — orchestration only)
  │
  ├─ Round N Coordinator (Task subagent, one per round)
  │    │  - Reads: research-process.md, layers.md, previous round's research files
  │    │  - Writes: research files, updates to layers.md, decisions.md
  │    │
  │    ├─ Research Agent: Layer X × codex-rs    (Explore subagent)
  │    ├─ Research Agent: Layer X × pi-agent    (Explore subagent)
  │    ├─ Research Agent: Layer X × opencode    (Explore subagent)
  │    ├─ Research Agent: Layer Y × codex-rs    (Explore subagent)
  │    └─ ...
  │
  ├─ Round N+1 Coordinator (separate Task subagent, fresh context)
  │    └─ ...
  └─ ...
```

**Rules:**
1. **Main agent stays thin** — only dispatches rounds, reads results, commits. Never does research directly.
2. **Round Coordinator is a Task subagent** — gets a fresh context per round. Responsible for:
   - Reading prior round outputs (from files, not from main agent's memory)
   - Spawning Explore agents for each (layer × project) combination
   - Collecting results → writing research files
   - Running synthesis review (Step 3)
3. **Research Agents are Explore subagents** — spawned by the coordinator, one per (layer × project). Each gets:
   - Specific question list from Step 2
   - Target directory path (e.g., `research/references/codex-rs/`)
   - Reference structure guide (`research/references/README.md`)
4. **All context transfer happens through files** — not through agent memory. This is what makes the hierarchy work across token limits.
5. **Parallelism**: Research agents within a round run in parallel. Rounds run sequentially.

## Step 3: Synthesis Review

Performed after each round of research:

### 3a. Layer Decomposition Review

Challenge the decomposition itself, not just the ordering:

- **Decomposition axis**: Are we cutting along the right dimension? (functional, data flow, lifecycle, etc.) Do the reference projects suggest a fundamentally different decomposition?
- **Layer identity**: Does each layer represent a **coherent, distinct concept**? Or are some layers just "grab bags" of loosely related features?
- **Granularity**: Are we over-splitting (things that are always implemented together) or under-splitting (layers that contain unrelated concerns)?
- **Classification fit**: Are there capabilities that don't belong in their current layer, or that span multiple layers awkwardly?
- **Missing concepts**: Did research reveal a core concept that doesn't map to any existing layer?

If the decomposition itself needs rethinking, **redefine the layer list before continuing to the next round.** This is more important than order changes.

### 3b. Layer Boundary & Structure
- Are the **interface boundaries** between researched layers natural?
- Should a layer be **split** if it's too large?
- Should two layers be **merged** if they're essentially one?
- Is a **new layer** needed for something that doesn't fit anywhere?

### 3c. Round Grouping Review
- Are the **layers grouped in the right rounds**? Layers in the same round should be closely related or benefit from being researched together.
- Should a layer be **moved to an earlier round** because it turned out to be a prerequisite for understanding other layers?
- Should a layer be **moved to a later round** because it depends on layers not yet researched?
- Is a round **too large** (too many layers to research coherently) or **too small** (layers that make more sense researched alongside others)?

Update the Round Plan table if grouping changes.

### 3d. Layer Order Reassessment
- Are there newly discovered dependencies from research results?
- Should the order change?

### 3e. Open Questions Consolidation
- Collect open questions from each layer's research
- Classify: resolve in next round vs. defer until implementation

### 3f. Decision Recording
- Record decisions and rationale from synthesis in `plan/decisions.md`
- Update `plan/layers.md` if layer order changes

### 3g. Full Review Pass (after all rounds complete)

After the last round's synthesis, perform a **complete review from L0 through the final layer**:

1. **Re-read all research files** in layer order — earlier research was written without knowledge of later layers
2. **Cross-layer consistency check** — do early layer analyses still hold given what we learned later?
3. **Update earlier research files** if new insights from later rounds change the picture
4. **Final layer order validation** — confirm the full dependency graph makes sense end-to-end
5. **Consolidated open questions** — single list across all layers, classified as "resolve before implementation" vs "resolve during implementation"

This is NOT optional. Research done in Round 0 was conducted without context from Rounds 1–3. The full review ensures coherence across the entire layer stack.

### Outer Loop Restart Criteria

After Full Review Pass (3g), evaluate whether to restart from Round 0:

**Restart (new cycle) if ANY of these are true:**
- Earlier research files feel shallow or miss patterns that later rounds revealed
- Cross-layer interfaces described in early rounds don't match what later rounds discovered
- The decomposition itself (layer boundaries, what belongs where) needs rethinking
- New reference project insights would change fundamental decisions
- Open questions from early rounds could now be answered with accumulated knowledge

**Stay exited (research converged) if ALL of these are true:**
- A full cycle (Round 0 through 3g) produced no fundamental new insights
- All research files are coherent when read end-to-end
- Layer boundaries and dependencies are stable
- Decisions are consistent across all layers

## Round Plan

**Step 3 (synthesis review) is performed between every round.**

### Cycle 1 (2026-02-23)

| Round | Target Layers | Status |
|---|---|---|
| 0 | L0 (REPL Loop) | Complete (re-researched 2026-02-23) |
| 1 | L1 (Tool System) + L2 (Core Tools) | Complete (re-researched 2026-02-23) |
| 2 | L3 (Approval) + L4 (Config) + L5 (Session) | Complete (2026-02-23) |
| 3 | L6 (TUI) + L7 (Slash Commands & Skills) | Complete (2026-02-23) |
| 4 | L8 (MCP) + L9 (Multi-Agent) | Complete (2026-02-23) |
| — | Full Review Pass (Step 3g) | Complete (2026-02-23) |

69 decisions recorded (D001-D069). Full review pass completed.

### Cycle 1 Outer Loop Evaluation (2026-02-23)

Full evaluation documented in `plan/cycle1-review.md`.

- Open questions audit: 103 total across 10 layers, 94 resolved by D001-D069, 9 remaining gaps
- Gap-filling decisions: D070-D076 resolve all remaining gaps
- Layer decomposition: validated, no changes needed
- Layer boundaries: stable, no splits/merges needed
- Round grouping: confirmed correct
- Layer order: confirmed correct

**Outer loop exit criteria: ALL MET → Research converged (D076). No Cycle 2 needed.**

76 decisions recorded (D001-D076).

**STATUS: RESEARCH COMPLETE. Ready to proceed to architecture design (`plan/architecture.md`).**

### Round Completion Checklist

Each round must end with:
1. **Git commit** — commit all research output from the round (research files, layer updates, decision log changes)
2. Move to next round only after commit is confirmed

## Full Output List

```
plan/
├── research-process.md    # This file — master process document
├── layers.md              # Layer list, order, dependencies (living document)
├── decisions.md           # Decision log from synthesis reviews
├── architecture.md        # Finalized architecture (after research completes)
├── layer-0-*.md           # (existing) L0 implementation plan
├── layer-1-*.md           # L1 implementation plan (after research)
└── ...

research/
├── layers/
│   ├── 00-repl-loop.md    # L0 research (observation/analysis only)
│   ├── 01-tool-system.md
│   └── ...
└── references/
    ├── README.md           # Reference project structure guide (see below)
    ├── codex-rs/
    ├── pi-agent/
    └── opencode/
```

## Reference Project Structure Guide

Maintained in `research/references/README.md`. This document helps new researchers quickly orient themselves in each reference project's codebase.

For each project, document:

```
## [Project Name]
- **Language/Runtime**: e.g., Rust, TypeScript/Bun, Go
- **Repo root layout**: top-level directory overview
- **Key entry points**: where execution starts (main, CLI entry)
- **Core module map**: which directories/files correspond to which agent capabilities
  - e.g., tool system → `src/tools/`, config → `src/config.rs`
- **Notable patterns**: architectural patterns the project uses (e.g., message passing, trait-based dispatch)
- **Tips for code reading**: gotchas, macro-heavy areas, generated code, etc.
```

This guide should be **updated incrementally** as each round of research reveals more about the projects. It is not meant to be exhaustive upfront — it grows with the research.

## Cross-Session Persistence

This research process spans multiple sessions. To ensure continuity:

1. **This plan is saved as `plan/research-process.md`** — master process document
2. **CLAUDE.md references the research process** — instant context in new sessions
3. **`plan/layers.md` records current progress** — which round is done, what's next
4. **Each research file is self-contained** — understandable without cross-references
