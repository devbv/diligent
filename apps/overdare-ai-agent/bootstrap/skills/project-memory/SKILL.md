---
name: project-memory
description: "Use at the beginning or end of meaningful OVERDARE Studio work, when the user asks to remember decisions/plans, when resuming a project, or when creating/updating project docs. Maintains the handoff between Knowledge entries, docs, and the actual Studio world."
---

# Project Memory Skill

This skill keeps OVERDARE Studio work continuous across sessions by coordinating three sources of truth:

- **Studio world**: the current implemented reality.
- **Knowledge Tool**: short handoff cards used to resume work quickly.
- **Project docs**: longer human-readable design, planning, and decision records.

Do not use Knowledge as a long document store. Do not use docs as the only source of session resume state.

## When to Use

Use this skill when:

- A new session starts and you need to understand the current project.
- The user says to remember a plan, decision, concept, or direction.
- The user asks to continue previous work.
- A meaningful design or technical decision is made.
- A milestone, next step, or implementation structure changes.
- You create or update project docs.

Do not use this skill for trivial edits, temporary debugging, small value tweaks, or ideas the user has not confirmed.

## Core Rule

Docs hold the full explanation. Knowledge holds the current resume summary and links to those docs.

If information is long, debated, historical, or reviewable by people, put it in docs and store only a short pointer in Knowledge.

If information directly changes what the agent should do next session, keep a short active summary in Knowledge.

## What Belongs in Knowledge

Use Knowledge for compact, current, action-oriented handoff cards:

- `OVERDARE_PROJECT_BRIEF`: current game concept, genre, core loop, current goal.
- `OVERDARE_DOC_INDEX`: important docs paths for this project.
- `OVERDARE_CURRENT_PLAN`: current milestone and next steps.
- `OVERDARE_DECISION`: active or superseded decisions, with a docs pointer when available.
- `OVERDARE_IMPLEMENTATION_MAP`: important Studio paths and constraints.
- `OVERDARE_USER_PREFERENCE`: one durable project-specific user preference per entry.

Keep entries short. Prefer updating existing entries over adding near-duplicates.

Each Knowledge entry must stay under 1,000 characters. If details would exceed 1,000 characters, move them into project docs and keep only a short summary, status, and docs link in Knowledge.

For recurring OVERDARE handoff cards, use stable Knowledge ids so updates replace the same entry instead of creating duplicates:

- `overdare.project_brief`
- `overdare.doc_index`
- `overdare.current_plan`
- `overdare.implementation_map`
- `overdare.preference.<short_topic>` for each durable user preference
- `overdare.decision.<short_topic>` for each decision

When looking up singleton entries, use the stable id when known. For groups, use `id_prefix` such as `overdare.decision.` or `overdare.preference.`. Otherwise search by query text, tags, and content markers such as `[OVERDARE_IMPLEMENTATION_MAP]`.

## What Belongs in Docs

Use project-local docs for information that should be read, reviewed, or preserved in detail. Project docs live under the current project working directory (`{{cwd}}`):

- Game overview and core loop.
- Feature and system design.
- Milestone plans and acceptance criteria.
- Architecture Decision Records (ADRs).
- Brainstorming notes and meeting notes.
- Detailed implementation notes that are too long for Knowledge.

Recommended project-local docs layout:

```text
<project cwd>/docs/
  README.md
  design/
    game-overview.md
    core-loop.md
    combat-system.md
    ui-ux.md
  decisions/
    0001-example-decision.md
  milestones/
    001-current-milestone.md
  notes/
    YYYY-MM-DD-topic.md
```

## Project Docs Location

Always treat docs paths in this skill as relative to the current project working directory.

- Correct: `<project cwd>/docs/design/game-overview.md`
- Correct Knowledge pointer: `docs/design/game-overview.md`

If the current project does not have a `docs/` directory yet, create it in the project working directory only when the user asks for durable planning/design records or when meaningful decisions/plans need a docs home.

