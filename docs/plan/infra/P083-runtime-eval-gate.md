---
id: P083
status: active
created: 2026-07-18
---

# P083: Runtime Eval Task Gate

## Goal

Extend `@diligent/evals` from core-only behavioral coverage to a runtime suite that detects regressions in the
assembled Diligent coding-agent runtime against live OpenAI and Anthropic API models.

The runtime suite evaluates an isolated project, an in-process `DiligentAppServer`, the runtime event stream,
persisted session state, and the final workspace. It preserves the core suite's central rule:

> Execution is non-deterministic; evaluation is deterministic code over allowlisted evidence.

The completed sequence is:

1. core eval tasks — provider normalization and core agent-loop behavior;
2. runtime eval tasks — Diligent prompt, mode, tools, sessions, and project-local state;
3. OVERDARE eval tasks — product-specific prompts and bundled tools, planned separately.

P083 initially runs as a manual and daily non-blocking shadow signal. A separate reviewed change may make the
frozen runtime suite a release prerequisite only after the readiness window in this plan has passed.

## Context

P080 introduced a live-model core suite with isolated in-memory worlds, runner-owned budgets, deterministic
evaluators, structural invariants, redacted versioned reports, and fixed provider profiles. It intentionally excluded
runtime file, shell, approval, session, skill, plugin, and collaboration behavior.

The repository already contains two live E2E areas that belong to this next layer:

- `packages/e2e/conversation.test.ts` exercises runtime bash and file tools with loose assertions;
- `packages/e2e/read-image-providers.test.ts` exercises the runtime image tool across providers.

Most of `packages/e2e` remains deterministic full-stack protocol coverage and must not move. Runtime evals exist only
where a real model must interpret a runtime-owned prompt or tool contract and cause a deterministically observable
outcome.

## Confirmed Requirements

1. Keep one private `@diligent/evals` package. Do not create `@diligent/runtime-evals`.
2. Preserve the existing core task, execution, invariant, and report contracts unless a shared extraction can be made
   without changing core behavior.
3. Run runtime tasks through an in-process `DiligentAppServer`, not by attaching runtime tools directly to a core
   `Agent`.
4. Give every task/profile execution a fresh project directory, fresh runtime state, fresh server, and fresh mutable
   world.
5. Construct equivalent but independent workspaces for both canonical providers from the same per-task seed.
6. Evaluate normalized events, protocol notifications, session JSONL, tool traces, verifier results, and final
   workspace state with deterministic code. Do not use an LLM judge.
7. Run shared core structural invariants for each model turn before runtime invariants and task semantics.
8. Keep timeout and all budgets runner-owned. A normal runtime return after an interrupt is not success when the
   runner has already terminated the execution.
9. Do not read a developer's real global Diligent config, auth store, skills, agents, knowledge, or sessions.
10. Prevent runtime tools from reading, writing, or executing outside the task's declared policy.
11. Keep live execution out of default `bun test`; include deterministic runner, invariant, reporter, and evaluator
    tests in the default test run.
12. Keep root type checking explicit for eval source and test code.
13. Run the same task semantics against both canonical provider profiles. Provider-specific runtime edit tools are
    allowed, but provider-specific pass conditions are not.
14. Continue after an individual execution failure and write one combined report for every runnable combination.
15. Keep a filtered, overridden, or partial invocation non-canonical and ineligible to clear a release gate.
16. Keep Web and TUI unchanged. P083 adds no user-facing feature and no parallel client-specific behavior.

## Layer Ownership

| Layer | Live eval responsibility | Deterministic test responsibility |
|---|---|---|
| Core | Provider streaming, normalized messages, core events, generic tool-call loop | Conversion, retry, schema, and agent-loop unit tests |
| Runtime | Runtime prompt interpretation, mode tool exposure, built-in tools, sessions, skills, project-local state | Tool edge cases, permission matching, config merge, session repair, RPC handlers |
| Protocol/E2E | None beyond evidence transported by the runtime task | JSON-RPC ordering, notification fanout, reconnect, WebSocket serialization |
| Web/TUI | None | Rendering, commands, controls, and client recovery behavior |
| OVERDARE | Deferred to a separate suite | Product-specific deterministic integration tests |

The runtime suite may import public `@diligent/runtime` subpaths. Core task and core runner directories must remain
unable to import `@diligent/runtime`; lint configuration must enforce that narrower boundary after `@diligent/evals`
adds a runtime dependency.

## Non-goals

