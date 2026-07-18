# P080: Core Eval Task Gate

**Status:** Implemented — ready for shadow operation  
**Date:** 2026-07-17

## Summary

Add a live-LLM eval task suite that detects behavioral regressions in `@diligent/core` against the OpenAI and Anthropic API providers. The suite will first run manually and once per day as a non-blocking shadow signal. After a defined burn-in period demonstrates that the tasks and runner are stable, a separate reviewed change will make the canonical suite a blocking prerequisite of the Release workflow.

This is the first stage of a broader sequence:

1. Core eval tasks
2. Runtime eval tasks
3. OVERDARE eval tasks

The initial implementation is limited to the core layer.

## Motivation

Core currently has extensive deterministic tests for provider conversion, streaming, retries, tool execution, and the agent loop. Those tests primarily use mocked provider responses. They verify implementation contracts well, but they do not verify that real models can complete tasks through the normalized core message and tool interfaces.

The existing live tests under `packages/e2e` provide limited real-provider coverage, but their assertions are loose, they mix live model behavior with runtime-level tools, and they are not part of the repository's explicit type-check command. A dedicated eval suite should provide a small, controlled, type-checked, and debuggable regression signal without joining the live execution path to the default `bun test` run.

## Design Principles

- **Deterministic evaluation, non-deterministic execution.** Evaluation is code over normalized messages, events, tool traces, and isolated world state. No LLM judge is used.
- **Runner-owned termination.** Timeout and budget outcomes are explicit runner results, even when core returns normally after an abort signal.
- **Separate structure from semantics.** Shared contract invariants run before task-specific semantic evaluators.
- **Canonical means complete.** A canonical result is valid only when the exact profiles and every required task run without filters or overrides.
- **External failures remain visible.** Provider failures are classified separately from core and task failures, but every category fails a canonical run.
- **Release gating requires evidence.** Daily shadow runs must demonstrate stability before the release dependency is enabled.
- **Reconstruction is scoped honestly.** A seed reconstructs the synthetic task world, not the provider's non-deterministic response.

## Goals

- Detect regressions in real provider streaming and normalized assistant messages.
- Verify message and event lifecycle invariants around streamed turns.
- Verify that real models receive and use core tool definitions correctly.
- Verify multi-turn tool-result feedback through the agent loop.
- Verify recovery after an explicitly marked tool execution error.
- Run the same behavioral contracts against OpenAI and Anthropic.
- Produce enough diagnostics to identify whether a failure came from configuration, a provider, the agent loop, a tool contract, task behavior, or the eval runner itself.
- Block a release when the stable canonical core eval suite fails.

## Non-goals

- Comparing model quality or ranking providers.
- Evaluating subjective answer quality with an LLM judge.
- Snapshotting complete natural-language responses as the pass condition.
- Reproducing an identical LLM response from a seed.
- Testing runtime-owned file, shell, approval, session, skill, plugin, or collaboration behavior.
- Testing OVERDARE product tools or prompts.
- Testing ChatGPT OAuth. OAuth lifecycle and transport coverage remain separate integration concerns.
- Running the live suite on every pull request.
- Hiding provider instability with semantic retries or pass-rate aggregation.

## Canonical Provider Profiles

The core suite runs the same tasks against both canonical profiles.

| Provider | Model | Effort |
|---|---|---|
| OpenAI API | `gpt-5.6-terra` | `medium` |
| Anthropic API | `claude-sonnet-5` | `medium` |

Canonical workflow runs must use these exact profiles. The task-specific output-token budget is an execution safety limit and does not change the canonical model identity or effort.

The canonical CLI mode must reject provider filters, task filters, model overrides, effort overrides, and incomplete credentials. A run counts as canonical only when it produces exactly eight unique task results: four required tasks across two required profiles.

Manual tooling may support filters and model overrides for investigation. Any such run must be labeled non-canonical in console output and artifacts and must never satisfy a release gate.

Changing a canonical model, effort, task prompt, evaluator, or limit is a reviewed suite change. The report records the source commit and suite version so historical results are not compared as if the suite were unchanged.

