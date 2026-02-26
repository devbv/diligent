# Implementation Plan Template

This is the template for plans written to `docs/plan/impl/phase-N-[name].md`. Each section is explained below with its purpose.

---

## Template

```markdown
# Phase N: [Name]

## Goal

[1-2 sentences. What capability exists after this phase that didn't exist before? Write it as a user-visible outcome, not an internal description.]

## Prerequisites

- Phase N-1 artifact: [what must already exist]
- [any other prerequisites — specific types, interfaces, test infrastructure]

## Artifact

[What the user can demonstrate when this phase is complete. Include a concrete interaction example if applicable:]

\```
User → "example input"
Agent → [what happens step by step]
Agent → "example output"
\```

## Layer Touchpoints

[Table showing exactly which layers this phase touches and what changes. Pull from the layer-phase matrix in implementation-phases.md.]

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L0 (Provider) | minimal | Single Anthropic provider, basic streaming |
| L1 (Agent Loop) | minimal | user→LLM→tool→LLM→response loop |
| ... | ... | ... |

**Not touched:** [list layers explicitly left alone and why — e.g. "L4 (auto-approve all — permission UI requires TUI overlays from Phase 4)"]

## File Manifest

[Every file created or modified in this phase. Grouped by package/directory. The implementor works through this list.]

### packages/core/src/provider/

| File | Action | Description |
|------|--------|------------|
| `anthropic.ts` | CREATE | Anthropic SDK streaming implementation |
| `types.ts` | MODIFY | Add runtime fields to Model type |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|------------|
| `loop.ts` | CREATE | Minimal agent loop: stream → collect → tool → repeat |

### packages/cli/src/

| File | Action | Description |
|------|--------|------------|
| `index.ts` | MODIFY | Wire up readline TUI + agent loop |

[Continue for all directories touched]

## Implementation Tasks

[Ordered sequence of implementation tasks. Each task is independently testable where possible. Dependencies flow top-to-bottom — task 3 should not require something from task 5.]

### Task 1: [Name]

**Files:** `provider/anthropic.ts`, `provider/index.ts`
**Decisions:** D003, D010

[Description of what to implement. Include TypeScript code sketches — actual interfaces, function signatures, type definitions that the implementor can start from.]

\```typescript
// Code sketch — copy-paste and fill in the body
export function createAnthropicStream(
  model: Model,
  context: StreamContext,
  options: StreamOptions,
): EventStream<ProviderEvent, ProviderResult> {
  // ...
}
\```

[Call out any non-obvious design choices and reference the decision:]

> The stream function returns `EventStream<ProviderEvent, ProviderResult>` rather than a raw AsyncIterable because EventStream provides the `result()` promise for collecting the final message after iteration completes (D007).

**Verify:** [How to check this task is done — a test, a typecheck, a manual verification]

### Task 2: [Name]

[Same structure. Continue for all tasks.]

## Migration Notes

[What stubs, placeholders, or auto-behaviors from previous phases get replaced in this one.]

- `ToolContext.ask()` — was auto-approve stub, now wired to [what]
- `config` — was env-var only, now reads JSONC files

[If this is Phase 1, this section is "N/A — first implementation phase."]

## Acceptance Criteria

[Numbered list. Each criterion is binary — it either passes or fails. These become the definition of "done" for the phase.]

1. `bun install` — resolves all dependencies
2. `bun test` — all tests pass
3. [Specific functional test — e.g. "Agent can respond to a user message using Anthropic API"]
4. [Specific functional test — e.g. "Agent can execute bash tool and return output"]
5. [Integration test — e.g. "Full conversation loop: user→agent→tool→agent→user completes"]
6. No `any` type escape hatches in new code

## Testing Strategy

[More detail than just acceptance criteria. What categories of tests exist and what they cover.]

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | EventStream push/iterate/result | `bun test` with mock events |
| Unit | Provider event mapping | Feed raw SDK events, assert ProviderEvent output |
| Integration | Full agent loop | Mock provider, real tool executor, assert AgentEvents |
| Manual | End-to-end conversation | Run CLI, ask agent to list files, verify output |

## Risk Areas

[Things that might go wrong during implementation. Pull from implementation-phases.md risk table and add phase-specific risks.]

| Risk | Impact | Mitigation |
|------|--------|-----------|
| EventStream design locks in too early | Hard to change after Phase 2 builds on it | Study pi-agent's EventStream before implementing |
| [risk] | [impact] | [mitigation] |

## Decisions Referenced

[Table of all decisions cited in this plan. Serves as a quick-reference and makes it easy to verify nothing was missed.]

| ID | Summary | Where Used |
|----|---------|------------|
| D001 | Bun + TypeScript strict | Monorepo config |
| D003 | Custom provider abstraction | Provider types |
| ... | ... | ... |

## What Phase N Does NOT Include

[Explicit negative scope. Prevents scope creep during implementation. Be specific — don't just say "advanced features", name them.]

- No multi-provider support (deferred to Phase 3)
- No error retry logic (deferred to Phase 2)
- No [specific thing that might be tempting to add]
```

---

## Format Rationale

**Why Prerequisites?** Phase-0 didn't need this (it's the first phase), but every subsequent phase depends on prior artifacts. Making this explicit prevents starting a phase before its foundation is solid.

**Why File Manifest?** Phase-0 listed files within each section, but an implementor benefits from seeing the full surface area upfront. It answers "how big is this phase?" at a glance and serves as a progress checklist.

**Why Implementation Tasks (ordered)?** Phase-0 organized by conceptual area (Monorepo Structure, Dependencies, Core Type Definitions). That works for types-only phases, but implementation phases need a work order. Task N can be started after Task N-1 is verified.

**Why Migration Notes?** Progressive deepening means each phase replaces stubs from earlier phases. Without an explicit list, the implementor has to hunt through prior plans to figure out what's changing.

**Why Testing Strategy (separate from Acceptance Criteria)?** Acceptance criteria are the definition of "done." Testing strategy is how you get confidence in each task along the way. They serve different moments in the workflow — criteria at the end, strategy throughout.

**Why separate Risk Areas?** Implementation-phases.md has a risk table at the phase level, but during detailed planning, new risks emerge. Having a dedicated section ensures they're captured rather than lost in task descriptions.
