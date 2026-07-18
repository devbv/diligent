# Live eval suites

Diligent keeps live-model behavioral evaluations in the private `@diligent/evals` package. They are separate from
deterministic unit and end-to-end tests and never run as part of the default `bun test` command.

## Suites

- `core` evaluates provider normalization and the generic agent loop in isolated in-memory worlds.
- `runtime` evaluates prompt assembly, mode-specific tools, project instructions, skills, sessions, and workspace
  effects through an in-process `DiligentAppServer` and `RpcClientSession` connection.

Run the complete manifests with:

```bash
bun run eval core --canonical
bun run eval runtime --canonical
```

Use `--provider`, `--task`, or `--model` only for non-canonical investigation. `--seed` reconstructs fixture values;
it does not make model output deterministic. Reports are written under `artifacts/evals/` unless `--report` is given.

The canonical core manifest contains `direct-response`, `single-tool`, `tool-chain`, and `recover-tool-error`.
`structured-tool-args`, `parallel-tools`, and `image-tool-result` remain explicit candidate tasks and run as
non-blocking scheduled investigations. `image-tool-result` checks provider transport of multiple image blocks from an
in-memory tool without runtime or filesystem behavior. All profiles use medium effort. Canonical mode requires both
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; a filtered investigation requires only its selected provider credential.

The canonical runtime manifest contains `project-fix`, `plan-readonly`, `skill-guided-change`, and
`session-resume`. Runtime candidates are available only through an explicit non-canonical `--task` investigation:

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

Core evals run daily at 06:00 KST. Their release-gate readiness criteria remain documented in P080. Runtime V0 runs
daily at 06:30 KST. Both workflows share a sequential concurrency group, and both remain manual/daily non-blocking
shadow signals disconnected from Release. Runtime promotion requires the readiness window and deliberate failure
checks in P083, followed by a separate reviewed workflow change.