## V0 Task Set

All tasks use isolated `Agent` instances and isolated in-memory worlds. The two provider executions for a task receive independently constructed but equivalent worlds derived from the same task seed. Evaluation is deterministic code over message snapshots, event snapshots, tool traces, and final world state.

The initial limits are deliberately finite and generous enough for medium effort. They may be tuned during shadow operation. Any limit change restarts the release-readiness observation window.

| Task | Max turns | Max tool calls | Timeout | Max output tokens per provider turn |
|---|---:|---:|---:|---:|
| `direct-response` | 1 | 0 | 90 seconds | 8,192 |
| `single-tool` | 2 | 1 | 120 seconds | 8,192 |
| `tool-chain` | 4 | 3 | 300 seconds | 8,192 |
| `recover-tool-error` | 3 | 2 | 180 seconds | 8,192 |

### 1. `direct-response`

Purpose: verify a basic provider round trip, text streaming, and assistant message completion without tools.

- Give the model a seed-derived nonce and require only that nonce in the final response.
- Advertise no tools.
- Extract final assistant text by concatenating text blocks and trimming outer whitespace only.
- Pass when at least one `text_delta` event was observed and both the concatenated deltas and normalized final assistant text equal the expected nonce.
- Fail on any tool call, fatal event, malformed message, stream lifecycle violation, abnormal final assistant message, budget termination, or timeout.

### 2. `single-tool`

Purpose: verify tool advertisement, argument generation, local execution, tool-result delivery, and final response generation.

- Provide a `lookup_record(recordId)` tool.
- The prompt identifies the record but does not reveal its seed-derived verification code.
- The tool returns the hidden verification code.
- Pass when the model makes exactly one call to the correct tool with the correct record ID, the tool completes without error, and the final assistant text includes the returned code.
- Fail on an extra or incorrect tool, invalid arguments, missing final code, fatal event, abnormal completion, budget termination, or timeout.

### 3. `tool-chain`

Purpose: verify repeated agent turns and dependent tool calls.

- Provide `get_order`, `create_refund_quote`, and `submit_refund` tools.
- Each successful step returns a seed-derived opaque token required by the next step, preventing the model from guessing or skipping the chain.
- Keep all tools sequential by leaving `supportParallel` disabled.
- Pass when exactly three calls occur in the required order with valid dependent values, the submitted refund exists in the final world, and the agent reaches a normal final assistant turn.
- Do not score the wording of the final natural-language response.
- Fail on extra, out-of-order, invalid, or skipped calls even if the final world appears correct.

### 4. `recover-tool-error`

Purpose: verify that a tool error is returned to the model and that the loop can recover.

- Provide an `update_record` tool with revision checking.
- The first call always returns a deterministic stale-revision result containing the current revision and `metadata: { error: true, code: "stale_revision" }`.
- Assert that the corresponding `tool_end` and normalized tool-result message have `isError: true`.
- Pass when the model reads the error, retries exactly once with the supplied revision, reaches the expected final world state, and completes with a normal final assistant turn.
- Fail when it stops after the error, retries with invalid arguments, makes extra calls, exceeds task limits, produces a fatal event, or times out.

## Task and Execution Contracts

The exact file boundaries may change during implementation, but the runner needs contracts equivalent to the following:

```ts
type EvalTerminationReason =
  | "completed"
  | "timeout"
  | "turn_limit"
  | "tool_call_limit"
  | "provider_error"
  | "core_error"
  | "runner_error";

interface EvalLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

interface EvalExecution<TWorld> {
  taskId: string;
  profile: EvalProfile;
  seed: string;
  startedAt: string;
  elapsedMs: number;
  termination: EvalTerminationReason;
  messages: Message[];
  events: EvalEventSnapshot[];
  logs: EvalLogSnapshot[];
  usage: Usage;
  turnCount: number;
  toolCallCount: number;
  world: TWorld;
  error?: EvalError;
}

interface EvalTask<TWorld> {
  id: string;
  description: string;
  systemPrompt: SystemSection[];
  limits: EvalLimits;
  createWorld(seed: string): TWorld;
  createTools(world: TWorld): Tool[];
  createUserMessage(world: TWorld): Message;
  snapshotWorld(world: TWorld): unknown;
  evaluate(input: EvalExecution<TWorld>): EvalSemanticResult;
}
```

