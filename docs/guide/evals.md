# Model-backed eval suites

Diligent keeps live-model behavioral evaluations in the private `@diligent/evals` package. They are separate from
deterministic unit and end-to-end tests and never run as part of the default `bun test` command.

## Suites

- `core` evaluates provider normalization and the generic agent loop in isolated in-memory worlds.
- `runtime` evaluates prompt assembly, mode-specific tools, project instructions, skills, sessions, and workspace
  effects through an in-process `DiligentAppServer` and `RpcClientSession` connection.

Run every task in each suite against both providers with:

```bash
bun run eval core
bun run eval runtime
```

Use `--provider openai|anthropic|gemini` to select one provider and `--task <id>` to select one task; the filters
compose. Gemini is opt-in: without either filter, the command continues to run every task against the OpenAI and
Anthropic default profiles. `--model` selects one compatible model and therefore one provider profile. `--seed`
reconstructs fixture values; it does not make model output deterministic. Reports are written under
`artifacts/evals/` unless `--report` is given.

The core suite contains 7 tasks: `direct-response`, `single-tool`, `tool-chain`, `recover-tool-error`,
`structured-tool-args`, `parallel-tools`, and `image-tool-result`. `image-tool-result` checks provider transport of
multiple image blocks from an in-memory tool without runtime or filesystem behavior. All profiles use medium effort.
A default complete run requires both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; a provider-filtered run requires
only its selected credential. An explicit Gemini run requires `GEMINI_API_KEY`.

The runtime suite contains 34 tasks. An unfiltered run uses both default profiles and therefore performs 68 sequential
task/profile executions. The complete manifest is:

- Project, prompt, and modes: `project-fix`, `plan-readonly`, `plan-to-execute`, `instruction-hierarchy`,
  `plan-converge`, `cross-file-contract-fix`, `plan-progress`, and `hook-context-follow`.
- Skills and knowledge: `knowledge-recall`, `skill-auto-select`, `skill-abstain`, `knowledge-intent-split`, and
  `knowledge-forget`.
- Interaction, context, and continuity: `session-resume`, `manual-compaction-resume`, `clarify-then-execute`,
  `read-image-pair`, `file-roundtrip`, `steer-during-fix`, `auto-compaction-resume`, `image-resume-recall`,
  `fresh-prompt-after-compaction`, `input-cancel-resume`, `loop-context-adaptation`, and `large-output-recovery`.
- Runtime integrations: `bundled-tool-routing`, `mcp-lazy-tool`, `mcp-resource-grounding`, and
  `mcp-prompt-grounding`, plus `mcp-needs-auth-abstain`. Plugin loading and tool-shape enforcement are deterministic
  runtime contracts, so `plugin-tool-routing` is not a live-model task.
- Collaboration: `custom-agent-routing`, `collaboration-parallel-synthesis`, `collaboration-resume-reference`, and
  `autonomous-explore-delegation`.

Selection counts are predictable: one task against one provider is one execution, one task without a provider filter
is two, all tasks against one explicitly selected provider (including Gemini) is 34, and the unfiltered manifest is
68.

Task `maxTurns` and `maxToolCalls` values are target budgets. Both core and runtime runners allow a fixed global
grace of two additional provider turns and one additional tool call before enforcing a hard stop. The execution report
retains the actual counts, so efficiency remains observable without failing an otherwise correct bounded recovery or
confirmation.

## Deterministic verification and live calibration

Deterministic tests exercise the harness, invariants, task evaluators, and assembled runtime paths with fake provider
streams or synthetic evidence. They need no provider credentials and do not make live model calls:

```bash
# Focused runtime harness and task coverage
bun test packages/evals/test/cli-options.test.ts packages/evals/test/runner packages/evals/test/tasks/runtime

# Complete deterministic eval-package coverage
bun test packages/evals/test
```

Live calibration executes the selected task/profile matrix against provider APIs. Model execution is non-deterministic,
but pass/fail evaluation is deterministic code over captured evidence; there is no LLM judge or semantic retry. Set
`OPENAI_API_KEY` for OpenAI selections, `ANTHROPIC_API_KEY` for Anthropic selections, and `GEMINI_API_KEY` for
explicit Gemini selections. An unfiltered run requires the OpenAI and Anthropic keys.

