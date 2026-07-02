---
name: record-project-memory
description: "Use to RECORD durable OVERDARE Studio project memory — when the user confirms a decision, plan, preference, or milestone worth carrying to a future session, or explicitly asks to remember something. Do NOT use it to look things up, to resume or understand a project, or for single-shot fixes, debugging, UI tweaks, or balance changes that are solvable from the current code/world."
---

# Record Project Memory Skill

This skill **records** durable OVERDARE Studio project memory into two stores:

- **Knowledge**: short, current handoff cards for fast resume.
- **Project docs**: longer human-readable design, planning, and decision records.

Record only what a future session would otherwise lose: confirmed decisions, plans, milestones, and durable preferences. Never copy what is already visible in the current Studio world, scripts, instances, or logs — that is re-readable state, not memory.

## Core Rule

Docs hold the full explanation. Knowledge holds the current resume summary and links to those docs.

If information is long, debated, historical, or reviewable by people, put it in docs and store only a short pointer in Knowledge.

If information directly changes what the agent should do next session, keep a short active summary in Knowledge.

## What Belongs in Knowledge

Use Knowledge for compact, current, action-oriented handoff cards. For each recurring card, use a stable id so updates replace the same entry instead of creating duplicates:

- `overdare.project_brief` — `OVERDARE_PROJECT_BRIEF`: current game concept, genre, core loop, current goal.
- `overdare.doc_index` — `OVERDARE_DOC_INDEX`: important docs paths for this project.
- `overdare.current_plan` — `OVERDARE_CURRENT_PLAN`: current milestone and next steps.
- `overdare.implementation_map` — `OVERDARE_IMPLEMENTATION_MAP`: important Studio paths and constraints.
- `overdare.decision.<short_topic>` — `OVERDARE_DECISION`: one decision per entry, with a docs pointer when available.
- `overdare.preference.<short_topic>` — `OVERDARE_USER_PREFERENCE`: one durable project preference per entry.

When calling `update_knowledge`, always store these cards with `type: "discovery"` and the card's stable `id`. The `OVERDARE_*` marker and its fields go in `content`. (`type` is only a display label — retrieval and grouping rely on the stable `id` and the `OVERDARE_*` marker, not on `type`.)

Keep entries short. Prefer updating an existing entry over adding a near-duplicate. Each entry must stay under 1,000 characters; if details would exceed that, move them into project docs and keep only a short summary, status, and docs link in Knowledge.

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

If the current project does not have a `docs/` directory yet, create it in the project working directory only when durable planning/design records or meaningful decisions/plans need a docs home.

## Recording Harness

When you record durable information:

1. Prefer updating `OVERDARE_CURRENT_PLAN`, `OVERDARE_IMPLEMENTATION_MAP`, or an existing decision over adding a new duplicate entry.
2. Put long, reviewable detail in docs; keep a short active summary plus a docs pointer in Knowledge.
3. Mark outdated decisions as `superseded`; never leave conflicting active decisions.
4. Do not record temporary debug state, unconfirmed ideas, or minor cosmetic tweaks.
5. If, after finishing work, there is nothing durable to record, record nothing and say so. Do not create filler entries.

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

When you record memory or docs, briefly tell the user what changed:

```text
I updated the project handoff:
- Knowledge: current plan and implementation map
- Docs: docs/design/combat-system.md
- Next session can resume from: HP UI connection
```
