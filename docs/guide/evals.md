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

Use `--provider` to run one provider or `--task` to run one task. Without those filters, the command always runs every
task against both default provider profiles. `--model` selects one compatible model. `--seed` reconstructs fixture
values; it does not make model output deterministic. Reports are written under `artifacts/evals/` unless `--report` is
given.

The core suite contains `direct-response`, `single-tool`, `tool-chain`, `recover-tool-error`, `structured-tool-args`,
`parallel-tools`, and `image-tool-result`. `image-tool-result` checks provider transport of multiple image blocks from
an in-memory tool without runtime or filesystem behavior. All profiles use medium effort. A complete run requires both
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; a provider-filtered run requires only its selected credential.

The runtime suite contains `project-fix`, `plan-readonly`, `skill-guided-change`, `session-resume`, and these extended
runtime scenarios:

- `plan-to-execute` checks plan-to-default mode transition and implementation handoff;
- `knowledge-recall` checks exact project-knowledge prompt recall;
- `knowledge-update` checks stable-id search followed by an in-place durable preference update;
- `manual-compaction-resume` checks manual compaction, server restart, and exact context continuation;
- `clarify-then-execute` checks scripted user clarification followed by a default-mode file outcome;
- `read-image-pair` checks two seed-swapped workspace image files, `read_image` event evidence, exact color
  attribution, and base64-free reporting;
- `collaboration-delegation` checks one bounded child read, parent wait, linked child session, and exact parent write;
- `file-roundtrip` checks an ordered workspace-file read, overwrite, confirmation read, and exact persisted result.

## Runtime evidence and isolation

Every runtime task/profile execution receives a fresh temporary project, fresh runtime state, and fresh app server.
The runner records normalized protocol notifications, core events, actor-attributed tool traces, parent and child
session JSONL, workspace manifests, and verifier output. Image evidence retains media metadata while raw base64 is
omitted. Deterministic code evaluates this allowlisted evidence; no LLM judge is used.

The tool transformer runs after runtime mode filtering. It removes undeclared capabilities, confines paths to the
fixture, rejects symlinks and non-exact shell commands, records bounded traces, and stops over-budget calls before the
underlying tool executes. The runner constructs fixture-owned `RuntimeConfig` values and does not load host config,
credentials, skills, agents, knowledge, or sessions.

`packages/e2e` contains deterministic protocol and runtime integration tests only. Live provider conversation, tool
recovery, image transport, shell, and file behavior are owned by the core and runtime eval suites.

## Shadow status

Core evals run every task daily at 06:00 KST. Runtime evals run every task daily at 06:30 KST. Both workflows share a
sequential `model-evals` concurrency group, and both remain manual/daily signals disconnected from Release. A manual
workflow dispatch may filter to one task or provider; leaving filters empty preserves the complete-suite behavior.
