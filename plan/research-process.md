# Diligent Research Process Plan

## What Is This

This is NOT an implementation plan. It is a **process plan for how to conduct iterative research**.

## Research Loop

```
┌─→ 1. Define/reorder layer sequence
│      ↓
│   2. Deep research per layer (3 projects) → write to file
│      ↓
│   3. Synthesis review → reassess layer order → identify open questions
│      ↓
└── If new insights change the order or split layers → back to 1
    Otherwise → proceed to implementation
```

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

### Research Execution Method

- Deploy Explore agents **one per layer, one per project** or **one per layer in parallel**
- Give each agent specific question lists and target directories
- Collect results and organize into research files

## Step 3: Synthesis Review

Performed after each round of research:

### 3a. Cross-Layer Analysis
- Are the **interface boundaries** between researched layers natural?
- Should a layer be **split** if it's too large?
- Should two layers be **merged** if they're essentially one?

### 3b. Layer Order Reassessment
- Are there newly discovered dependencies from research results?
- Should the order change?
- Is a new layer needed?

### 3c. Open Questions Consolidation
- Collect open questions from each layer's research
- Classify: resolve in next round vs. defer until implementation

### 3d. Decision Recording
- Record decisions and rationale from synthesis in `plan/decisions.md`
- Update `plan/layers.md` if layer order changes

### Loop Exit Conditions
- All layers researched
- Layer order stabilized (no more reordering needed)
- Remaining open questions are all "things we'll learn during implementation"

## Round Plan

| Round | Target Layers | Status |
|---|---|---|
| 0 | L0 (REPL Loop) | Complete (prior session) |
| 1 | L1 (Tool System) + L2 (Core Tools) | Next |
| 2 | L3 (Approval) + L4 (Config) + L5 (Session) | Waiting |
| 3 | L6 (TUI) + L7 (Commands) + L8 (MCP) + L9 (Multi-Agent) | Waiting |

**Step 3 (synthesis review) is performed between every round.**

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