`snapshotWorld()` is an explicit allowlisted serializer. The reporter must not recursively serialize arbitrary task objects.

The output-token limit is applied by wrapping the provider `StreamFunction` and clamping `StreamOptions.maxTokens`; it does not require adding eval-specific control fields to core configuration types.

## Runner Execution Pipeline

For each task/provider combination, the runner performs these steps:

1. Validate the selected mode, profiles, required credentials, task IDs, and root seed before making any provider request.
2. Derive one task seed from the root seed and task ID. Use the same task seed for both provider profiles, but call `createWorld()` separately for each execution.
3. Create a fresh `Agent`, fresh world, and fresh tools. Do not share mutable state between executions.
4. Subscribe before calling `prompt()` and snapshot each event immediately with a sequence number and monotonic relative timestamp. Do not retain mutable event references.
5. Count `turn_start` and `tool_start` events. Abort through a runner-owned `AbortController` when a limit or timeout is reached and preserve the runner's termination reason. Wrap task tools so an over-budget call cannot invoke the underlying world-mutating implementation after the synchronous `tool_start` subscriber has requested abort.
6. Capture the returned messages, thrown error, and `agent_end.messages` independently. A user-signal abort may resolve normally in core, so promise resolution alone is never treated as proof of successful completion.
7. Run shared structural invariants over the captured execution.
8. Run the task semantic evaluator only after normal completion and structural success.
9. Snapshot the final world, aggregate usage reported by successful provider turns, and emit the structured result.

The runner should continue after an individual execution failure so a canonical invocation produces diagnostics for every runnable combination. Missing canonical credentials or invalid CLI configuration fail before any execution starts.

## Shared Structural Invariants

These checks are runner-owned and apply before every task evaluator:

- every normalized message passes the canonical protocol schema;
- exactly one `agent_start` and one `agent_end` exist in legal order;
- turn, message, and tool event lifecycles are ordered and use consistent IDs;
- every assistant tool call has exactly one matching tool result with the same call ID and tool name;
- no tool result exists without a preceding tool call;
- every observed tool execution has matching `tool_start` and `tool_end` events;
- a fatal core event or uncaught exception is never accepted as task success;
- runner termination is `completed` and all configured budgets remain within bounds;
- the final completed turn contains a normal assistant message with no pending tool call;
- evaluator and world snapshot code complete without throwing.

The `direct-response` task adds the stricter requirement that text deltas exist and reconstruct the final text.

## Pass and Failure Policy

V0 executes each task/provider combination once per suite invocation.

- Four tasks across two providers produce eight task executions per canonical suite run.
- A semantic task failure is not retried by the eval runner.
- Provider retries for retryable rate limits, network failures, and transient server failures remain governed by the existing core retry policy.
- Both providers must pass every task for the overall canonical workflow to pass.
- Any hard contract violation fails the task regardless of the final natural-language answer.
- The runner executes all remaining runnable combinations after a task failure and exits non-zero only after writing the combined report.
- A filtered or overridden investigation run cannot replace, repair, or clear a failed canonical gate.

Stable failure categories are:

| Category | Examples |
|---|---|
| `configuration` | missing credential, invalid profile, canonical filter, duplicate task |
| `provider_auth` | rejected or expired API credential |
| `provider_transient` | exhausted retryable rate limit, network, or server failure |
| `provider_terminal` | non-retryable provider response or unsupported request |
| `core_contract` | malformed normalized message, event mismatch, orphaned tool call/result |
| `task_semantic` | wrong tool, wrong arguments, missing code, incorrect final world |
| `budget_exceeded` | task timeout, turn limit, tool-call limit |
| `evaluator_error` | evaluator or world-snapshot exception |
| `runner_error` | runner invariant or reporter failure |

