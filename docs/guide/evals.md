# Core Evals

`packages/evals` runs live-model behavioral evaluations against `@diligent/core`. It is deliberately separate from
`packages/e2e`: E2E tests are deterministic protocol/runtime tests, while evals execute real provider models and
evaluate normalized messages, events, tool traces, and isolated task state with deterministic code.

## Run an eval

Set credentials for the selected provider, then run one of the following commands:

```bash
bun run eval core --canonical
bun run eval core --provider anthropic
bun run eval core --task tool-chain
bun run eval core --task structured-tool-args
bun run eval core --task parallel-tools
```

Canonical mode runs every required task against the fixed OpenAI and Anthropic profiles. It rejects task, provider,
model, and effort overrides. Non-canonical runs are for investigation only.

Each run writes a redacted, versioned JSON report to `artifacts/evals/` unless `--report <path>` is supplied. The
report is safe to upload as a CI artifact; it redacts configured API keys and authorization-like values.

## Core task tiers

The canonical core suite remains the four stable tasks: `direct-response`, `single-tool`, `tool-chain`, and
`recover-tool-error`. Candidate tasks are available through an explicit `--task` filter:

- `structured-tool-args` verifies nested objects, enums, arrays, booleans, exact values, and tool-result feedback.
- `parallel-tools` requires three independent function calls in one parallel batch and verifies concurrent execution.

Scheduled runs execute candidate tasks against both canonical provider profiles after the canonical suite. Candidate
failures are uploaded for investigation but remain non-blocking while their cross-provider stability is observed.

## Automation and release policy

The `Core Evals` GitHub workflow runs daily at 06:00 KST and can also be dispatched manually. It is currently a
non-blocking shadow signal. It is intentionally not invoked by the Release workflow until the documented readiness
criteria in [P080](../plan/infra/P080-core-eval-gate.md) have been met and a separate reviewed change enables the
release gate.

The workflow needs both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` repository secrets for canonical runs.
