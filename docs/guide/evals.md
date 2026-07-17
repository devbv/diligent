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
```

Canonical mode runs every required task against the fixed OpenAI and Anthropic profiles. It rejects task, provider,
model, and effort overrides. Non-canonical runs are for investigation only.

Each run writes a redacted, versioned JSON report to `artifacts/evals/` unless `--report <path>` is supplied. The
report is safe to upload as a CI artifact; it redacts configured API keys and authorization-like values.

## Automation and release policy

The `Core Evals` GitHub workflow runs daily at 06:00 KST and can also be dispatched manually. It is currently a
non-blocking shadow signal. It is intentionally not invoked by the Release workflow until the documented readiness
criteria in [P080](../plan/infra/P080-core-eval-gate.md) have been met and a separate reviewed change enables the
release gate.

The workflow needs both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` repository secrets for canonical runs.
