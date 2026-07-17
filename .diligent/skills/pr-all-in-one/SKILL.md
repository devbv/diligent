---
name: pr-all-in-one
description: Prepare or update a Diligent pull request from the current work, preserving user intent, decision context, verification logs, and useful review notes. Use when the user invokes pr-all-in-one, asks to open a PR, update an existing PR, prepare PR text, or wants a Korean-friendly PR workflow for this repository.
---

# PR All In One

Create or update a Diligent pull request while preserving why the work exists, what decisions were made, and what verification was run.

This is not a review-resolution automation. Diligent does not yet rely on heavy GitHub review-thread workflows, so prioritize clear PR context, command logs, risks, and follow-up notes over resolving comments or requesting re-review.

## Core Principles

- Capture intent before git operations: original user request, problem trigger, goals, and key decisions from the conversation.
- Keep repository files English-only, but write the PR body in Korean when the user asks or the conversation is Korean.
- Use the repository's title format for PR titles and commits: `type(scope): summary`.
- Allowed title types are `feat`, `fix`, `refactor`, `test`, `docs`, and `chore`.
- Do not auto-commit unrelated or ambiguous local changes. Ask when scope ownership is unclear.
- Preserve existing PR body context, screenshots, recordings, uploaded artifacts, and useful verification history when updating an open PR.
- Never delete existing content in the PR's screenshots/recordings section when updating a PR. Preserve it verbatim unless the user explicitly asks to remove it.
- When the PR body is written in Korean, run the finished draft through `humanize-korean` exactly once before creating or updating the PR.
- Do not add AI signatures, generated-by footers, or co-author trailers unless the user explicitly asks.

## Branch Naming

Use the branch style already visible in this repository's open PRs. Do not use agent-specific prefixes such as `codex/` for PR branches.

Preferred patterns:

- Normal feature work: `feat/<short-slug>`, for example `feat/web-asset-preview`.
- Bug fixes: `fix/<short-slug>`.
- Refactors: `refactor/<short-slug>`.
- Documentation or process work: `docs/<short-slug>`.
- Provider/model support work may use a concise support branch when that is the existing project pattern, for example `support-glm-5-2`.

If the current branch uses an agent-specific prefix and the work is not pushed yet, rename it before opening the PR.

## Inputs

Accept optional free-form arguments after invocation:

- Target branch: `main`, `develop`, `release/...`, or any existing branch name.
- Mode hints: `draft`, `ready`, `body-only`, `update-existing`, or `no-push`.

Default target branch:

1. If an open PR exists for the current branch, use its `baseRefName`.
2. Otherwise use `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
3. If GitHub metadata is unavailable, fall back to `main`.

## Workflow

### 1. Capture PR Context First

Before running git commands, summarize the current conversation into working notes:

- Background and intent: why the work started and what the user wanted to achieve.
- Decisions: approach choices, trade-offs, rejected alternatives, and scope changes.
- Implementation notes: high-level areas changed, not every line touched.
- Verification expectations: checks the user requested or constraints they mentioned.
- Follow-up context: known risks, skipped work, blockers, or TODOs.

If there is no useful conversation context, do not invent generic motivation. Rely on commits and diffs.

### 2. Inspect Repository State

Run:

```bash
git status --short --branch
git branch --show-current
git remote -v
```

If the current worktree is dirty:

- Use `git diff`, `git diff --cached`, and `git status --short` to classify changes.
- Commit only changes that clearly belong to the user's requested work.
- If unrelated changes exist, leave them untouched and ask for direction before staging.
- If the user asked to use a separate worktree, or the main worktree is busy, create a dedicated worktree and branch before editing or committing.

If the current branch is the target branch and there are task-owned changes, create a branch using the repository branch naming rules above, for example `fix/cli-redraw` or `docs/pr-template`.

### 3. Commit Cleanly

Group commits by logical purpose. Prefer focused commits over one mixed commit when changes are independent.

Commit message rules:

- Format: `type(scope): summary`.
- Keep the summary concise and within the repository's title limit.
- Use English commit messages unless the user explicitly requests otherwise.
- Do not include generated-by signatures or co-author trailers.

Useful commands:

```bash
git diff --stat
git diff --cached --stat
bun run validate:title --title "fix(cli): prevent duplicate redraw"
```

### 4. Verify Before Push

Run the same checks CI runs unless the user explicitly asked to skip or the task is intentionally body-only:

```bash
bun run lint
bun run typecheck
bun test
```

If a check fails:

- Fix the issue if it is in scope.
- Commit the fix separately when it changes code or docs.
- Re-run the failed check, and then continue through the remaining checks.
- If the failure is unrelated or cannot be fixed safely, stop before push and report the failing command and key output.

Record every command and outcome for the PR `Verification Log`. If a check is skipped, record the reason.

### 5. Push Safely

Before pushing, confirm the branch and upstream state:

```bash
git status --short --branch
git rev-parse --abbrev-ref HEAD
git log --oneline --decorate --max-count=8
```

Push with:

```bash
git push -u origin <branch>
```

Do not force-push unless the user explicitly asks and the branch is known to be yours.

### 6. Detect Existing PR

Check for an open PR for the branch:

```bash
gh pr view --json number,url,title,body,state,baseRefName,headRefName
```

If the PR exists and is open, update it. If it is closed or merged, create a new PR.

If `gh pr view` fails because no PR exists, continue to PR creation.

### 7. Build the PR Body

Follow the named PR template at `.github/PULL_REQUEST_TEMPLATE/intent-log.md` when present. Keep the headings from the template and fill them with useful content. Do not create or rely on `.github/pull_request_template.md` for this workflow because that becomes GitHub's default PR template for every PR.

The body should include:

- Context: why the work exists, including the user goal, original problem, and intended outcome.
- Decision log: important implementation choices and trade-offs.
- Changes: concise bullets based on commits and diff.
- Verification log: commands run, pass/fail result, and skipped checks with reasons.
- Screenshots or recording: required for visible UI changes; otherwise `N/A`.
- Review notes: risks, follow-ups, and anything reviewers should inspect closely.

Do not add a default `Related links` section. If the user explicitly provides an issue, document, or URL that materially explains the work, mention it inside `Context` instead of creating a separate link block.

Use Korean for the PR body when appropriate, but keep command names, file paths, and code identifiers exact.

Prefer writing the body to a temporary markdown file and using `--body-file` to avoid shell quoting issues:

```bash
gh pr create --draft --base <target> --title "<title>" --body-file /tmp/diligent-pr-body.md
gh pr edit <number-or-url> --title "<title>" --body-file /tmp/diligent-pr-body.md
```

### 8. Humanize Korean PR Body

When the PR body contains Korean prose:

- Invoke the `humanize-korean` skill once on the completed PR body draft before `gh pr create` or `gh pr edit`.
- Treat this as a style pass only. Do not add, remove, or reinterpret facts, commit details, verification results, issue references, file paths, command names, checkboxes, code identifiers, screenshots, or uploaded links.
- Preserve Markdown structure exactly enough for GitHub rendering: headings, checklists, tables, fenced code blocks, links, and issue references must remain valid.
- Use the humanized `final.md` result as the new PR body source after removing any trailing `<!-- HUMANIZE-SUMMARY ... -->` block from the body that will be uploaded to GitHub.
- If the humanized output changes technical facts or breaks Markdown, discard the humanized output, keep the original draft, and note the failed style pass in `Review Notes`.
- Do not run repeated humanization loops unless the user explicitly asks.

If the PR body is English-only or body-only mode is being used to draft English text, skip this step.

### 9. Preserve Existing PR Context

When updating an open PR:

- Preserve uploaded images, recordings, and user-attachment links.
- Preserve all existing content under `Screenshots or Recording` or equivalent screenshot/video sections. Reinsert it verbatim into the updated PR body even when regenerating the rest of the description.
- Preserve existing `Background and intent` content unless it is clearly stale.
- Append new verification results instead of deleting useful prior logs.
- Keep known limitations and follow-up notes visible.
- Update the title and body so they describe all commits currently in the PR.

Do not resolve review threads, reply to line comments, or re-request reviewers automatically. If review comments are relevant to the new push, summarize the addressed items in `Review Notes` or in a normal PR comment only when the user asks.

### 10. Create or Update the PR

Title rules:

- Must pass `bun run validate:title --title "<title>"`.
- Use `type(scope): summary`.
- The summary may be Korean or English, but keep it short enough for the validator.

Creation example:

```bash
gh pr create --draft --base <target> --title "docs(github): add intent-focused PR template" --body-file /tmp/diligent-pr-body.md
```

Update example:

```bash
gh pr edit <number-or-url> --title "fix(web): preserve tool render context" --body-file /tmp/diligent-pr-body.md
```

Return the PR URL and a compact summary:

- branch
- target branch
- commits created
- verification commands and outcomes
- PR URL

## Body-Only Mode

If the user asks only for PR text, do not commit, push, or create a PR. Inspect commits and diffs, then provide a draft body following the template.

## Missing GitHub CLI

If `gh` is unavailable or unauthenticated, stop after preparing the PR title and body. Tell the user what command to run next and where the prepared body is located.