## Session Start Harness

At the beginning of a new session or when the user asks to continue:

1. Search Knowledge for OVERDARE project memory entries by stable id, `id_prefix`, query text, tags, or content markers.
2. Spawn exactly one `studio-explorer` sub-agent if it has not already been spawned this session, and include any useful project memory or docs pointers in the request.
3. Let `studio-explorer` read relevant project docs when useful while inspecting Studio.
4. Compare the handoff context with the actual Studio world.
5. Tell the user a short resume summary before making implementation decisions:
   - remembered project direction,
   - current milestone or next step,
   - relevant Studio reality,
   - any mismatch or unknown.

If Knowledge and Studio disagree, treat Studio as the implemented reality and Knowledge/docs as intent. Ask a concise clarifying question only when the mismatch changes the next action.

## Work Completion Harness

After meaningful work or when stopping with unfinished work:

1. Update docs if detailed design, planning, milestone criteria, or decision rationale changed.
2. Update Knowledge if the next session needs the changed information.
3. Prefer updating `OVERDARE_CURRENT_PLAN`, `OVERDARE_IMPLEMENTATION_MAP`, or existing decisions instead of adding new duplicate entries.
4. Mark outdated decisions as `superseded`; do not silently leave conflicting active decisions.
5. Do not record temporary debug state, unconfirmed ideas, or minor cosmetic tweaks.

## Knowledge Entry Templates

Use concise content like these examples.

### Project Brief

```text
id: overdare.project_brief
[OVERDARE_PROJECT_BRIEF]
title: <project title or unknown>
genre: <genre>
core_loop: <short loop>
current_goal: <current goal>
doc: docs/design/game-overview.md
last_updated: YYYY-MM-DD
```

### Doc Index

```text
id: overdare.doc_index
[OVERDARE_DOC_INDEX]
overview: docs/design/game-overview.md
current_milestone: docs/milestones/001-current-milestone.md
active_design_docs:
- docs/design/<feature>.md
active_decisions:
- docs/decisions/0001-<decision>.md
```

### Current Plan

```text
id: overdare.current_plan
[OVERDARE_CURRENT_PLAN]
milestone: <milestone name>
doc: docs/milestones/001-current-milestone.md
done:
- <completed meaningful item>
remaining:
- <next step>
blocked_by: <none or blocker>
```

### Decision

```text
id: overdare.decision.<short_topic>
[OVERDARE_DECISION]
title: <decision title>
status: active | superseded | rejected | uncertain
summary: <one sentence>
reason: <short reason>
affects:
- <Studio path or system>
doc: docs/decisions/0001-<decision>.md
```

### User Preference

```text
id: overdare.preference.<short_topic>
[OVERDARE_USER_PREFERENCE]
prefers: <durable preference>
reason: <short reason, if useful>
```

### Implementation Map

```text
id: overdare.implementation_map
[OVERDARE_IMPLEMENTATION_MAP]
important_paths:
- <Studio path>: <purpose>
constraints:
- <important constraint>
last_verified: YYYY-MM-DD
```

## Docs Templates

When creating docs, start from these structures.

### Design Doc

```md
# <Feature or Game Name>

## Purpose

## Player Experience

## Current Scope

## Rules and Behavior

## Related Studio Structure

## Open Questions
```

### Decision Record

```md
# 0001. <Decision Title>

## Status
Accepted

## Context

## Decision

## Alternatives Considered

## Consequences
```

### Milestone Doc

```md
# 001. <Milestone Name>

## Goal

## Done

## Remaining

## Acceptance Criteria

## Out of Scope
```

## Final Response Pattern

When you update memory or docs, briefly tell the user what changed:

```text
I updated the project handoff:
- Knowledge: current plan and implementation map
- Docs: docs/design/combat-system.md
- Next session can resume from: HP UI connection
```