Failure results include a stable machine-readable code beneath the category, such as `core_contract.orphaned_tool_result` or `task_semantic.wrong_record_id`.

A GitHub workflow re-run executes the entire canonical suite again. Its root seed is derived without `github.run_attempt`, so a re-run reconstructs the same worlds while remaining a separately recorded provider attempt. Selectively re-running one task or provider is investigation only and cannot clear the gate.

## Seed Policy

- Local runs generate a cryptographically random root seed unless `--seed` is provided.
- GitHub runs derive the root seed from repository identity, `github.run_id`, and the source commit. `github.run_attempt` is deliberately excluded.
- Per-task seeds are derived from the root seed and task ID.
- Both providers receive separately constructed worlds from the same per-task seed.
- The root and task seeds are recorded in the artifact.
- Replaying a seed reconstructs record IDs, verification codes, dependency tokens, and initial world state. It does not guarantee the same model output or tool-call sequence.

## Workflow Triggers

The eval suite has exactly three execution paths.

### Manual

Use `workflow_dispatch` for investigation and explicit verification.

- Canonical mode runs the exact complete suite.
- Optional provider, task, model, or effort inputs create a non-canonical investigation run. A seed override alone is allowed for canonical world reconstruction.
- The workflow summary must state prominently whether the result is canonical.

### Daily Shadow

Run once per day at 06:00 Korea Standard Time. GitHub Actions schedules use UTC, so the cron expression is:

```yaml
schedule:
  - cron: "0 21 * * *"
```

Korea does not observe daylight saving time, so this remains 06:00 KST throughout the year.

Daily execution is initially non-blocking because it has no downstream release job. It still exits non-zero on suite failure and uploads the full report.

### Release

Expose the eval workflow through `workflow_call`, but do not invoke it from Release until the readiness criteria below are satisfied and a separate change enables the gate.

When enabled, the release dependency is:

```text
prepare -> core-evals -> release builds -> publish
```

The integration must satisfy all of the following:

- `core-evals` needs `prepare` and runs only when `needs.prepare.outputs.release_exists != 'true'`.
- Existing GitHub Releases are no-op executions in the current Release workflow, so their eval job is skipped as well.
- Every release build job needs both `prepare` and `core-evals`.
- `publish-release` includes `core-evals` in `needs` and explicitly requires `needs.core-evals.result == 'success'`, in addition to its build-result checks.
- The called workflow checks out `github.sha` explicitly and records that SHA in its report.
- The report's SHA must match the commit used by every release build job.
- A filtered or overridden workflow input is not exposed on the Release call path.

This makes the suite a blocking pre-build gate while avoiding live execution on every pull request and on release workflows that will not build or publish anything.

### Workflow Runtime Controls

- Use a repository-scoped concurrency group with `cancel-in-progress: false` so daily and release suites do not compete for provider quota.
- Give the complete workflow a finite timeout greater than the sum of task limits and expected provider retry delays.
- Use Bun `1.3.9`, pinned in the root `packageManager` field, and install with the frozen root lockfile.
- Record the Bun version in the report.
- Do not parallelize task executions in V0. Sequential execution simplifies rate-limit behavior, mutable-state isolation, and trace interpretation.

## Release-Gate Readiness

The Release workflow must not depend on the eval suite until all of the following are true:

1. The final canonical profiles, prompts, evaluators, limits, and report schema are frozen for the observation window.
2. At least 14 consecutive daily canonical runs complete with all eight task executions passing.
3. No unexplained provider, core-contract, task, evaluator, budget, or runner failure remains in that window.
4. At least one manual canonical run has verified artifact redaction and exact-SHA reporting on a release-style ref.
5. A deliberate failing evaluator has proven that the reusable workflow exits non-zero.
6. A separate reviewed workflow change enables the Release dependency and verifies that build and publish jobs remain blocked on failure.

Any canonical profile, prompt, evaluator, or limit change restarts the 14-run observation window. This prevents a recently adjusted task from becoming a release gate based on results from an earlier suite definition.