- Ranking providers or models.
- Measuring subjective answer quality.
- Snapshotting a complete natural-language answer as a pass condition.
- Retrying semantic failures or converting repeated attempts into a pass rate.
- Reproducing identical model output from a seed.
- Running live runtime evals on every pull request.
- Replacing deterministic runtime or protocol tests.
- Testing OAuth lifecycle, keyring behavior, config migration, WebSocket transport, or frontend rendering.
- Testing remote MCP servers, arbitrary plugins, web access, or product-owned bundled tools in V0.
- Allowing dependency installation or arbitrary network commands from a task workspace.
- Adding eval-only control fields to `RuntimeConfig`.
- Enabling a release gate in the implementation change that first introduces the runtime suite.

## Design Decisions

### One package, separate execution adapters

`packages/evals` owns both suites because profiles, seeds, metadata, redaction, CLI behavior, and suite orchestration
are shared. Core and runtime execution remain separate adapters:

```text
shared suite orchestration
  -> core execution adapter
       -> isolated in-memory Agent world
  -> runtime execution adapter
       -> isolated project + DiligentAppServer + persisted session
```

Do not widen the current `EvalTask<TWorld>` into a single type containing optional core and runtime fields. Introduce
`CoreEvalTask` as the existing contract's eventual explicit name and add a distinct async `RuntimeEvalTask`.

### App-server boundary, in-process transport

Runtime tasks use `createAppServerConfig()` and `DiligentAppServer` with an in-process `RpcClientSession` connection.
This covers the real runtime assembly path, including:

- mode-specific system-prompt suffixes and tool filtering;
- built-in tool construction;
- runtime event enrichment;
- approval and user-input bridges;
- `SessionManager` staging and persistence;
- slash-skill rewriting;
- thread resume behavior.

The transport is in-process because WebSocket behavior is already deterministic E2E territory. Runtime evaluators
validate protocol payload schemas and lifecycle evidence but do not score transport timing or multi-connection fanout.

### Explicit fixture config

The harness builds an explicit, type-checked `RuntimeConfig` from fixture-owned inputs. It does not call the ordinary
startup loader against the host environment. Fixture setup may call public discovery and prompt-building functions
with task-local roots, including `discoverInstructions()`, `discoverSkills()`, `buildBaseSystemPrompt()`, and
`buildSystemPromptWithKnowledge()`.

Config-loader behavior remains covered by deterministic tests. A future live task that specifically evaluates startup
loading must run in a subprocess with a temporary `HOME`, `USERPROFILE`, and storage namespace.

### General tool transformation option

Add an optional runtime assembly argument equivalent to:

```typescript
interface CreateAppServerConfigOptions {
  transformTools?: (
    tools: Tool[],
    context: { cwd: string; mode: Mode; provider: ProviderName },
  ) => Tool[];
}
```

The production default is the identity transformation. The argument belongs to `Options`, not `RuntimeConfig`, because
it controls one embedding/execution environment rather than user configuration. The runtime eval harness uses it to:

- remove capabilities outside the task allowlist;
- wrap every exposed tool with path and command guards;
- record a normalized tool trace;
- stop an over-budget tool before its underlying implementation runs.

The transformation occurs after mode filtering and before the final agent and collaboration registry receive their
tool lists. Tests must prove that omitting the option leaves current Web, TUI, and app-server behavior unchanged.

### Stable core report during runtime rollout

The current core report remains `schemaVersion: 1`. P083 must not force a core report-schema migration and restart the
core release-readiness observation window.

Runtime reports use a separate discriminated contract:

```typescript
interface RuntimeEvalSuiteReport {
  schemaVersion: 1;
  suite: "runtime";
  suiteVersion: "runtime-v0";
  // shared metadata plus runtime execution reports
}
```

Shared reporter code accepts the core-report/runtime-report union. A future common schema v2 may unify both only after
the core suite is operationally stable.

## Canonical Provider Profiles

Runtime V0 uses the exact P080 profiles so a runtime failure can be compared with the corresponding core signal.

| Provider | Model | Effort |
|---|---|---|
| OpenAI API | `gpt-5.6-terra` | `medium` |
| Anthropic API | `claude-sonnet-4-6` | `medium` |

Changing a canonical model, effort, prompt, fixture, evaluator, limit, tool policy, or verifier command is a reviewed
suite change and restarts the runtime readiness window.

## Runtime V0 Task Set

V0 contains four tasks. Four tasks across two profiles produce eight execution results, although tasks may contain
multiple user turns and therefore more than eight provider calls.

| Task | Max provider turns | Max tool calls | Timeout | Max output tokens per provider turn |
|---|---:|---:|---:|---:|
| `project-fix` | 16 | 24 | 300 seconds | 8,192 |
| `plan-readonly` | 8 | 12 | 180 seconds | 8,192 |
| `skill-guided-change` | 8 | 10 | 240 seconds | 8,192 |
| `session-resume` | 10 | 8 | 300 seconds | 8,192 |

Limits apply to the complete task execution, not independently to each scenario step. Runtime V0 additionally caps:

- changed project files at three;
- total changed project bytes at 64 KiB;
- subprocess verifier time at 60 seconds;
- user-input requests at zero unless a future task explicitly opts in;
- child-agent spawns at zero;
- exact task-declared shell commands only.

### 1. `project-fix`

Purpose: verify runtime project instructions, read/search tools, provider-appropriate edit tools, bash verification, and
final workspace correctness.

Fixture:

- a minimal Bun + TypeScript project with no install step and one failing test;
- a small source file containing a seed-derived bug operand or branch value;
- an immutable test file;
- an `AGENTS.md` instruction requiring the tests to remain unchanged and naming the exact verification command;
- no network dependency and no lockfile mutation requirement.

Prompt:

- ask the agent to diagnose and fix the failing behavior;
- require verification with exactly `bun test`;
- do not reveal the correct source change.

Pass conditions:

- at least one read capability (`read`, `grep`, `glob`, or `ls`) is used;
- at least one write capability succeeds;
- OpenAI may use `apply_patch`; Anthropic may use `edit` or `multi_edit`; the evaluator scores the normalized write
  capability rather than one exact tool name;
- a recorded `bash` invocation exactly matching `bun test` exits with code zero;
- a runner-owned independent verifier invokes `bun test` without a shell and exits with code zero;
- the source file has the expected semantic content;
- the test file, `AGENTS.md`, and all other protected fixture files are byte-identical to their initial state;
- no unexpected project file is created;
- the task ends with a normal assistant message, without scoring its prose.

### 2. `plan-readonly`

Purpose: verify plan-mode prompt assembly, mutation-tool exclusion, read-only investigation, and non-mutation.

Fixture:

- a small source and test pair with a deterministic defect;
- a seed-derived token inside the relevant source context;
- no generated files or command requirement.

Prompt:

- ask for diagnosis only and explicitly state that no changes should be made;
- require the final result in the deterministic form `CAUSE=<identifier>; TOKEN=<token>`.

Pass conditions:

- the thread runs in `plan` mode;
- the advertised final tool set contains no tool in `PLAN_MODE_DISALLOWED_TOOLS`;
- the agent uses at least one read capability;
- no write or execute capability is called;
- the complete project manifest is unchanged;
- the normalized final assistant text exactly matches the required cause identifier and seed token.

### 3. `skill-guided-change`

Purpose: verify task-local skill discovery, slash-skill rewriting, the `skill` tool contract, relative reference
resolution, and an exact file outcome.

Fixture:

- `.diligent/skills/seeded-transform/SKILL.md` with valid frontmatter;
- a skill-owned `references/rule.txt` containing a seed-derived transformation rule;
- a project input file;
- no global skills and no additional configured paths.

Scenario:

- invoke `/seeded-transform <task instruction>` through `turn/start`;
- the skill instructs the model to read the one reference file and produce one result file.

Pass conditions:

- the first task-specific procedural tool call is `skill` with `name: "seeded-transform"`;
- the skill reference is read from the declared skill base directory;
- the result file exactly matches the seed-derived expected value;
- no other project file changes;
- no bash, web, MCP, plugin, knowledge, or collaboration capability is used;
- the persisted user message contains the runtime slash-skill rewrite and remains valid session data.

### 4. `session-resume`

Purpose: verify multi-turn persistence, server recreation, session resume, context reconstruction, and a subsequent
runtime file mutation.

Scenario:

1. Start a new thread and give the model a seed-derived project codename. Require only a short acknowledgement.
2. Wait for all session writes and record the thread ID and session path.
3. Dispose the client and server completely.
4. Construct a fresh server over the same fixture paths and resume the exact thread ID.
5. Ask the resumed thread to create `CODENAME.txt` containing the earlier codename without repeating it.

Pass conditions:

- one parseable session file retains the original session ID;
- every entry ID is unique and every non-null `parentId` points to an earlier reachable entry;
- `thread/read` after resume contains the first user message and assistant acknowledgement;
- the second turn receives the first turn through reconstructed provider context;
- `CODENAME.txt` contains exactly the seed-derived codename and one trailing newline;
- no other project file changes;
- both user turns have balanced core lifecycle events and normal completion;
- no synthetic repair entry is required for an orphaned tool call.

## Deferred Candidate Tasks

The following tasks are valuable but are not part of the runtime V0 canonical manifest:

| Candidate | Reason for deferral |
|---|---|
| `knowledge-recall` | First stabilize exact preference-vs-current-intent semantics and knowledge fixture isolation. |
| `knowledge-update` | Model decision to persist can be policy-sensitive; evaluator must avoid subjective intent classification. |
| `read-image` | Retain current live E2E until runtime image evidence and artifact size controls are complete. |
| `collaboration` | Multiplies provider calls and requires child-session usage, budget, and cleanup accounting. |
| `request-user-input` | Needs a deterministic scripted client scenario that makes asking objectively required. |
| `approval-rejection` | Primarily a deterministic host/tool integration concern; rejection currently aborts execution. |
| `plugin-tool` | Arbitrary package loading and global plugin discovery require stronger isolation. |
| `mcp-tool` | Remote availability and OAuth would make the canonical signal externally unstable. |

Candidates run only through explicit non-canonical investigation until separately promoted. Promotion changes the
canonical manifest and starts a new readiness window.

## Task and Execution Contracts

The runtime task contract is asynchronous because fixture creation, session persistence, independent verification, and
cleanup all perform I/O.

```typescript
interface RuntimeEvalLimits extends EvalLimits {
  maxChangedFiles: number;
  maxChangedBytes: number;
  maxUserInputRequests: number;
  maxChildAgents: number;
  verifierTimeoutMs: number;
}

type RuntimeEvalStep =
  | {
      kind: "turn";
      message: string;
      mode?: Mode;
    }
  | {
      kind: "restart_and_resume";
    };

interface RuntimeEvalTask<TWorld> {
  id: string;
  description: string;
  limits: RuntimeEvalLimits;
  toolPolicy: RuntimeEvalToolPolicy;
  setup(seed: string, root: string): Promise<TWorld>;
  createRuntimeConfig(world: TWorld, profile: EvalProfile): Promise<RuntimeConfig>;
  createSteps(world: TWorld): RuntimeEvalStep[];
  verify?(world: TWorld, signal: AbortSignal): Promise<RuntimeVerifierResult>;
  snapshotWorld(world: TWorld): Promise<RuntimeWorldSnapshot>;
  evaluate(input: RuntimeEvalExecution<TWorld>): EvalSemanticResult;
  cleanup?(world: TWorld): Promise<void>;
}
```

The runner, not the task, owns the actual server/client lifecycle, budget controller, evidence capture, invariant order,
report construction, and final recursive removal of the temporary root.

Runtime execution evidence is grouped by user turn so existing core invariants remain meaningful:

```typescript
interface RuntimeEvalTurnRecord {
  index: number;
  threadId: string;
  startedAt: string;
  elapsedMs: number;
  termination: RuntimeTurnTermination;
  coreEvents: EvalEventSnapshot[];
  runtimeEvents: RuntimeEventSnapshot[];
  notifications: RuntimeNotificationSnapshot[];
  messages: Message[];
  usage: Usage;
}

interface RuntimeEvalExecution<TWorld> {
  taskId: string;
  profile: EvalProfile;
  seed: string;
  startedAt: string;
  elapsedMs: number;
  termination: RuntimeEvalTerminationReason;
  turns: RuntimeEvalTurnRecord[];
  toolCalls: RuntimeToolTrace[];
  approvals: RuntimeApprovalTrace[];
  userInputRequests: RuntimeUserInputTrace[];
  logs: EvalLogSnapshot[];
  session: RuntimeSessionSnapshot;
  workspace: RuntimeWorkspaceSnapshot;
  verifier?: RuntimeVerifierResult;
  world: TWorld;
  error?: EvalExecutionError;
}
```

## Workspace Fixture Contract

Every task/profile execution receives a directory created with `mkdtemp()`. The path must never be the repository
root, user home, `/`, `~`, or an unresolved environment-variable expansion.

Fixture setup records an initial manifest containing only:

- normalized workspace-relative path;
- entry kind (`file`, `directory`, or `symlink`);
- file size;
- SHA-256 content hash;
- executable bit where relevant.

Symlinks are forbidden in V0 fixtures. Setup fails if one is present. The harness separately classifies:

```text
project evidence
  source, tests, AGENTS.md, package metadata, task outputs

runtime evidence
  .diligent/sessions/**
  .diligent/knowledge/**
  .diligent/images/**
  .diligent/logs/**

fixture definitions
  .diligent/skills/**
  .diligent/config.jsonc when explicitly present
```

Task evaluators state which project and runtime paths may change. Reports use `$WORKSPACE/...` instead of absolute
temporary paths. Files larger than the report cap include a hash and size but not full content.

## Tool Safety Policy

The eval-owned tool transformation wraps the actual runtime tool implementations. It does not replace successful tool
behavior with fake tools.

Before underlying execution:

1. reject any tool not in the task's name or capability allowlist;
2. normalize Windows extended-length and separator forms;
3. resolve every supplied or parsed path against the fixture root;
4. reject absolute or relative traversal outside the fixture root;
5. reject symlink traversal;
6. compare bash input with the task's exact command allowlist;
7. increment runner-owned tool and capability counters synchronously;
8. stop before underlying execution if a budget is exceeded;
9. snapshot the normalized input without retaining credentials or unrelated environment state.

