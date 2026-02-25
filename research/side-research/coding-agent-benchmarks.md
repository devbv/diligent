# Coding Agent Benchmarks Research

> How to measure Diligent's performance against established coding agent benchmarks

Research date: 2026-02-25

## Table of Contents

- [1. Major Coding Agent Benchmarks](#1-major-coding-agent-benchmarks)
  - [1.1 SWE-bench Family](#11-swe-bench-family)
  - [1.2 HumanEval / HumanEval+](#12-humaneval--humaneval)
  - [1.3 MBPP / MBPP+](#13-mbpp--mbpp)
  - [1.4 LiveCodeBench](#14-livecodebench)
  - [1.5 Aider Polyglot Benchmark](#15-aider-polyglot-benchmark)
  - [1.6 BigCodeBench](#16-bigcodebench)
  - [1.7 Commit0](#17-commit0)
  - [1.8 DevBench](#18-devbench)
  - [1.9 Terminal-Bench](#19-terminal-bench)
  - [1.10 Emerging 2025 Benchmarks](#110-emerging-2025-benchmarks)
- [2. How to Plug a Custom Agent into These Benchmarks](#2-how-to-plug-a-custom-agent-into-these-benchmarks)
  - [2.1 SWE-bench Integration](#21-swe-bench-integration)
  - [2.2 HAL Harness](#22-hal-harness)
  - [2.3 Aider Benchmark Integration](#23-aider-benchmark-integration)
  - [2.4 LiveCodeBench Integration](#24-livecodebench-integration)
  - [2.5 EvalPlus Integration](#25-evalplus-integration)
  - [2.6 Lightweight Alternatives](#26-lightweight-alternatives)
- [3. Cost and Infrastructure](#3-cost-and-infrastructure)
  - [3.1 SWE-bench Cost Estimates](#31-swe-bench-cost-estimates)
  - [3.2 Aider Polyglot Cost Estimates](#32-aider-polyglot-cost-estimates)
  - [3.3 Infrastructure Options](#33-infrastructure-options)
- [4. Metrics Beyond Pass Rate](#4-metrics-beyond-pass-rate)
- [5. Practical Recommendation for Diligent](#5-practical-recommendation-for-diligent)
- [Key Sources](#key-sources)

---

## 1. Major Coding Agent Benchmarks

### 1.1 SWE-bench Family

SWE-bench is the dominant benchmark for real-world software engineering agents. Tasks are drawn from real GitHub issues in popular Python repositories; the agent must produce a patch that, when applied, causes the repository's tests to pass.

#### Dataset Variants

| Variant | Size | Notes |
|---|---|---|
| SWE-bench Full | 2,294 tasks | Original. Now superseded. Contains unsolvable instances. |
| SWE-bench Lite | 300 tasks | Curated for self-contained bug fixes. Fast iteration subset. |
| SWE-bench Verified | 500 tasks | **Current standard.** Screened by 93 human developers. Supersedes Lite. |
| SWE-bench Verified Mini | 50 tasks | Random subset of Verified. Cheapest option. |
| SWE-bench Live | 1,319+ tasks | Microsoft/NeurIPS 2025. Continuously updated monthly. 93 repos. |
| SWE-bench Pro | 731 tasks | Scale AI. Long-horizon enterprise complexity. Harder. |
| SWE-bench Bash Only | (subset) | Evaluates bash-only agents; directly comparable to mini-SWE-agent. |

#### Scoring

- **Resolve rate**: percentage of instances where the generated patch causes the failing tests to pass without breaking passing tests.
- Scores are binary per instance: resolved or not.
- Some leaderboards additionally track **Passed Rate** (fraction of fail-to-pass tests per task), **token I/O**, and **cost per resolved task**.

#### Current SOTA (as of early 2026)

On SWE-bench Verified:

| Agent | Score |
|---|---|
| Claude Opus 4.5 + Live-SWE-agent | 79.2% |
| Gemini 3 Pro + Live-SWE-agent | 77.4% |
| Claude 4.5 Opus (mini-SWE-agent) | 74.4% |
| mini-SWE-agent alone | 65% |

On SWE-bench Pro (harder), the best systems score ~45%.

There are growing concerns about contamination: frontier models may have seen Python repo issues in training data, which inflates Verified scores.

#### Difficulty and Cost to Run

Running SWE-bench Verified (500 tasks) requires:
- Docker (each instance runs in an isolated container)
- ~120 GB virtual disk for images
- A machine with 32 cores and 128 GB RAM can complete Verified in ~62 minutes using the Epoch AI optimized image registry
- API costs vary from ~$10 (cheap models) to $1,000+ (top-tier reasoning models) per full Verified run

Verified Mini (50 tasks) is approximately 10x cheaper and faster.

#### Practical Suitability

For a small open-source project, SWE-bench is the most credible comparison benchmark but has high operational complexity. The path of least resistance is SWE-bench Verified Mini (50 tasks) for initial validation, graduating to full Verified once the agent is competitive.

---

### 1.2 HumanEval / HumanEval+

**What it measures**: Function-level Python code generation. Given a docstring and a function signature, the model must generate the function body. 164 problems.

**Scoring**: `pass@1` — fraction of problems solved with a single greedy sample. Top models now score 90%+ on vanilla HumanEval.

**HumanEval+** (EvalPlus): Same tasks, but with 80x more test cases per problem, making it harder to pass with superficially-correct but fragile solutions.

**How to run**: Via the `evalplus` Python package. Does not require Docker for generation, but Docker is recommended for safe execution.

**SOTA**: Near-saturated. Claude Sonnet-4 has only 2 failures out of 164 tasks.

**Practical suitability**: Too easy. HumanEval is saturated and cannot distinguish frontier agents from each other. Useful only as a quick sanity check that the agent can generate correct Python. Not suitable for comparing Diligent to other agents in a meaningful way.

**Not recommended as a primary benchmark.** Use EvalPlus/HumanEval+ if you must use this family.

---

### 1.3 MBPP / MBPP+

**What it measures**: Basic Python programming tasks. The standard evaluation subset uses 378 tasks (MBPP+, from EvalPlus).

**Scoring**: `pass@1`. MBPP+ adds 35x more tests per problem.

**SOTA**: Similarly saturated to HumanEval. 318 out of 378 tasks are solved by every model.

**Practical suitability**: Same limitation as HumanEval — saturated for frontier models. **Not recommended** as a primary benchmark.

---

### 1.4 LiveCodeBench

**What it measures**: Competitive programming problems from LeetCode, AtCoder, and CodeForces, released after a cutoff date to prevent data contamination. Tests code generation, self-repair, test output prediction, and code execution. 1,055 problems as of v6 (May 2023 to April 2025).

**Scoring**: `pass@1` and `pass@5`. Problems are timestamped, allowing evaluation on specific date windows to control for contamination.

**How to run**: Python runner (`lcb_runner`). Supports custom model integration by subclassing `BaseRunner`. Supports OpenAI-compatible APIs. Outputs per-instance results and aggregate metrics.

**SOTA**: Claude Sonnet-4 has the fewest failures among top models; 35 problems unsolvable by any model; 43 solved by all.

**Practical suitability**: Good for testing raw code generation and self-repair capabilities. More contamination-resistant than HumanEval/MBPP. However, competitive programming problems have different characteristics than real-world software engineering tasks. Medium cost. Moderate difficulty to integrate a CLI agent.

---

### 1.5 Aider Polyglot Benchmark

**What it measures**: 225 Exercism coding exercises across 6 languages (C++, Go, Java, JavaScript, Python, Rust). The agent gets two attempts per problem; on failure it sees the unit test output and tries again. Tests both code generation quality and self-correction ability.

**Scoring**: Percentage of 225 exercises solved within 2 attempts. Also tracks **cost per run** (dollar cost for the complete 225-exercise run) — the only mainstream benchmark that prominently reports cost.

**How to run**: Python script in the `aider` repository (`benchmark/benchmark.py`), inside a Docker container. Accepts `--model` and `--read-model-settings` flags, allowing any OpenAI-compatible API endpoint to be plugged in. Custom agent integration requires implementing an agent that responds to the aider benchmark's prompt format.

**SOTA**:

| Agent | Score | Cost/run |
|---|---|---|
| Refact.ai + Claude 3.7 | 93.3% | ~$15-36 |
| GPT-5.1 | 88% | ~$8 |
| DeepSeek V3.2-Exp | 74.2% | ~$1.30 |
| Claude 3.7 Sonnet | ~65% | ~$36 (with extended thinking) |

**Practical suitability**: Excellent for a small project. The cost per run is low (single-digit to low double-digit dollars). The benchmark is polyglot, anti-contamination by nature (Exercism exercises), and tests self-correction ability. The aider harness is designed around aider's own agent loop, so plugging in a custom CLI agent requires a thin adapter layer.

---

### 1.6 BigCodeBench

**What it measures**: 1,140 function-level tasks requiring diverse function calls from 139 real-world libraries (not toy algorithms). Designed as "the next generation of HumanEval." The Hard subset (148 tasks) is far more challenging — only 14 tasks are solved by all models.

**Scoring**: Calibrated `pass@1` with greedy decoding. Test harnesses examine runtime behavior.

**How to run**: `bigcodebench` Python package. Supports multiple backends (OpenAI, Anthropic, vLLM, HuggingFace). Remote evaluation via gradio backend (~6-7 minutes for full, ~4-5 for Hard) or local. Does not have a direct CLI agent interface like SWE-bench.

**SOTA**: 76 out of 148 Hard tasks are consistently failed by all models.

**Practical suitability**: Good for measuring practical code generation capability (real library usage). More signal than HumanEval. However, it tests the LLM directly, not an agentic loop. Not directly applicable to measuring agent-level capabilities like multi-turn tool use.

---

### 1.7 Commit0

**What it measures**: Agents must write entire Python libraries from scratch given an API specification document (text + images) and a starter repo with unit tests. 54 Python libraries covering ML, networking, databases, data visualization, etc.

**Scoring**: Percentage of unit tests passed. Current SOTA passes ~17% on easier libraries and ~6% overall.

**Practical suitability**: Highly aspirational. Requires long-context processing (hundreds of pages of specs) and complex multi-file generation. No current agent can fully reproduce a library. Only recommended for advanced research into long-horizon generation. Very high compute cost.

---

### 1.8 DevBench

Two distinct benchmarks share the "DevBench" name:

**DevBench (comprehensive, 2024)**: 22 curated repos across Python, C/C++, Java, JavaScript. Evaluates software design, environment setup, implementation, acceptance testing, and unit testing stages. GPT-4-Turbo scores less than 10% on repository-level implementation. Very hard and not widely used.

**DevBench (telemetry-driven, 2025)**: 1,800 instances across 6 languages, derived from analysis of over 1 billion real developer interactions. Combines functional correctness, similarity metrics, and LLM-judge assessments. More practically motivated but less established.

**Practical suitability**: Both DevBench variants are high-effort to set up and not widely used for agent comparison. Low practical suitability for Diligent at this stage.

---

### 1.9 Terminal-Bench

**What it measures**: ~89-100 real terminal tasks: compiling repos, training ML models, setting up servers, debugging system configurations. Tasks run inside Docker containers with verification scripts. From Stanford/Laude Institute (Terminal-Bench 2.0, January 2026).

**Scoring**: `pass@1` — did the verification script pass after the agent's work?

**How to run**: Terminus 2 scaffold (single bash terminal tool) is the reference harness. Each task has a Docker environment and a bash verification script.

**SOTA**: Claude Code and DeepAgents CLI both score ~42-45% on Terminal-Bench 2.0.

**Practical suitability**: Highly relevant to Diligent. Diligent has bash, read, write, grep, glob, and edit tools, which map directly to the terminal task space. Terminal-Bench measures the agentic capability of interest (completing real development tasks in a Linux environment) rather than competitive programming puzzles. It is also relatively cheap to run (89 tasks, Docker-based, no LLM judge needed). **This is a strong candidate for Diligent's primary benchmark.**

---

### 1.10 Emerging 2025 Benchmarks

**SWE-EVO** (Dec 2025): Long-horizon software evolution. 48 tasks spanning an average of 21 files, validated against 874 tests per instance. Even GPT-5 achieves only 21% (vs. 65% on Verified). Introduces Fix Rate metric for partial progress. Evaluates via OpenHands or SWE-agent harness.

**FeatureBench** (Feb 2026): 200 feature-development tasks extracted from 24 open-source repos via dependency tracing. Execution-based. Claude Opus 4.5 (74% on Verified) only solves 11% of FeatureBench tasks. Automatically scalable, contamination-resistant.

**GitTaskBench** (Aug 2025): 54 real-world tasks across 7 modalities and 7 domains. Measures both effectiveness (ECR, TPR) and efficiency (token usage, cost, API calls). Introduces the alpha-value metric combining task success, token cost, and developer salary. Integrates with OpenHands, SWE-Agent, and Aider frameworks.

**SWE-bench Live** (NeurIPS 2025, Microsoft): Continuously updated monthly. 1,319 tasks across 93 repos. Lite subset of 300 instances. Reduces contamination risk via recency.

**SWE-rebench**: Decontaminated, dynamic evaluation with timestamps. Tracks cost per problem and tokens per problem.

---

## 2. How to Plug a Custom Agent into These Benchmarks

### 2.1 SWE-bench Integration

SWE-bench separates **patch generation** from **patch evaluation**. The benchmark harness only evaluates whether a patch resolves the issue. The agent generates the patches independently.

**Interface**: Your agent must produce a JSONL file where each line is:

```json
{
  "instance_id": "repo_owner__repo_name-issue_number",
  "model_name_or_path": "your-agent-name",
  "model_patch": "diff --git a/file.py b/file.py\n..."
}
```

**Evaluation harness**:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path predictions.jsonl \
  --max_workers 8 \
  --run_id my_run
```

Each instance is evaluated in a Docker container. Docker must be installed and running.

**For Diligent specifically**: The agent needs to be invoked per instance with the repository checked out and the issue description provided. A Python wrapper script would:

1. For each instance, check out the repo at the correct commit inside a container.
2. Run Diligent's CLI with the issue description as the task prompt.
3. Capture the resulting diff (using `git diff`) as the `model_patch`.
4. Collect all patches into the JSONL file.
5. Run the evaluation harness against the JSONL file.

Diligent's JSONL event stream is useful here: the wrapper script can monitor for the agent's completion event to know when to capture the diff.

**Minimum viable integration**:

```
docker container (SWE-bench repo state)
  └── wrapper.py
        ├── writes issue text to /tmp/task.txt
        ├── runs: bun run diligent --non-interactive < /tmp/task.txt
        ├── captures: git diff > patch.txt
        └── appends to predictions.jsonl
```

**Recommended starting subset**: SWE-bench Verified Mini (50 tasks) during development. Graduate to full Verified (500) for publication-quality results.

**Cloud option**: Modal-based evaluation (`--modal true` flag) is available for running on cloud compute without managing Docker locally.

---

### 2.2 HAL Harness

The **HAL (Holistic Agent Leaderboard)** harness from Princeton provides standardized evaluation across multiple benchmarks including SWE-bench Verified, with built-in cost tracking, trace logging (W&B Weave), and Pareto frontier visualization.

**Repository**: https://github.com/princeton-pli/hal-harness

**Key advantage**: No changes required to the agent code. HAL decouples scaffold implementation from benchmark execution. It accepts any agent exposing a minimal Python API.

**Supported benchmarks**: SWE-bench Verified, USACO, AppWorld, CORE-bench, tau-bench, and more being added.

**Integration**: Define an adapter class that exposes `run(task_description) -> dict` and HAL handles parallel execution, cost tracking, and leaderboard upload.

HAL is the recommended infrastructure layer for any serious benchmarking effort, as it provides cost-performance tradeoff analysis out of the box.

---

### 2.3 Aider Benchmark Integration

The Aider polyglot benchmark runner lives in `benchmark/benchmark.py` in the aider repository. It calls an agent via its model interface.

**Standard usage**: `--model` specifies an LLM name; `--edit-format` specifies how the model edits files (whole-file replacement, diff format, etc.).

**Custom agent integration**: The cleanest approach for Diligent is to wrap it as an OpenAI-compatible API server:

1. Run a local proxy server that translates OpenAI-format requests to Diligent's CLI invocations.
2. Pass the proxy URL via `--read-model-settings` with `base_url: http://localhost:PORT`.
3. The aider benchmark then calls through to Diligent transparently.

Alternatively, fork the benchmark runner and replace the LLM call with a Diligent subprocess invocation. The benchmark provides: a code file with tests failing, the test output on failure, and expects a modified file back.

**Docker**: Always run inside Docker (`benchmark/docker_build.sh` + `benchmark/docker.sh`) because the agent executes untrusted code.

---

### 2.4 LiveCodeBench Integration

LiveCodeBench requires adding a new `LMStyle` entry and subclassing `BaseRunner` for a custom agent.

**Files to modify**:

- `lcb_runner/lm_styles.py`: Register the new model/agent.
- `lcb_runner/runner/custom_evaluator.py`: Custom evaluation logic.
- `lcb_runner/prompts/generation.py`: Prompt format for the new style.

For Diligent, the simplest approach is to serve it behind an OpenAI-compatible API endpoint and use the existing `openai` LMStyle with a custom `base_url`. LiveCodeBench's `--base_url` flag accepts any OpenAI-compatible endpoint.

**Limitations**: LiveCodeBench expects the model to generate code directly, not to run tools. This means LiveCodeBench measures Diligent's LLM generation quality, not its agentic capabilities.

---

### 2.5 EvalPlus Integration

EvalPlus (HumanEval+ and MBPP+) evaluates the LLM's code generation directly. Integration requires providing an OpenAI-compatible endpoint or a vLLM backend.

Since Diligent is a full agent rather than a code-generation model, EvalPlus is more useful as a check on the underlying LLM's capabilities, not Diligent's agent loop. Not a priority integration.

---

### 2.6 Lightweight Alternatives

For continuous benchmarking without the overhead of SWE-bench Docker setups:

**Option A: SWE-bench Verified Mini (50 tasks)**
The cheapest SWE-bench variant. Same Docker infrastructure, same patch format. Run on-demand after significant agent changes.

**Option B: Aider Polyglot (225 tasks)**
$1-$36 per full run depending on model. Tests self-correction. Infrastructure is simpler than SWE-bench (Docker, but no complex image management). Strong community adoption makes comparison easy.

**Option C: Terminal-Bench 2.0 (89 tasks)**
Directly relevant to Diligent's tool set. Docker-based verification scripts. No LLM judge needed. Single-digit task count, so a subset of 10-20 tasks could be used for a fast regression check.

**Option D: Custom mini-benchmark**
Build a small, fixed set of 10-20 coding tasks (real GitHub issues from well-known Python repos) with automated test-based evaluation. Very cheap to run in CI. Limited external comparability, but maximum control.

---

## 3. Cost and Infrastructure

### 3.1 SWE-bench Cost Estimates

Cost depends primarily on model pricing and the number of tokens consumed per task. Token usage grows roughly quadratically with agent turns due to conversation history accumulation.

| Scope | Cheap model (e.g., DeepSeek V3) | Mid-tier (e.g., Claude Sonnet) | Top-tier (e.g., Claude Opus) |
|---|---|---|---|
| Verified Mini (50 tasks) | ~$1-5 | ~$10-50 | ~$100-500 |
| Verified (500 tasks) | ~$10-50 | ~$100-500 | ~$1,000-5,000 |
| Full (2,294 tasks) | ~$50-250 | ~$500-2,500 | $5,000+ |

**Infrastructure**: Epoch AI's public Docker registry reduces SWE-bench Verified to 30 GiB download and 62-minute runtime on a 32-core/128 GB RAM machine (GitHub Actions Large Runner: approximately $1-2/hour). Total infrastructure cost per Verified run is negligible compared to API costs.

**Cloud options**:
- Modal: `pip install modal swebench[modal]` + `--modal true` flag. Pay-per-second compute.
- AWS via `sb-cli`: managed evaluation on AWS infrastructure.
- GitHub Actions: possible with large runners and Epoch AI's image registry.

### 3.2 Aider Polyglot Cost Estimates

| Model | Score | Cost per full 225-exercise run |
|---|---|---|
| DeepSeek V3.2-Exp | 74.2% | ~$1.30 |
| GPT-4.1 | ~53% | ~$8 |
| Gemini 2.5 | ~69% | ~$10 |
| Claude 3.7 Sonnet | ~65% | ~$15 |
| Claude 3.7 Sonnet (extended thinking) | higher | ~$36 |

For a Sonnet-class model, a full polyglot run costs $10-$20. This is viable for regular (weekly) benchmarking.

### 3.3 Infrastructure Options

**Self-hosted (recommended for development)**:
- Local machine with Docker and 16+ GB RAM for Aider Polyglot and Terminal-Bench.
- SWE-bench Verified Mini: Docker + 8+ cores, ~30 GB disk.
- SWE-bench Verified Full: 32 cores, 128 GB RAM, or cloud VM.

**Cloud (recommended for production benchmarks)**:
- Modal: simplest managed option for SWE-bench. Scales to parallelism easily.
- GitHub Actions: Epoch AI's image registry makes Verified feasible on large runners. Good for CI integration.
- AWS via `sb-cli`: official SWE-bench cloud runner.

**Continuous benchmarking strategy**:
- On every PR: run a custom mini-benchmark (10-20 tasks, seconds to minutes, nearly free).
- Weekly/on release: run Aider Polyglot ($10-20, 30-60 minutes).
- On major milestones: run SWE-bench Verified Mini ($10-50, 1-2 hours) or Full ($100-500, 2-4 hours).

---

## 4. Metrics Beyond Pass Rate

The 2025 benchmarking landscape is moving toward multi-dimensional reporting. The following metrics are relevant for Diligent.

### 4.1 Token Efficiency

**Tokens per resolved task**: Total input + output tokens divided by number of resolved tasks. Measures how much context the agent consumes to produce useful work.

**Input/output ratio**: Input tokens dominate cost in agentic systems (conversation history accumulates). Caching can reduce effective input cost significantly.

**Variance**: Token usage can vary 10x between runs on the same task due to agent loop behavior. Report mean and standard deviation.

### 4.2 Turn Efficiency

**Turns per resolved task**: How many agent loop iterations (LLM calls) does the agent need to resolve an issue? Fewer turns means lower latency and cost.

**Turn success rate**: Fraction of tasks resolved within N turns (e.g., pass@3, pass@5, pass@10). This reveals whether the agent tends to give up early or spiral.

**Self-correction rate**: Fraction of initially-failed attempts that succeed on a second try (directly measured by Aider's two-attempt benchmark format).

### 4.3 Cost per Resolved Issue

Dollar cost of API calls divided by number of resolved tasks. The most important operational metric for production use.

The Aider Polyglot benchmark measures this directly. For SWE-bench, calculate it from the per-instance token counts reported by the harness.

### 4.4 Resolve Rate vs. Cost Pareto Frontier

HAL's leaderboard plots this directly: resolve rate on the Y axis, cost per run on the X axis. Agents on the Pareto frontier deliver the best resolve rate for their cost tier. This is more informative than a single number because some agents spend 10-20x more to gain a few percentage points.

### 4.5 Partial Fix Rate

**Fix Rate** (SWE-EVO): Fraction of fail-to-pass tests that the agent's patch manages to fix, even if it doesn't fully resolve the issue. Useful for long-horizon tasks where complete resolution is rare.

**Passed Rate**: Average fraction of fail-to-pass tests passed per task (softer than binary resolved rate). Tracked by some newer leaderboards.

### 4.6 Regression Rate

Fraction of previously-passing tests that the agent's patch breaks. A patch that fixes one test but breaks five others has a negative regression impact. The SWE-bench harness checks this automatically.

### 4.7 Localization Accuracy

Fraction of tasks where the agent correctly identifies the relevant file(s) before attempting a fix. An agent with good file localization but poor code generation has different failure modes than one with the opposite profile. Can be measured separately in a two-phase evaluation.

### 4.8 Time to Resolution

Wall-clock time for the agent to produce a patch, including API latency. Relevant for interactive use cases. Less relevant for offline benchmarking, but worth logging.

### 4.9 Alpha-Value (GitTaskBench)

A composite economic metric: combines task success rate, token cost, and average developer salary to compute the economic ROI of deploying the agent. Less standardized, but captures the practical deployment decision.

### 4.10 Benchmark-Specific Metrics for Diligent's JSONL Event Stream

Because Diligent emits a structured JSONL event stream, all of the above metrics can be computed exactly from session data:

- **Turn count**: Count `turn_start` events.
- **Token usage**: Sum `usage` events across the session.
- **Tool calls**: Count and categorize tool execution events.
- **Wall time**: Timestamp difference between first and last event.
- **Self-correction**: Detect test-fail + re-attempt patterns in bash tool invocations.

This positions Diligent well for rich efficiency reporting that most agents cannot produce.

---

## 5. Practical Recommendation for Diligent

Diligent is a TypeScript/Bun coding agent with a CLI interface, JSONL event stream output, and bash/read/write/glob/grep/edit tools running on Linux.

### 5a. Quick Validation (Low Cost, Easy to Set Up)

**Recommended: Aider Polyglot Benchmark (225 exercises, ~$10-20/run)**

Why:
- Purpose-built for testing coding agents with self-correction.
- Polyglot: exercises in C++, Go, Java, JavaScript, Python, Rust.
- Cost per run is low enough for weekly runs.
- Community adoption is wide; scores are directly comparable to Claude Code, Aider, Refact.ai, and others.
- Docker-based runner is well-documented.
- Does not require managing hundreds of SWE-bench Docker images.

Integration path for Diligent:
1. Run an OpenAI-compatible proxy that forwards requests to Diligent's CLI.
2. Pass the proxy endpoint to the aider benchmark via `--read-model-settings`.
3. Run inside Docker for safety.

Alternatively, fork the aider benchmark runner and replace the LLM call with a subprocess call to Diligent.

**Also recommended: Terminal-Bench 2.0 (89 tasks)**

Why:
- Tasks map directly to Diligent's tool capabilities (bash, file I/O, grep, edit).
- Docker-based with automated verification scripts (no LLM judge).
- Comparable scores against Claude Code, Codex CLI, and OpenHands already published.
- Small task count enables fast iteration.

Integration path:
- Wrap Diligent's CLI as the Terminus 2 scaffold replacement.
- The benchmark's Docker environments and verification scripts work without modification.

### 5b. Meaningful Benchmark Comparison (vs. Claude Code, Aider, etc.)

**Recommended: SWE-bench Verified (500 tasks)**

This is the industry standard. Any serious comparison to Claude Code, Aider, or OpenHands must include Verified scores.

Integration path for Diligent:
1. Write a Python wrapper (`diligent_swebench_agent.py`) that:
   - Accepts a SWE-bench task instance (repo, commit, issue text).
   - Sets up a working directory with the repo at the correct commit.
   - Invokes Diligent CLI: `bun run diligent --non-interactive --task-file issue.txt`
   - Monitors the JSONL event stream for completion.
   - Captures `git diff` as the model patch.
   - Writes to `predictions.jsonl`.
2. Run the evaluation harness: `python -m swebench.harness.run_evaluation`.

**Start with Verified Mini (50 tasks)** during wrapper development. Graduate to full Verified once the integration is validated.

For publication-quality comparison, use the HAL harness, which provides standardized cost tracking and Pareto frontier analysis.

### 5c. Continuous Benchmark Tracking

**Recommended stack**:

| Frequency | Benchmark | Cost | What it tracks |
|---|---|---|---|
| Every PR (CI) | Custom 10-task mini-suite | <$1 | Regression prevention; verifies agent loop is functional |
| Weekly | Aider Polyglot (225 tasks) | $10-20 | Agent quality trend over time; comparable to public leaderboard |
| Per release | SWE-bench Verified Mini (50 tasks) | $10-50 | SE-realistic resolve rate; leaderboard-comparable |
| Major milestone | SWE-bench Verified (500 tasks) | $100-500 | Full benchmark publication-quality result |

**CI integration**:
- Store benchmark results as JSON artifacts in GitHub Actions.
- Track `resolve_rate`, `cost_per_resolved_task`, `mean_turns_per_task`, and `mean_tokens_per_task` over time.
- Use Epoch AI's Docker image registry to keep SWE-bench infrastructure manageable.
- Consider HAL for standardized leaderboard submission once scores are competitive.

**Custom metrics from JSONL event stream**:
Since Diligent already emits structured events, build a lightweight benchmark runner (`packages/e2e` or a new `packages/benchmark` package) that:
1. Runs a set of fixed tasks.
2. Captures the full JSONL event stream per task.
3. Computes turn count, token totals, wall time, and tool usage histograms.
4. Compares against a stored baseline (golden run) in CI.

This internal benchmarking is cheap (only your API costs), runs in CI, and provides far richer diagnostics than any external benchmark.

---

## Key Sources

- [SWE-bench official site and docs](https://www.swebench.com/SWE-bench/)
- [SWE-bench GitHub](https://github.com/SWE-bench/SWE-bench)
- [SWE-bench Leaderboard](https://www.swebench.com/)
- [SWE-bench Evaluation Guide](https://www.swebench.com/SWE-bench/guides/evaluation/)
- [Introducing SWE-bench Verified (OpenAI)](https://openai.com/index/introducing-swe-bench-verified/)
- [HAL Leaderboard](https://hal.cs.princeton.edu/)
- [HAL Harness GitHub](https://github.com/princeton-pli/hal-harness)
- [HAL: SWE-bench Verified Mini](https://hal.cs.princeton.edu/swebench_verified_mini)
- [mini-SWE-agent GitHub](https://github.com/SWE-agent/mini-swe-agent)
- [mini-SWE-agent SWE-bench usage docs](https://mini-swe-agent.com/latest/usage/swebench/)
- [SWE-agent GitHub](https://github.com/SWE-agent/SWE-agent)
- [Live-SWE-agent Leaderboard](https://live-swe-agent.github.io/)
- [SWE-rebench Leaderboard](https://swe-rebench.com/)
- [SWE-bench Verified — Epoch AI](https://epoch.ai/benchmarks/swe-bench-verified)
- [Epoch AI: Run SWE-bench in one hour on one machine](https://epoch.ai/blog/swebench-docker)
- [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os)
- [SWE-bench Live (Microsoft/NeurIPS 2025)](https://github.com/microsoft/SWE-bench-Live)
- [SWE-smith (NeurIPS 2025)](https://github.com/SWE-bench/SWE-smith)
- [Aider LLM Leaderboards](https://aider.chat/docs/leaderboards/)
- [Aider Polyglot Benchmark GitHub](https://github.com/Aider-AI/polyglot-benchmark)
- [Aider Benchmark README](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md)
- [Aider Polyglot — Epoch AI](https://epoch.ai/benchmarks/aider-polyglot)
- [LiveCodeBench official site](https://livecodebench.github.io/)
- [LiveCodeBench GitHub](https://github.com/LiveCodeBench/LiveCodeBench)
- [LiveCodeBench custom_evaluator.py](https://github.com/LiveCodeBench/LiveCodeBench/blob/main/lcb_runner/runner/custom_evaluator.py)
- [EvalPlus GitHub](https://github.com/evalplus/evalplus)
- [EvalPlus Leaderboard](https://evalplus.github.io/leaderboard.html)
- [BigCodeBench GitHub](https://github.com/bigcode-project/bigcodebench)
- [BigCodeBench Leaderboard](https://bigcode-bench.github.io/)
- [BigCodeBench: Next Generation of HumanEval (HuggingFace)](https://huggingface.co/blog/leaderboard-bigcodebench)
- [Terminal-Bench](https://www.tbench.ai/)
- [Terminal-Bench GitHub](https://github.com/laude-institute/terminal-bench)
- [Terminal-Bench paper (arXiv 2601.11868)](https://arxiv.org/html/2601.11868v1)
- [SWE-bench Bash Only](https://www.swebench.com/bash-only.html)
- [Commit0 paper (arXiv 2412.01769)](https://arxiv.org/html/2412.01769v1)
- [DevBench (comprehensive) paper (arXiv 2403.08604)](https://arxiv.org/html/2403.08604v1)
- [SWE-EVO paper (arXiv 2512.18470)](https://arxiv.org/abs/2512.18470)
- [FeatureBench paper (arXiv 2602.10975)](https://arxiv.org/html/2602.10975v1)
- [GitTaskBench paper (arXiv 2508.18993)](https://arxiv.org/abs/2508.18993)
- [GitTaskBench GitHub](https://github.com/QuantaAlpha/GitTaskBench)
- [How coding agents spend tokens (OpenReview)](https://openreview.net/forum?id=1bUeVB3fov)
- [OpenHands Software Agent SDK](https://docs.openhands.dev/sdk)
- [OpenHands GitHub](https://github.com/OpenHands/OpenHands)
- [SWE-bench Lite explanation](https://www.swebench.com/lite.html)
- [Refact.ai 93.3% on Aider Polyglot](https://refact.ai/blog/2025/refact-ai-agent-achieves-93-3-on-aider-polyglot-benchmark/)
- [Benchmarks evaluating LLM agents for software development (Symflower)](https://symflower.com/en/company/blog/2025/benchmarks-llm-agents/)
- [Code generation benchmarks analysis (arXiv 2511.04355)](https://arxiv.org/html/2511.04355v1)
- [Rethinking Coding Agent Benchmarks (Medium, Jan 2026)](https://medium.com/@steph.jarmak/rethinking-coding-agent-benchmarks-5cde3c696e4a)
- [Cost to run SWE-bench Lite (GitHub issue)](https://github.com/aorwall/moatless-tree-search/issues/11)
- [Vals.ai SWE-bench](https://www.vals.ai/benchmarks/swebench)
- [IBM multi-SWE-bench (Java)](https://research.ibm.com/blog/ibm-software-engineering-agent-tops-the-multi-swe-bench-leaderboard-for-java)