```bash
# One focused execution; only OPENAI_API_KEY is required
bun run eval runtime --task instruction-hierarchy --provider openai

# One task against both default profiles; both keys are required (2 executions)
bun run eval runtime --task instruction-hierarchy

# One focused Gemini execution; only GEMINI_API_KEY is required
bun run eval runtime --task bundled-tool-routing --provider gemini

# Complete default calibration; the OpenAI and Anthropic keys are required (68 executions)
bun run eval runtime
```

Use `--report <path>` to isolate a focused report from the timestamped default reports, and retain the emitted root
seed when investigating a failure. Reusing `--seed <seed>` reconstructs the same opaque fixture values but does not
guarantee the same model response.

### Failure dimensions and diagnostics

Eval reports retain `schemaVersion: 1` and the existing top-level `passed`, `failure`, and `failures` semantics. Each
failure also identifies the construct dimension it blocks: `semantic_goal`, `runtime_policy`, `behavior`,
`format_contract`, `efficiency`, or `harness_terminal`. A failed semantic evaluator result must explicitly provide its
dimension; there is no `semantic_goal` default. A missing dimension is an evaluator contract error classified as
`harness_terminal`. Configuration, provider rejection, timeout, budget, eval-policy, evaluator, and runner terminal
failures also use `harness_terminal`.

An evaluator may attach `diagnostics` containing a dimension, stable code, and message to either a passing or failing
semantic result. Diagnostics preserve non-gating evidence such as one accepted bounded recovery or an additional safe
read-only search. They never change `passed`, are propagated to execution reports, and are omitted when empty.

## Runtime evidence and isolation

Every runtime task/profile execution receives a fresh temporary project, runtime-state root, app server, and any
task-owned plugin, local stdio MCP, hook, or full-output resources. The runner records bounded, path-normalized
provider context, advertised-tool snapshots, normalized protocol notifications, core and runtime events,
actor-attributed tool traces, protocol actions, `thread/read` snapshots, parent and child session JSONL, workspace and
runtime-state manifests, and verifier output. Image evidence retains media metadata and sidecar state while raw base64
is omitted; credentials and undeclared host paths are not report evidence. Deterministic code evaluates this
allowlisted evidence.

The tool transformer runs after runtime mode filtering. It removes undeclared capabilities, confines project access to
the fixture, permits only explicitly registered read-only output paths outside it, rejects symlinks and non-exact shell
commands, records bounded traces, and stops over-budget calls before the underlying tool executes. Runtime-state
changes are checked against each task's declared mutation categories. The runner constructs fixture-owned
`RuntimeConfig` values and does not load host config, credentials as runtime configuration, global plugins, skills,
agents, knowledge, or sessions. Fixture resources are cleaned on success, failure, and timeout.

`packages/e2e/app-server` contains deterministic `DiligentAppServer` end-to-end tests through its JSON-RPC boundary.
It uses fake provider streams and does not cover product hosts or thin-client rendering. Live provider conversation,
tool recovery, image transport, shell, and file behavior are owned by the core and runtime eval suites.

## Shadow status

One scheduled workflow starts daily at 21:00 UTC (06:00 KST) under the shared, non-cancelling `model-evals`
concurrency group. Its direct-job graph is:

1. Core runs on Ubuntu as concurrent OpenAI and Anthropic jobs. Each job passes exactly one provider and executes the
   7-task suite, for 14 task/profile executions in the phase.
2. After the complete core matrix finishes, runtime runs even if core failed. Four jobs cover Ubuntu and Windows
   crossed with OpenAI and Anthropic. Each job passes exactly one provider and executes 34 tasks, for 136 executions:
   the same 68 task/profile pairs sampled once on each operating system.
3. A final always-running aggregate job fails the workflow unless both complete matrix phases succeeded. Per-job
   report uploads also run after failures and use provider/OS-specific paths and artifact names.

All jobs in one scheduled run derive the same root seed from the repository, GitHub run ID, and commit SHA. The two
runtime operating-system samples expose platform-specific harness or product behavior; they are correlated executions
of the same fixture/model contracts, not independent draws whose pass rates can be multiplied into a quality
probability.

The standalone core and runtime workflows remain available through `workflow_dispatch` and `workflow_call`, but have
no schedule and therefore do not duplicate the daily graph. They may filter to one task or provider; leaving filters
empty preserves their complete-suite behavior. Scheduled and standalone workflows remain shadow signals disconnected
from Release.