## Secrets

Canonical runs require:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Secrets must be provided by GitHub Actions secret inheritance for release calls and direct secret references for scheduled or manual runs. Canonical credential validation happens before any provider request. A non-canonical filtered run requires only the selected provider credential.

The runner and reporter must never enumerate `process.env`, serialize request headers, retain authorization values, or serialize raw provider SDK request/response objects. Logs and artifacts must never include credentials or authorization headers.

## Diagnostics and Artifacts

Every report has a versioned, allowlisted schema.

Run-level fields include:

- report schema version and eval suite version;
- canonical or non-canonical status and the reason;
- repository, commit SHA, ref, workflow run ID, and workflow run attempt;
- Bun version;
- start and end timestamps;
- root seed;
- selected profiles and task IDs;
- combined pass or fail result.

Every task execution reports:

- task ID and task seed;
- provider, model, effort, and output-token limit;
- pass or fail;
- termination reason;
- structured failure category, code, and sanitized message;
- elapsed time;
- provider-reported input, output, cache-read, and cache-write token usage;
- turn count and tool-call count;
- snapshotted core event trace with sequence and relative time;
- sanitized structured core log records;
- final normalized message snapshots;
- allowlisted final world snapshot.

Provider-reported usage is diagnostic and is not claimed to equal billing after failed or discarded provider attempts.

Console output and the GitHub job summary remain concise on success. Failed executions surface their category, code, termination, counts, and the tail of the relevant trace. The complete combined JSON report is uploaded even when one or more tasks fail.

Artifact serialization is allowlist-based rather than a recursive dump followed by best-effort redaction. Redaction tests use sentinel credentials and authorization values and verify the serialized report, console reporter, error serialization, and structured logs.

Default retention is 30 days for daily and manual reports and 90 days for release-gate reports, subject to the repository's configured GitHub artifact retention limit.

## Repository Layout

Use a dedicated private workspace package. All executable package code, including task definitions, lives under `src/`; tests mirror that structure under the package-level `test/` directory.

```text
packages/evals/
  package.json
  tsconfig.json
  tsconfig.test.json
  src/
    cli.ts
    profiles.ts
    task.ts
    runner/
    reporters/
    tasks/
      core/
        direct-response.ts
        single-tool.ts
        tool-chain.ts
        recover-tool-error.ts
  test/
    runner/
    reporters/
    tasks/core/
```

The package is named `@diligent/evals` and declares `"private": true`. It depends directly on the public `@diligent/core` capability boundaries and the canonical protocol schemas; core tasks must not import runtime tools or runtime assembly.

Add the eval source and test TypeScript configurations explicitly to the root `typecheck` command. Add only deterministic runner, reporter, and evaluator tests to default `bun test`; live task execution remains reachable only through the eval CLI.

Do not create empty `runtime/` or `overdare/` task directories in V0. Add them when those stages begin.

## CLI Contract

The root command surface is:

```bash
# Complete release-eligible suite
bun run eval core --canonical

# Complete canonical replay with a recorded world seed
bun run eval core --canonical --seed <seed>

# Non-canonical investigation
bun run eval core --provider openai
bun run eval core --provider anthropic
bun run eval core --task tool-chain
bun run eval core --model <model-id>
```

`--canonical` rejects every selection or profile override but may accept a root seed for reconstruction. The Release call path never exposes a seed input. Non-canonical runs still return non-zero when their selected execution fails, but their artifacts state why they are not release eligible.

The CLI executes every selected runnable combination, writes one combined report, prints its location, and exits non-zero after reporting if configuration, execution, evaluation, invariant checking, or report writing failed.

## Existing E2E Migration

Do not remove all of `packages/e2e`. Most current files are deterministic full-stack protocol tests and cannot be replaced by live eval tasks.

After the new suite is implemented, type-checked, and verified:

- replace basic live provider conversation and tool-loop coverage from `conversation.test.ts` with core eval tasks;
- move runtime file and shell behaviors into the future runtime eval suite rather than the core suite;
- retain deterministic abort, protocol, session, transport, and runtime integration coverage;
- replace `read-image-providers.test.ts` only after equivalent core image-contract and runtime image-tool coverage
  exists; this completed through core `image-tool-result` and runtime `read-image-pair` before the E2E was removed;
- the replacement shadow passes completed before the superseded live E2E cases were removed.

## Implementation Sequence

1. Finalize the contracts in this plan, including the pinned Bun version and versioned report schema.
2. Add the private `@diligent/evals` package, root CLI script, and explicit source/test type checking.
3. Write deterministic tests first for mode validation, world isolation, seed derivation, event snapshotting, runner-owned termination, limit handling, failure classification, complete-after-failure execution, and report redaction.
4. Implement the runner, shared structural invariant checker, canonical profiles, and allowlisted artifact reporter.
5. Write deterministic evaluator tests for the four core tasks, including negative traces and world states.
6. Implement the four core tasks and their in-memory worlds.
7. Run both canonical providers manually and adjust prompts only to remove accidental ambiguity. Do not add provider-specific task behavior.
8. Add the reusable manual/daily/`workflow_call` eval workflow, but leave it disconnected from Release.
9. Observe at least 14 consecutive unchanged daily canonical runs and resolve every failure according to the readiness policy.
10. In a separate reviewed change, add the blocking Release dependency and verify the exact-SHA and no-op-release conditions.
11. Migrate or remove superseded live E2E coverage only after equivalent eval coverage is active.
12. Promote stable operational instructions into `docs/guide/` when implementation is complete, following the plan-document lifecycle.

## Verification

- Runner, reporter, invariant, and evaluator unit tests pass under default `bun test` without API credentials.
- Root type checking covers both eval source and test code.
- Linting covers the new package and workflow.
- A manual canonical run produces exactly eight unique task results and one combined artifact.
- A failure in one task still produces results for the remaining runnable combinations.
- Removing either canonical provider credential fails before the first provider request with a clear configuration error.
- Filtered or overridden runs are marked non-canonical and are rejected by `--canonical`.
- Timeout, turn-limit, and tool-call-limit tests prove that a core prompt which resolves after abort is still classified as a budget failure.
- The direct-response evaluator fails when final text is correct but no text delta was observed.
- Protocol schema, lifecycle, orphaned-tool, and abnormal-final-message fixtures fail as `core_contract` errors.
- A deliberately failing evaluator causes manual, daily, and reusable workflows to fail after writing an artifact.
- Artifact, console, structured-log, and error serialization tests contain no sentinel API keys or authorization headers.
- A workflow re-run uses the same root and task seeds while recording a different run attempt.
- The called workflow report SHA matches the release caller and build checkout SHA.
- A deliberately failing canonical invocation prevents every Release build and publish job from running.
- An already existing target GitHub Release skips the eval, build, and publish jobs.
- Fourteen consecutive unchanged daily canonical runs pass before the release dependency is enabled.

## Locked V0 Decisions

- Package name: `@diligent/evals`, private workspace package.
- Canonical command: `bun run eval core --canonical`.
- Canonical scope: four tasks across both exact provider profiles, eight results total.
- Execution policy: one semantic attempt per combination; existing core provider retries remain active.
- Scheduling: manual, daily at 06:00 KST, and reusable `workflow_call`.
- Release rollout: shadow first, then a separate gate-enabling change after 14 consecutive passes.
- Existing-release behavior: skip the eval gate when the target GitHub Release already exists and no build or publish job will run.
- V0 execution order: sequential.
- Bun version: `1.3.9`, pinned in the root `packageManager` field.
- Artifact retention: 30 days for manual/daily and 90 days for release-gate runs, subject to repository limits.

## Remaining Operational Decisions

- Assign an owner for provider credential rotation, canonical model lifecycle changes, and failed daily-run triage.
- Confirm that repository-level GitHub artifact retention permits the requested 90-day release-report retention; otherwise use the maximum allowed value and document it.
