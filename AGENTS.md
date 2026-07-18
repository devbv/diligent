# AGENTS.md

Diligent — transparent, debuggable coding agent. Bun + TypeScript strict, monorepo.

## Explore by Need

Read only what your task requires.

| Need | Start here |
|------|-----------|
| Project identity & principles | `README.md` |
| Architecture, layers & patterns | `ARCHITECTURE.md` |
| Source code — core engine (agent loop, providers, tool interfaces, auth primitives) | `packages/core/` |
| Source code — runtime (built-in tools, app-server, sessions, config, knowledge, skills, collab) | `packages/runtime/` |
| Source code — shared protocol contract | `packages/protocol/` |
| Source code — plugin SDK for external tool packages | `packages/plugin-sdk/` |
| Source code — cli (TUI) | `packages/cli/` |
| Source code — web (React + Tailwind web frontend) | `packages/web/` |
| Source code — debug-viewer (React web viewer) | `packages/debug-viewer/` |
| Source code — e2e (integration tests) | `packages/e2e/` |
| Product and usage guides | `docs/guide/` |
| Planning, decisions & phase specs | `docs/plan/` |
| Past tech-lead assessments | `docs/review/` |
| Pending work items | Project knowledge backlog entries |

## Code Explore System

Most source files include a `@summary` annotation on the first line: `// @summary <desc>` (or `# @summary` for .py). Use it as a quick routing hint, but do not assume it is universal. Skip index.ts, types.ts, and config files first.

## Documentation Routing

- Start with `ARCHITECTURE.md` for cross-package invariants, ownership boundaries, and shared frontend/backend rules.
- Use `docs/guide/*` for feature-specific behavior, examples, and change procedures.
- Treat `docs/plan/*` as future-facing or historical planning material, not as the source of truth for current implemented behavior.
- Do not infer shared architecture from a single client or package implementation alone.


## Rules

- English only in all files
- Do not spawn more than one subagent for a task.
- Clarify requirements fully before implementing — no assumptions
- When implementing new features or modifying existing behavior, write or strengthen tests first whenever possible.
- Run tests after code changes
- Plan before implementing when a task involves multiple files or architectural changes
- When creating or renaming branches, follow the repository's existing Git branch naming convention (for example `fix/...`, `feat/...`, `docs/...`). Repository branch rules override generic agent defaults: do not create agent-prefixed branches such as `codex/...` unless the user explicitly requests that exact prefix.
- When adding user-facing features, implement for both Web and TUI — they are thin clients of the same protocol (see `ARCHITECTURE.md` "Frontend Protocol Philosophy")
- Distinguish naming clearly: `Config` is for configuration values, while `Options` is for optional function arguments. Do not put runtime control arguments like `signal` into `Config`.

## Test File Convention

- Put all tests under each package-level `test/` directory only.
- Do not add tests under `src/**/__tests__/`.
- Mirror `src/` structure inside `test/`.
  - Example: `src/session/manager.ts` → `test/session/manager.test.ts`
- Use `*.test.ts` (or `*.test.tsx`) for unit tests.
- Use `*.integration.test.ts` (or `*.integration.test.tsx`) for integration tests.
- Keep shared test utilities in `test/helpers/` and static fixtures in `test/fixtures/`.
- For end-to-end scenarios, place tests in `packages/e2e/` only.
- For existing mixed layouts, prefer incremental migration to this convention when touching related files.

### Test Design

- Test behavior and stable invariants, not volatile configuration snapshots.
- A test must assert an observable that would fail under a plausible incorrect implementation of the named behavior. Successful completion alone is insufficient unless completion or liveness is itself the contract.
- Prompts and mocked model responses are test inputs, not evidence of model behavior. Tests using them must assert runtime-owned propagation, filtering, persistence, or state transitions; prompt-content tests may assert only the rendered or injected prompt contract.
- Avoid tests whose result is determined entirely by the fixture or an imported dependency unless the test verifies an otherwise-unobservable integration boundary.
- Do not assert concrete configuration values merely to mirror the current state. Examples include exact default model IDs, complete supported-model or provider lists, catalog counts, feature-flag defaults, and the presence or absence of a particular configured entry.
- When testing configuration-driven behavior, derive expectations from the configuration under test instead of duplicating its concrete values in the test.
- Prefer inline synthetic fixtures when testing generic capability, policy, selection, or normalization logic. Model effort and model-class routing are examples, not special cases.
- Exact configuration values are appropriate when they are part of an external compatibility contract, request transformation, protocol shape, or a targeted regression. Make that behavior explicit in the test name.

### Why this convention

- One obvious place for tests reduces decision overhead.
- Clear separation between runtime source (`src`) and verification code (`test`).
- Predictable paths improve review quality and refactoring safety.
- Simpler include/exclude patterns for tooling and CI.