After underlying execution:

1. snapshot the allowlisted output, metadata, render payload, and output images;
2. cap stored text and image evidence;
3. classify the normalized capability as `read`, `write`, `execute`, `skill`, `knowledge`, `user_input`, or `collab`;
4. preserve runtime error metadata exactly enough for invariant and semantic evaluation;
5. rescan the workspace after every mutating call to catch undeclared changes early.

The bash task policy accepts exact normalized commands, not arbitrary prefixes. For example, allowing `bun test` does
not allow `bun test && curl ...`, shell substitutions, redirects, or a different command with the same first token.
The runner-owned verifier uses `Bun.spawn()` with a fixed argv array and never passes through a shell.

## Runtime Execution Pipeline

For each task/profile combination, the runner performs these steps:

1. Validate suite mode, exact canonical manifest, credentials, task IDs, root seed, and report destination before any
   provider request.
2. Derive the per-task seed from the root seed and task ID.
3. Create a fresh temporary root and call `task.setup()` independently for the selected profile.
4. Validate the fixture and capture its initial workspace manifest.
5. Construct an explicit fixture-owned `RuntimeConfig`, replace its stream with the selected profile stream wrapped by
   the output-token clamp, and install the task tool transformation.
6. Set the process-wide structured log sink to a runner capture sink for the sequential execution and restore it in
   `finally`.
7. Create an in-process app server and protocol client, initialize, and start the requested mode.
8. Subscribe before every `turn/start`; snapshot notifications and events immediately with sequence numbers and
   monotonic relative timestamps.
9. Count provider turns, tool calls, user-input requests, and child-agent spawns synchronously. Interrupt the active
   turn when any runner budget or task timeout is reached.
10. Execute scenario steps in order. A restart step waits for writes, disposes the client/server, creates a fresh
    server, and resumes the exact thread ID.
11. After the final step, wait for session writes and read the persisted session through public runtime APIs.
12. Capture final workspace and runtime-state manifests.
13. Run the independent verifier when configured.
14. Run core invariants per turn, then runtime invariants, then workspace policy checks, then task semantic evaluation.
15. Create only the allowlisted report snapshot.
16. Always close clients, dispose server/session resources, terminate child processes, restore logging, run task
    cleanup, and recursively remove the exact validated temporary root.

The suite continues to the next profile/task after an execution failure. Setup failures for one non-canonical
combination do not suppress unrelated runnable combinations. Missing canonical credentials fail before setup begins.

## Shared Runtime Invariants

### Per-turn core invariants

- every normalized message passes the canonical protocol message schema;
- exactly one `agent_start` and `agent_end` occur in legal order for each executed user turn;
- turn, message, and tool event lifecycles are balanced;
- assistant tool calls and tool-result messages pair by call ID and name;
- no fatal core event or uncaught provider/core exception is accepted as success;
- a completed turn ends in a normal assistant message with no pending tool call.

### Runtime event and protocol invariants

- every captured runtime event and notification passes its canonical protocol schema;
- each `turn/started` has exactly one `turn/completed` or `turn/interrupted` terminal notification;
- thread status returns to idle after each completed or interrupted step;
- notification thread and turn IDs match the active scenario step;
- enriched tool render payloads, when present, pass their protocol schemas;
- no unexpected approval, user-input, collaboration, MCP, plugin, or web interaction occurs;
- a runner budget termination cannot be reclassified as normal completion.

### Session invariants

- the session file parses with the current public runtime reader;
- the header ID equals the runtime thread ID and the header cwd normalizes to `$WORKSPACE`;
- entry IDs are unique;
- every non-null `parentId` points to an earlier reachable entry;
- committed visible messages match `thread/read` after writes settle;
- persisted assistant tool calls have matching persisted tool results;
- no fatal or unexplained error entry is accepted as success;
- resume retains the same session ID and does not silently create a second top-level session;
- task completion leaves no pending write or transient in-memory-only message required for the evaluator.

### Workspace invariants

- every read/write path is within the task workspace;
- every command is exactly allowlisted;
- no symlink appears during execution;
- protected files remain byte-identical;
- changed-file and changed-byte budgets are respected;
- every actual mutation is attributable to a recorded tool call or expected runtime persistence;
- the independent verifier completes within its timeout and its captured output stays under the report cap.

Invariant failures prevent the task semantic evaluator from running. Workspace snapshot and cleanup still run so the
report contains diagnostic state.

## Pass and Failure Policy

V0 runs every task/profile combination once. Semantic failures are not retried. Existing core provider retries remain
responsible only for retryable provider failures.

The runtime suite adds `runtime_contract` to the existing failure taxonomy. Stable codes include:

| Category | Example codes |
|---|---|
| `configuration` | `configuration.invalid_manifest`, `configuration.invalid_fixture` |
| `provider_auth` | `provider_auth.rejected` |
| `provider_transient` | `provider_transient.rate_limit`, `provider_transient.network` |
| `provider_terminal` | `provider_terminal.invalid_request` |
| `core_contract` | `core_contract.orphaned_tool_call`, `core_contract.fatal_event` |
| `runtime_contract` | `runtime_contract.invalid_notification`, `runtime_contract.session_parent_chain` |
| `runtime_contract` | `runtime_contract.workspace_escape`, `runtime_contract.forbidden_command` |
| `runtime_contract` | `runtime_contract.unexpected_mutation`, `runtime_contract.persistence_mismatch` |
| `task_semantic` | `task_semantic.project_fix.test_failed`, `task_semantic.session_resume.wrong_codename` |
| `budget_exceeded` | `budget_exceeded.timeout`, `budget_exceeded.changed_files` |
| `evaluator_error` | `evaluator_error.verifier_exception`, `evaluator_error.world_snapshot` |
| `runner_error` | `runner_error.cleanup_failed`, `runner_error.report_write` |

Any contract failure fails the task even when the final workspace happens to be correct. Any task semantic failure
fails even when the final natural-language answer sounds plausible.

Cleanup failure is reported but must not overwrite an earlier primary failure. A cleanup failure on an otherwise
successful execution makes the execution fail as `runner_error.cleanup_failed`.

## Seed Policy

Runtime seeds follow P080:

- local runs generate a cryptographically random root seed unless overridden;
- GitHub runs derive the root seed from repository identity, run ID, and source commit, excluding run attempt;
- per-task seeds derive from root seed and task ID;
- both providers receive independently created workspaces from the same task seed;
- root and task seeds appear in the report;
- a replay reconstructs fixture values and initial files, not model output or random runtime IDs.

Fixture generation must not include provider identity. Provider-specific tool exposure comes only from normal runtime
assembly for the selected model.

## Runtime Report Contract

Run-level fields include:

- schema version, `suite: "runtime"`, and suite version;
- canonical status and canonical reason;
- repository, commit SHA, ref, workflow run ID, and run attempt;
- Bun version, OS, architecture, and runtime session format version;
- start/end timestamps and root seed;
- exact profiles, task IDs, fixture versions, and combined result.

Each execution reports:

- task ID, task seed, profile, and limits;
- pass/fail, termination, primary failure, and all failures;
- elapsed time and aggregated provider usage;
- per-turn lifecycle summaries and allowlisted event/notification traces;
- normalized tool capability trace with `$WORKSPACE` paths;
- approval and user-input request summaries;
- sanitized structured runtime logs;
- session header and allowlisted entry snapshots;
- initial/final workspace manifests and bounded diffs;
- verifier argv, exit code, duration, and bounded output;
- allowlisted task world snapshot.

The reporter must not recursively serialize arbitrary task instances, process environments, request headers, provider
SDK objects, full image data, or unbounded tool output. Credential redaction tests cover all new evidence fields.

## CLI Contract

The root command adds a `runtime` suite selector:

```bash
# Complete release-eligible manifest, initially shadow-only
bun run eval runtime --canonical

# Canonical fixture reconstruction
bun run eval runtime --canonical --seed <seed>

# Non-canonical investigation
bun run eval runtime --provider openai
bun run eval runtime --provider anthropic
bun run eval runtime --task project-fix
bun run eval runtime --task session-resume --seed <seed>
bun run eval runtime --model <model-id>
```

`--canonical` rejects provider, task, model, effort, tool-policy, fixture, and verifier overrides. A seed override is
allowed locally and in manual workflows for reconstruction but is not exposed by a future release call path.

Default reports use:

```text
artifacts/evals/runtime-<timestamp>.json
```

Console and job-summary output identify the suite explicitly and show task, provider, termination, counts, workspace
change summary, and primary failure code. Complete evidence remains in the JSON artifact.

## Workflow

Add `.github/workflows/runtime-evals.yml` with:

- manual `workflow_dispatch` for canonical and filtered investigation;
- a daily schedule at 06:30 KST (`30 21 * * *` UTC), staggered after core evals;
- `workflow_call` for future release integration;
- Bun `1.3.9` and frozen-lockfile installation;
- exact checkout of `github.sha`;
- a finite workflow timeout sized for sequential V0 execution;
- artifact upload on success or failure;
- 30-day manual/daily retention and requested 90-day future release retention, subject to repository policy.

Change both core and runtime workflows to the shared concurrency group:

```yaml
concurrency:
  group: ${{ github.repository }}-live-evals
  cancel-in-progress: false
```

