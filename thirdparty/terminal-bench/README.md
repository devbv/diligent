# Harbor external agent evaluations

This package lets [Harbor](https://github.com/harbor-framework/harbor) run the
packaged Diligent CLI in isolated benchmark containers. Despite the historical
directory name, the adapter is not limited to Terminal-Bench. It can run any
Harbor task or dataset whose environment supports the Linux x64 binary.

The integration targets Harbor `0.20.x` and executes the same compiled artifact
that users receive, so it is suitable for external end-to-end regression runs.

## Prerequisites

- Docker running (`docker info`)
- Python 3.12+
- Bun 1.3.14
- A provider credential, such as `ANTHROPIC_API_KEY`

## Setup

From the repository root:

```bash
bun install --frozen-lockfile
bun run build:linux-x64

python3.12 -m venv thirdparty/terminal-bench/.venv
thirdparty/terminal-bench/.venv/bin/pip install -e thirdparty/terminal-bench
```

Rebuild `dist/diligent-linux-x64` after changing Diligent runtime code.

## Quick smoke run

```bash
export ANTHROPIC_API_KEY="..."

thirdparty/terminal-bench/.venv/bin/harbor run \
  --yes \
  --dataset terminal-bench@2.0 \
  --agent diligent_tbench:DiligentAgent \
  --model anthropic/claude-sonnet-5 \
  --include-task-name regex-log \
  --n-tasks 1 \
  --n-concurrent 1 \
  --jobs-dir artifacts/harbor
```

Use `--include-task-name`, not `--task`, to select an item inside a dataset.
`--task` addresses a standalone registry task.

To validate only binary installation and container compatibility without making
a model request, append `--install-only`.

## External benchmark options

These benchmarks cover different end-to-end failure modes. The "other harness"
column identifies a second implementation that can be used for parity checks;
it does not imply identical prompts, budgets, or scores.

| Benchmark | Other agent or harness support | Harbor support | Diligent E2E value |
| --- | --- | --- | --- |
| [Terminal-Bench 2.0](https://github.com/laude-institute/terminal-bench-2) | [JCode runs it through a Harbor adapter](https://github.com/1jehuang/jcode/blob/master/docs/TERMINAL_BENCH.md) | Native dataset and official harness | Strongest first smoke for shell use, package installation, files, and long-running processes |
| [SWE-Bench Verified](https://www.swebench.com/) | [SWE-agent](https://swe-agent.com/latest/usage/benchmarking/), [mini-SWE-agent](https://mini-swe-agent.com/), and [OpenHands](https://github.com/OpenHands/benchmarks) | `swebench-verified` adapter | Best cross-harness coding comparison; realistic but too slow and expensive for every PR |
| [Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark) | Aider's original harness | `aider_polyglot` adapter | Deterministic multi-language editing and tests; useful as a nightly middle tier |
| [GAIA](https://huggingface.co/datasets/gaia-benchmark/GAIA) | [OpenHands benchmarks](https://github.com/OpenHands/benchmarks) | `gaia` adapter | General tool-use coverage, but browsing and mutable external data make it a weaker merge gate |
| [AgentBench](https://github.com/THUDM/AgentBench) | Original AgentBench harness | No maintained first-party Harbor adapter | Broad historical agent coverage, but not the best portable coding-CLI E2E target |
| OSWorld / TheAgentCompany | GUI and workplace-agent harnesses | Harbor adapters exist | Defer until Diligent has a stable browser or desktop interaction contract |

For the current CLI, use this order:

1. Terminal-Bench canaries for packaging and shell/tool smoke coverage.
2. Aider Polyglot canaries for deterministic multi-language editing.
3. SWE-Bench Verified canaries for cross-harness, real-repository regression.
4. GAIA or GUI benchmarks only after their external tool dependencies are part
   of the product contract.

## E2E rollout

Treat external benchmarks as a layered regression suite rather than a single
leaderboard run:

- Pull request: adapter contract tests and an install-only container smoke.
- Manual or nightly: a pinned list of 5-15 Terminal-Bench and Aider Polyglot
  canaries, one attempt each.
- Weekly: a pinned 10-25 task SWE-Bench Verified canary set.
- Release: larger benchmark sweeps with repeated attempts where variance matters.

Pin the Harbor version, dataset version, task names, model, binary commit, timeout,
and container image digest in retained artifacts. Promote a task to a merge gate
only after the oracle passes and the infrastructure failure rate is acceptably
low. Keep infrastructure errors separate from verifier failures.

The manual `External Agent E2E` GitHub workflow implements the first live layer.
It accepts any Harbor dataset and task-name filter and uploads the complete Harbor
job directory for review. It is intentionally not a required pull-request check
because every live run incurs model cost and external benchmark infrastructure
can be flaky.

## Run another Harbor dataset

List published datasets:

```bash
thirdparty/terminal-bench/.venv/bin/harbor datasets list
```

Then replace the dataset and task filter:

```bash
thirdparty/terminal-bench/.venv/bin/harbor run \
  --yes \
  --dataset swebench-verified \
  --agent diligent_tbench:DiligentAgent \
  --model anthropic/claude-sonnet-5 \
  --include-task-name "django__django-*" \
  --n-tasks 1 \
  --n-concurrent 1 \
  --jobs-dir artifacts/harbor
```

Harbor also accepts a local task or composite dataset through `--path`. A small,
repository-owned composite dataset is the preferred eventual pull-request gate
because its task definitions and verifiers can be pinned with the source.

## Authentication and configuration

The model must use Harbor's `provider/model` form. Direct key injection supports:

| Provider | Environment variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Z.AI Coding Plan | `ZAI_API_KEY` |

For ChatGPT OAuth, Vertex, or another preconfigured credential, set
`DILIGENT_AUTH_JSON_PATH` to a local Diligent `auth.jsonc` file.

The adapter never interpolates an API key into a shell command. It writes an
`auth.jsonc` containing an `{env:VARIABLE}` reference and scopes the actual value
to the agent process. A supplied auth file is uploaded directly and installed
with mode `0600`. The generated `config.jsonc` selects the requested provider and
model and forces file-backed credentials inside the disposable container.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| Provider API key | Usually | Credential for the model selected by `--model` |
| `DILIGENT_AUTH_JSON_PATH` | Alternative | Upload an existing auth store instead of injecting an API key |
| `DILIGENT_BINARY_PATH` | No | Override the default `dist/diligent-linux-x64` artifact |
| `DAYTONA_API_KEY` | With `--env daytona` | Daytona cloud environment access |

## How the adapter runs

1. Upload the compiled binary to `/installed-agent/diligent`.
2. Install `ripgrep` through `apk`, `apt-get`, or `yum` when missing.
3. Write isolated Diligent model and auth configuration in the task container.
4. Run `diligent --yolo --prompt ...` in the Harbor task work directory.
5. Copy Diligent session JSONL files into Harbor's agent artifacts and aggregate
   token usage into the trial result.

Harbor-provided MCP servers and skills are translated into Diligent configuration.

## Development verification

```bash
thirdparty/terminal-bench/.venv/bin/pip install -e thirdparty/terminal-bench pytest
thirdparty/terminal-bench/.venv/bin/pytest -q thirdparty/terminal-bench/test
python3.12 -m compileall -q thirdparty/terminal-bench/src
```

## Troubleshooting

### Binary not found

Run `bun run build:linux-x64` or set `DILIGENT_BINARY_PATH` to a Linux x64 build.

### Provider credential missing

Export the environment variable associated with the provider prefix in `--model`,
or set `DILIGENT_AUTH_JSON_PATH`.

### Container architecture or libc mismatch

The packaged artifact currently targets Linux x64. Use an x64, glibc-compatible
task image. An ARM64 or musl-only benchmark image needs a separately built and
selected Diligent artifact.

### Setup timeout

The first run may pull a task image and install `ripgrep`. Increase
`--agent-setup-timeout-multiplier` if the package mirror or runner is slow.
