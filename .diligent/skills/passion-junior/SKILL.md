---
name: passion-junior
description: >
  Auto-progress independently executable tasks from existing GitHub Issues and open individual PRs for each.
  Claims one open issue at a time, implements it on a dedicated branch, and opens a PR linked to that issue.
  Use this skill when: the user says "passion-junior", "auto-fix review items", "fix quick wins from review",
  "run the junior fixes", or asks to automatically resolve simple tech-lead follow-up issues.
  Prefer proceeding without waiting whenever the repo context is sufficient; the user will judge via PR.
---

# Passion Junior

Execute GitHub Issues that can be progressed independently from repo context, one issue at a time, each as an individual PR.

## Workflow

### 1. Find candidate GitHub Issues

List open GitHub Issues that are suitable for autonomous implementation work.

```bash
gh issue list --state open --limit 100 --json number,title,labels,assignees
```

Prefer issues created from tech-lead output, especially issues labeled `tech-lead`.

Exclude issues that:
- already have an assignee other than yourself
- are clearly blocked on product decisions or missing external context
- are too large to complete responsibly in one focused PR
- are meta-tracking items rather than executable implementation work

If no suitable unassigned issue exists, stop and report that there is nothing actionable to claim.

### 2. Claim exactly one issue

Select the best single issue that can be completed independently, then assign it to yourself before doing implementation work.

Use `gh` to determine the current authenticated user and then self-assign the issue.

```bash
gh api user --jq .login
gh issue edit <number> --add-assignee <login>
```

After claiming, read the full issue body and any linked context before making changes.

### 3. Check for an existing PR for that issue

Before implementing, verify there is no open PR already handling the claimed issue.

```bash
gh pr list --state open --search "in:title <issue number>"
```

Also inspect likely branch names if needed. If an open PR already covers the issue, unassign yourself if appropriate, skip the issue, and report it as already in progress.

### 4. Execute the claimed issue as one PR

For the claimed issue only, sequentially:

1. Determine the branch name: `fix/passion-junior/issue-<number>-<slug>`
2. Create the branch from `main`
3. Read the target files and implement only what the issue asks for
4. Verify locally with the same checks CI runs, in order. All must pass before opening a PR:
   - `bun run lint`
   - `bun run typecheck`
   - `bun test`
5. Commit with message: `fix: <issue title>`
6. Push and open a PR with:
   - Title: `fix: <issue title> (#<number>)`
   - Body: `Closes #<number>` plus a concise implementation summary
   - Label: `passion-junior` if that label exists or can be created safely

Keep the scope tightly aligned to the issue. Do not silently expand into neighboring cleanup unless required for the fix to work.

### 5. Report results

After finishing the claimed issue, output a one-row summary table:

```
| Issue | Branch | PR | Status |
|------:|--------|----|--------|
| #123 | fix/passion-junior/issue-123-... | #456 | created |
```

## Constraints

- Never use the latest tech-lead review document as the task queue when an actionable GitHub Issue already exists
- Never modify code beyond what the claimed issue explicitly requires
- If any of `bun run lint`, `bun run typecheck`, or `bun test` fails after a fix, stop and report the issue as failed instead of opening a PR
- Do not combine multiple issues into one PR
- Each branch must be based on the latest main
- If the issue is ambiguous, use repository context and linked issue discussion to choose the best responsible implementation
- Prefer the best implementation supported by the issue and repository context, then let the user judge via PR