V0 task/profile executions remain sequential. This is required by the process-wide runtime log capture, temporary
environment isolation, provider quota policy, and trace readability.

## Release-Gate Readiness

Do not invoke runtime evals from Release until all of the following are true:

1. The exact canonical profiles, four tasks, prompts, fixtures, tool policies, evaluators, limits, verifier commands,
   and report schema are frozen.
2. At least 14 consecutive daily canonical runtime runs pass all eight task/profile executions.
3. No unexplained provider, core-contract, runtime-contract, task, budget, evaluator, cleanup, or runner failure remains
   in the observation window.
4. Deliberate failures prove that workspace escape, forbidden command, session corruption, semantic mismatch, and
   verifier failure each produce the intended stable code and non-zero workflow result.
5. A manual canonical run verifies exact-SHA reporting and credential/path redaction on a release-style ref.
6. Temporary workspace cleanup is proven on success, provider failure, timeout, interrupt, evaluator exception, and
   report-write failure.
7. Existing core eval release readiness is not weakened or bypassed.
8. A separate reviewed workflow change enables the runtime dependency.

Any frozen input change restarts the 14-run window.

When both gates are enabled, release ordering is sequential to avoid spending runtime quota after a core failure:

```text
prepare -> core-evals -> runtime-evals -> release builds -> publish
```

The release integration must preserve P080's existing-release no-op rule. If the target GitHub Release already exists,
core evals, runtime evals, builds, and publish all skip. Every build checks out the same SHA recorded by both reports.

## Existing E2E Migration

After the runtime suite completes its shadow period:

- move the live bash behavior from `packages/e2e/conversation.test.ts` into `project-fix` evidence;
- move the live read/write behavior from `packages/e2e/conversation.test.ts` into `project-fix`;
- remove loose live conversation cases already covered by the stable core and runtime suites;
- keep deterministic abort, protocol, mode/config, turn, session, transport, hooks, and multi-connection E2E tests;
- retain `read-image-providers.test.ts` until the deferred runtime image task has equivalent provider coverage and its
  own successful shadow period;
- never delete an E2E case merely because a planned runtime task has the same title.

Update `packages/e2e/README.md` so it no longer advertises removed live behavior after migration.

## Repository Layout

Use an incremental layout that avoids moving stable core files solely for symmetry:

```text
packages/evals/
  src/
    cli.ts
    cli-options.ts
    profiles.ts
    task.ts                         # existing core contracts, stable during V0
    common/
      failure.ts
      metadata.ts
    runner/
      execution.ts                 # existing core execution, stable during V0
      suite.ts                     # shared orchestration via injected executor
      runtime-execution.ts
      runtime-invariants.ts
      runtime-workspace.ts
      runtime-tool-policy.ts
      runtime-protocol-client.ts
    reporters/
      json.ts
    tasks/
      core/
      runtime/
        index.ts
        project-fix.ts
        plan-readonly.ts
        skill-guided-change.ts
        session-resume.ts
    runtime-task.ts
  test/
    runner/
      runtime-execution.test.ts
      runtime-invariants.test.ts
      runtime-workspace.test.ts
      runtime-tool-policy.test.ts
    tasks/runtime/
      tasks.test.ts
    reporters/
      runtime-json.test.ts
    helpers/
      runtime-fake-stream.ts
      runtime-protocol-client.ts
```

Once both suites are stable, a separate cleanup may rename `task.ts` and `execution.ts` under a `core/` directory. P083
does not require that churn.

Other file changes:

| File | Required change |
|---|---|
| `packages/evals/package.json` | Add direct `@diligent/runtime` dependency. |
| `packages/evals/src/cli-options.ts` | Accept `core` and `runtime` suite selectors with suite-specific manifests. |
| `packages/evals/src/cli.ts` | Dispatch the selected suite and write suite-specific summaries/report names. |
| `packages/evals/src/runner/suite.ts` | Inject execution adapter while preserving sequential completeness and manifest checks. |
| `packages/runtime/src/app-server/factory.ts` | Add the optional tool transformation execution argument. |
| `biome.json` | Forbid runtime imports from core eval task/runner paths. |
| `ARCHITECTURE.md` | Describe evals as core and runtime suites with per-suite dependency boundaries. |
| `docs/guide/evals.md` | Document runtime commands, evidence, isolation, and shadow status. |
| `.github/workflows/core-evals.yml` | Move to shared live-eval concurrency group. |
| `.github/workflows/runtime-evals.yml` | Add manual/daily/reusable runtime workflow. |

## Test-First Implementation Sequence

