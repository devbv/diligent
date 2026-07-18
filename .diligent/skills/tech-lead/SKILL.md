---
name: tech-lead
description: Review Diligent's current architecture and recent change range for evidence-backed risks to correctness, ownership, delivery speed, and future evolution. Use for full or scoped tech-lead reviews, architecture sustainability checks, project health assessments, recurring 50-commit reviews, or questions about whether the repository can keep changing safely. Produces a review artifact and, only when explicitly requested, a small set of implementation-ready GitHub Issues.
---

# Tech Lead Review

Answer one question: **Can Diligent keep changing safely and quickly without compounding structural or operational risk?**

Review the repository that exists now. Do not reward novelty, volume, or architectural sophistication. A short review with no new actions is better than speculative work.

## Operating Modes

- **Cadenced review:** Review the range from the last recorded checkpoint to `HEAD`. The GitHub workflow normally invokes this after 50 commits.
- **Scoped review:** Go deep on the requested package, feature, incident, or proposal and inspect only the dependent contracts needed to judge it.

For either mode, keep unrelated local changes untouched.

## Source Priority

Use sources in this order:

1. Current implementation and tests
2. `ARCHITECTURE.md` and current guides in `docs/guide/`
3. Durable decisions in `docs/plan/decisions.md`
4. Active plans relevant to the reviewed range
5. Previous reviews and session/corpus evidence

Previous reviews are hypotheses to re-check, not inherited truth. Plans are not evidence that behavior is implemented.

Follow `AGENTS.md` for repository navigation. Use `@summary` annotations and `rg` to route by need. Do not copy a fixed package tour into every review.

## Establish the Review Range

1. Record `HEAD` and the worktree state.
2. Find the latest relevant review in `docs/review/`.
3. Resolve its reviewed commit from the filename or header and verify that it is a valid ancestor.
4. For a cadenced review, inspect `<previous>..HEAD`.
5. For a scoped review, use the user-specified range when present; otherwise use the latest relevant checkpoint.
6. Read up to three recent relevant reviews only after establishing the current range.

Useful commands:

```bash
git status --short
git rev-parse --short HEAD
git log --oneline <previous>..HEAD
git diff --stat <previous>..HEAD
git diff --name-status <previous>..HEAD
```

If the checkpoint cannot be resolved, state the fallback range explicitly. Do not silently review an arbitrary history window.

## Explore by Change Surface

Start with:

- `AGENTS.md`
- `README.md`
- `ARCHITECTURE.md`
- changed files and commits in the review range
- plans or decisions directly referenced by those changes

Then follow dependencies outward only where they affect:

- ownership or package boundaries
- shared protocol and type flow
- persistence, replay, or lifecycle semantics
- provider, tool, plugin, or client extension points
- Web/TUI parity for user-facing behavior
- verification coverage for the changed contract

Do not inspect every package by default. A broad but shallow inventory is not a full review.

## Evidence Discipline

Label reasoning internally as fact, inference, or hypothesis. Publish only conclusions whose confidence is clear.

Every actionable finding must establish all of the following:

1. **Current evidence:** Exact code, test, commit, or reproducible behavior on current `HEAD`.
2. **Impact:** A concrete user, contributor, reliability, or delivery consequence.
3. **Mechanism:** How the evidence causes the claimed impact.
4. **Bounded response:** The smallest responsible change or decision.
5. **Why now:** Evidence that waiting will compound cost or leave an active defect.

An actionable finding must have High confidence. If one of the requirements is missing or confidence is only Medium, keep the item as an observation or watch condition. Do not turn it into an actionable finding or GitHub Issue.

Treat each actionable finding as the complete unit of review and delivery. A reader must not need to join a finding with a separate action list or issue-mapping section to understand what is wrong, why it matters, what is in scope, and how completion will be verified.

Apply these safeguards:

- Verify line references against current `HEAD`.
- Search current code, open issues, open PRs, and recent commits before calling something unresolved.
- Do not infer causality from frequency counts or session correlation alone.
- Distinguish a missing carrier from a missing producer or consumer; preserving data does not by itself change model or UI behavior.
- Do not propose a shared abstraction without at least two concrete consumers with matching semantics.
- Do not propose a status taxonomy, protocol field, or registry merely because it could be useful later.
- Treat file size, option counts, casts, and duplication as routing signals, not findings by themselves.
- Prefer characterization tests before behavior-preserving refactors.

## Verification During Review

Use read-only inspection first. Run a focused test, typecheck, or small reproduction only when it materially raises or lowers confidence in a finding.

- Do not run the full validation suite merely to prove the repository is green.
- Do not modify production code while performing the review.
- Record any diagnostic command that changes the verdict or finding confidence.
- If verification requires unavailable credentials, services, or user data, state the limitation and lower confidence instead of filling the gap with assumptions.

## Assessment Lenses

Use only the lenses relevant to the reviewed range.

