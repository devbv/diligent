---
name: impl-plan
description: Create detailed implementation plans for diligent project phases under plan/impl/. Use this skill whenever the user says "/impl-plan", asks to create an implementation plan, wants to plan a new phase, or mentions working on plan/impl/ files. Also use it when the user wants to break down a phase into implementable tasks or asks "what should phase N look like?"
---

# Implementation Plan Generator

Creates detailed, implementable phase plans for the diligent coding agent project. Each plan lives in `plan/impl/` and bridges the gap between research (what we know) and code (what we build).

## Context Sources

Before generating any plan, read these project files to build context:

| File | What it provides |
|------|-----------------|
| `plan/implementation-phases.md` | Phase definitions, layer-phase matrix, risk areas |
| `plan/decisions.md` | All design decisions (D001-D078+) with rationale |
| `plan/impl/phase-0-skeleton.md` | Reference plan — the format baseline to improve upon |
| `research/layers/NN-*.md` | Deep research per layer — read only layers touched by the target phase |

The layer-phase matrix in `implementation-phases.md` tells you exactly which layers a phase touches and at what depth (types, minimal, +feature, FULL). Use this to determine which research files to read.

## Workflow

### Step 1: Identify the Target

Determine which phase to plan. The user might say:
- `/impl-plan phase-1` — explicit phase number
- `/impl-plan` — ask which phase they want to plan next
- "Let's plan the next phase" — check `plan/impl/` for existing plans and suggest the next one

If unclear, ask. Don't guess.

### Step 2: Read Context

1. Read `plan/implementation-phases.md` — find the target phase section
2. Read the layer-phase matrix to identify which layers this phase touches
3. Read the relevant `research/layers/NN-*.md` files for those layers
4. Read `plan/decisions.md` — scan for decisions referenced by the target phase
5. Read existing `plan/impl/` plans for earlier phases — understand what's already built

This reading step is not optional. Implementation plans that don't account for existing research and decisions create contradictions that slow down actual development.

### Step 3: Interactive Scoping

Before writing anything, have a conversation with the user to resolve ambiguity. The goal is to reach zero assumptions before drafting.

Questions to ask (adapt based on what's already clear from context):

**Scope boundaries:**
- "Phase N touches layers X, Y, Z. Are there any parts you want to defer or prioritize?"
- "The phase matrix shows [layer] at [depth]. Does that still make sense given what Phase N-1 delivered?"

**Implementation approach:**
- "For [specific component], decisions.md says [D0XX]. Do you want to follow that exactly or has thinking evolved?"
- "Research for [layer] shows three approaches from the reference projects. Any preference?"

**Dependencies & ordering:**
- "This phase depends on [Phase N-1 artifacts]. Are those fully complete?"
- "Within this phase, what would you want working first?"

**Testing strategy:**
- "What does 'done' look like for this phase? What would you demo?"
- "Any specific edge cases you're worried about?"

Don't ask all of these mechanically. Use judgment — skip what's already obvious, dig deeper on what's ambiguous. The point is that no question should remain in the implementor's mind after reading the plan.

### Step 4: Draft the Plan

Write the plan to `plan/impl/phase-N-[name].md` using the template structure described in `references/plan-template.md`.

Read `references/plan-template.md` before writing — it contains the full template with section descriptions and the reasoning behind each section.

Key principles:
- **Every file touched gets listed.** The implementor should be able to work through the plan file-by-file without wondering "what else?"
- **Code sketches, not pseudocode.** Show actual TypeScript interfaces, function signatures, type definitions. The implementor should be able to copy-paste and fill in the body.
- **Decisions get cited inline.** When a design choice comes from decisions.md, reference it as (D0XX) right where it's used.
- **Negative scope is explicit.** "What this phase does NOT include" prevents scope creep during implementation.
- **Tasks are ordered.** The implementation tasks section gives a dependency-aware sequence — task 3 shouldn't require something from task 5.

### Step 5: Review and Iterate

After generating the draft:
1. Highlight any decisions that felt uncertain or where research was ambiguous
2. Ask the user to review — focus their attention on scope boundaries and the task ordering
3. Iterate until the plan is something an implementor could follow without asking questions

## References

### references/plan-template.md
The full plan template with section descriptions. Read this before generating any plan — it defines the output format and explains why each section exists.