1. Freeze this plan's contracts and record any intentional deviations before implementing them.
2. Add deterministic CLI tests for the runtime selector, canonical manifest validation, and core/runtime report paths.
3. Add deterministic suite tests proving the execution adapter is injected without changing core suite behavior.
4. Add workspace tests for equivalent fixture creation, path normalization, symlink rejection, manifest hashing,
   changed-file/byte limits, and exact cleanup targets.
5. Add tool-policy tests for every V0 tool input shape, Windows path forms, traversal, command injection, synchronous
   over-budget prevention, and normalized traces.
6. Add runtime invariant tests for malformed notifications, lifecycle mismatches, corrupt sessions, broken parent
   chains, persistence drift, unexpected mutations, and verifier failures.
7. Add reporter tests containing sentinel API keys, bearer tokens, host paths, oversized text, images, tool metadata,
   logs, sessions, and workspace diffs.
8. Add app-server construction tests proving the absent tool transformation is behavior-preserving and the present
   transformation sees the final mode-filtered tools.
9. Implement the runtime protocol client, workspace manager, tool policy, execution adapter, invariants, and report
   conversion.
10. Write deterministic positive and negative evaluator tests for all four tasks using fake provider streams.
11. Implement the four fixture generators and semantic evaluators.
12. Run filtered live investigations for both providers and adjust prompts only to remove accidental ambiguity.
13. Run a complete manual canonical suite and verify report redaction, cleanup, replay, and exact-SHA metadata.
14. Add the shadow workflow and shared concurrency group, leaving Release disconnected.
15. Observe the readiness window and promote operational instructions into `docs/guide/evals.md`.
16. Enable the release dependency in a separate reviewed change only after readiness is proven.
17. Remove superseded live E2E cases only after equivalent runtime shadow coverage is active.

## Verification

- Existing 32 deterministic core eval tests continue to pass unchanged or with behavior-equivalent import updates.
- New deterministic runtime runner, invariant, tool-policy, workspace, reporter, and evaluator tests pass without API
  credentials.
- Root type checking covers all eval runtime source and test files.
- Lint enforces that core eval code cannot import runtime.
- `bun run eval core --canonical` preserves its current selection and report contract.
- `bun run eval runtime --canonical` produces exactly eight unique results and one runtime report.
- Both providers receive equivalent initial workspace manifests for each task seed.
- A failure in one execution does not suppress remaining runnable combinations.
- Missing canonical credentials fail before fixture setup or provider execution.
- Timeout and tool budget tests prove that an underlying mutation cannot run after termination.
- Workspace traversal through direct paths, `..`, Windows paths, patch headers, and symlinks is rejected.
- Shell metacharacters, redirects, substitutions, pipes, and command suffixes cannot bypass exact allowlists.
- Every scenario waits for session writes before snapshot or restart.
- Server restart genuinely creates a new app-server/runtime object and resumes the original session ID.
- Core invariants run independently for every user turn in a multi-turn task.
- The independent verifier cannot be replaced or influenced by a model-generated shell command.
- Reports contain no credential sentinels, bearer values, host home paths, or unbounded file/tool/image data.
- Temporary roots are removed after every terminal path and no cleanup target can resolve to a broad directory.
- A deliberate runtime evaluator failure makes the workflow exit non-zero after artifact writing.
- Daily workflow runs sequentially with core evals under the shared concurrency group.
- Fourteen consecutive unchanged canonical runs pass before any release dependency is enabled.

## Locked V0 Decisions

- Package: existing private `@diligent/evals`.
- Canonical command: `bun run eval runtime --canonical`.
- Runtime boundary: in-process `DiligentAppServer` plus direct `RpcClientSession` transport.
- Canonical profiles: the exact P080 OpenAI and Anthropic API profiles at medium effort.
- Canonical tasks: `project-fix`, `plan-readonly`, `skill-guided-change`, and `session-resume`.
- Canonical result count: eight task/profile executions.
- Evaluation: deterministic code only; no LLM judge and no semantic retry.
- Workspace policy: fresh independent temporary project per execution and exact allowlists.
- Execution order: sequential.
- Core report: unchanged schema v1 during runtime rollout.
- Runtime report: separate discriminated schema v1, suite version `runtime-v0`.
- Workflow: manual, daily shadow at 06:30 KST, and reusable `workflow_call` disconnected from Release.
- Release rollout: separate gate-enabling change after 14 consecutive unchanged passes.
- E2E migration: replacement must complete its own shadow period before live E2E removal.

## Remaining Operational Decisions

- Assign the owner for failed daily runtime triage and task-fixture maintenance.
- Confirm the maximum repository artifact retention available for future release reports.
- Confirm whether the CI runner image guarantees the exact `bun test` verifier environment for the full observation
  window; otherwise pin a dedicated container image before freezing the suite.
- Decide when the deferred image task should add Gemini investigation coverage without expanding the V0 canonical
  provider manifest.