### Ownership and Structural Integrity

- Does current code match documented ownership?
- Are new changes entering through intended extension points?
- Are adapters local, or are clients/providers learning each other's internals?
- Did a recent refactor remove a risk rather than merely move it?

### Change Friction

- Do recent changes repeatedly touch unrelated packages for one behavior?
- Is rework converging on a stable boundary or revisiting the same decision?
- Are commits coherent even when large?
- Is planning clarifying delivery or substituting for it?

### Contract Coherence

- Is there one clear owner for cross-package data and lifecycle semantics?
- Do protocol, persistence, provider conversion, Web, and TUI preserve the same meaning?
- Are external plugin contracts intentionally different from internal contracts?

### Operational Correctness

- Can success, failure, partial application, retry, replay, and readback be distinguished where behavior consumes them?
- Are multi-stage mutations represented as multiple stages rather than one misleading boolean?
- Do tests cover the contract boundary instead of only implementation details?

### Forward Pressure

- Name the concrete next capability or scale increase that would stress the current design.
- If no likely trigger exists, keep the concern on a watchlist rather than prescribing work.

## Write the Review

Write the result under:

```text
docs/review/YYYY-MM-DD-<short-head>[-<scope>].md
```

Do not overwrite an unrelated review from the same day. Use a scope suffix when needed.

Keep the document proportional to the evidence. Use this compact structure:

```markdown
# Tech Lead Review — YYYY-MM-DD (short-head)

**Scope**: ...
**Commit range**: ...
**Inspected**: ...

## Verdict
**GREEN | YELLOW | RED** — ...

## Previous Review Delta
- Resolved / still active / disproven / outside scope

## Findings
### F-01 — Finding title
**Disposition**: Act now
**Lens**: Ownership | Change friction | Contract | Operational correctness | Forward pressure
**Confidence**: High
**Evidence**: ...
**Impact and mechanism**: ...
**Smallest responsible action**: ...
**Scope and non-goals**: ...
**Verification**: ...
**Why now**: ...
**Delivery**: Created issue #123 | Reused issue #123 | Not requested

## Watchlist
- Lower-confidence or trigger-dependent observations
```

Publish zero to three actionable findings, ordered by value and dependency. Omit empty `Findings` or `Watchlist` sections; a GREEN verdict with no actionable findings is valid. Keep lower-confidence or trigger-dependent concerns in `Watchlist` rather than partially filling the finding template. Do not add a separate Priority Actions or GitHub Issues section: the action and delivery status belong to the finding. Do not add a mandatory novel perspective, rejected-candidate catalog, package-by-package section, or persistent issue merely to fill a template.

## Register GitHub Issues Only When Authorized

Create or update GitHub Issues only when the user or automation prompt explicitly requests issue registration. The repository tech-lead workflow prompt is an explicit request, whether triggered by the schedule or `workflow_dispatch`. An interactive or otherwise manually invoked review does not authorize issue registration unless the request says so.

Before creating an issue:

1. Re-check the finding on current `HEAD`.
2. Search open issues and PRs for the same cause and intended action.
3. Confirm the action is independently executable without a missing product or architecture decision.
4. Confirm the review contains high-confidence evidence, mechanism, and acceptance criteria.

Create at most three issues per review. Creating none is a successful outcome. Create or reuse exactly one issue per actionable finding; never combine independent findings into an umbrella issue and never split one finding into multiple issues during the review.

Each issue must include:

- the review finding ID and title
- action-oriented title
- review path and commit range
- current code evidence
- causal impact, without overstating corpus/session correlation
- bounded scope and explicit non-goals
- test or verification expectations
- completion criteria observable in code or behavior

The issue body must be independently readable without opening the review. Mirror the finding's evidence, impact and mechanism, action, scope and non-goals, verification, and why-now rationale. After creating or reusing the issue, record the issue number and link in that finding's `Delivery` field.

Use this issue body structure:

```markdown
## Source
- Review: `docs/review/...`
- Finding: `F-01 — ...`
- Commit range: `...`

## Evidence
...

## Impact and mechanism
...

## Scope
...

## Non-goals
- ...

## Verification
- ...

## Why now
...
```

Reuse an equivalent open issue. Do not create issues for:

- already-fixed behavior
- bookkeeping or closing old review items
- speculative future abstractions
- symptoms that share no proven cause
- refactoring justified only by size or aesthetics
- findings that require a product decision before implementation

Use the `tech-lead` label when available. Record issue numbers in the review after successful creation.

## Review Principles

- Correctness and sustainable change are coupled; do not optimize one away.
- Current code beats historical narrative.
- Evidence beats novelty.
- A precise watch condition beats a premature abstraction.
- Removing a stale concern is as valuable as finding a new one.
- Recommendations must fit a focused solo-developer and AI-assisted workflow.
- The review is an analysis artifact, not an automatic implementation mandate.
