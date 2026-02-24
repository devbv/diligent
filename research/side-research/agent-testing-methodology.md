# Agent Testing Methodology Research

> How to test a coding agent (diligent) using another agent (Claude Code)

## Table of Contents

- [1. Testing Pyramid for AI Agents](#1-testing-pyramid-for-ai-agents)
- [2. CLI Input Testing](#2-cli-input-testing)
- [3. Session State + Multi-turn Testing](#3-session-state--multi-turn-testing)
- [4. Record/Replay (VCR Pattern)](#4-recordreplay-vcr-pattern)
- [5. Agent-as-Judge](#5-agent-as-judge)
- [6. Sandboxed Execution Environments](#6-sandboxed-execution-environments)
- [7. CI/CD Integration](#7-cicd-integration)
- [8. Emerging Approaches](#8-emerging-approaches)
- [9. Applicability to Diligent](#9-applicability-to-diligent)
- [Appendix A: Test Harness Design (Detailed)](#appendix-a-test-harness-design-detailed)
- [Appendix B: Replay & Deterministic Testing (Detailed)](#appendix-b-replay--deterministic-testing-detailed)
- [Appendix C: Observability and Debugging](#appendix-c-observability-and-debugging)
- [Appendix D: Specific Implementations](#appendix-d-specific-implementations)
- [Key Sources](#key-sources)

---

## 1. Testing Pyramid for AI Agents

Block Engineering's 4-layer pyramid is becoming the industry standard:

| Layer | What | Where | Cost |
|-------|------|-------|------|
| **L1: Unit (Mock Provider)** | Mock LLM responses, test deterministic logic | CI, every PR | Free |
| **L2: Record/Replay** | Record real LLM calls, replay for regression | CI, every PR | Free (after 1 recording) |
| **L3: Statistical Benchmark** | Run with real LLM N times, measure pass@k/pass^k | On-demand | $$$ |
| **L4: LLM-as-Judge** | Another model evaluates output quality | On-demand | $$$ |

**Key insight**: ~70% of agent behavior is deterministically testable (tool calls, state transitions, schema compliance). LLM evaluation is only needed for the remaining ~30%.

---

## 2. CLI Input Testing

### 2a. Codex CLI Approach
- `codex exec --json` outputs structured event streams (tool calls, outputs included)
- `--output-schema` enables JSON Schema-based output validation
- GitHub Action for CI integration

### 2b. Aider Approach
- Uses 133 Exercism problems as inputs
- 2-attempt methodology: first attempt, then retry with first 50 lines of test errors on failure
- Isolated execution inside Docker containers

### 2c. General Pattern
```
CLI Agent Test Flow:
1. Set up environment (Docker/sandbox)
2. Load repo snapshot
3. Inject user message (stdin or file)
4. Execute agent + capture full trace
5. Verify results (code execution, test pass, diff check)
```

---

## 3. Session State + Multi-turn Testing

The hardest area. Single input/output pairs cannot capture multi-turn dynamics.

### Approaches:

**A. Simulation-based Testing**
- Configurable user persona converses with the agent
- Provided by Maxim AI, LangWatch Scenario, etc.
- Simulates interruptions, direction changes, ambiguous requests

**B. Hierarchical Evaluation**
- **Session-level**: Did the user achieve their goal?
- **Trace-level**: Was each response appropriate in context?
- **Turn-level**: Accuracy of individual actions

**C. Conversation History Injection**
- Salesforce Agentforce approach: inject pre-constructed conversation history and test the agent's next-turn response
- Enables reproduction of specific session states

---

## 4. Record/Replay (VCR Pattern)

The most practical regression testing method.

### Docker Cagent Implementation
- **Recording**: Proxies to real LLM provider, captures request/response, strips auth headers
- **Replay**: Returns matched responses from cassette files, executes in ms
- YAML cassette files are safe to commit to VCS

### Sakura Sky's 7 Essential Primitives
1. **Structured Execution Trace** (run_id, step_id, kind, input, output)
2. **Stable Model/Tool Metadata**
3. **Replay Engine**
4. **Deterministic Stubs**
5. **Agent Harness with Dependency Injection**
6. **Governance Integration**
7. **Regression Testing Framework**

**Key**: Agent code itself stays unchanged -- only replay stubs are swapped via DI. Divergence during replay signals a real correctness issue.

---

## 5. Agent-as-Judge

### Evolution: LLM-as-Judge -> Agent-as-Judge
- **LLM-as-Judge**: Single LLM call evaluates output (53.3% of teams use it, 70% human agreement)
- **Agent-as-Judge** (ICML 2025): Agentic system with tool use evaluates full trajectory (90% human agreement, 97% cost reduction)

### Anthropic Bloom Framework (Open Source)
4-stage pipeline:
1. **Understanding Agent**: Defines behavior to evaluate
2. **Ideation Agent**: Generates evaluation scenarios
3. **Rollout Agent**: Executes scenarios
4. **Judge Agent**: Scores transcripts + meta-analysis

### LLM-as-Judge Caveats
- Position bias (~40% GPT-4 inconsistency)
- Verbosity bias (~15% inflation)
- Self-preference bias
- **Mitigations**: Use different model for judgment, require chain-of-thought, bidirectional comparison, calibrate on small ground truth set

---

## 6. Sandboxed Execution Environments

| Technology | Used By | Isolation Level | Notes |
|---|---|---|---|
| **Docker 3-layer** | SWE-bench | Container | base -> env -> instance, well-proven |
| **Landlock+seccomp** | Codex CLI (Linux) | OS kernel | Lightweight, no container needed |
| **Seatbelt** | Codex/Claude Code (macOS) | OS kernel | sandbox-exec based |
| **Bubblewrap** | Claude Code (Linux) | Namespace | Blocks .env, SSH keys access |
| **gVisor + K8s** | Google Agent Sandbox | Kernel emulation | For large-scale operations |
| **AppContainer** | Codex (Windows) | Restricted tokens | Token-based isolation |
| **nsjail** | Google (Windmill) | Namespaces+seccomp+cgroups | Full process isolation |

### SWE-bench: Three-Layer Docker Architecture
```
Base Image (common dependencies)
  -> Environment Image (~60 images, Python envs)
       -> Instance Image (specific deps + source code per task)
```
- Cache levels: `env` (~100GB) or `instance` (~2TB)
- Registry compression: 10x reduction (67 GiB for 2290 images)

### Security Note
Shared-kernel sandboxes (bubblewrap, nsjail) are vulnerable to kernel exploits. For maximum security with arbitrary code execution, use fully virtualized environments (VMs, unikernels, Kata containers).

---

## 7. CI/CD Integration

### Recommended Strategy
```
Every PR:     L1 (mock) + L2 (replay) -> fast and free
Nightly:      L3 (statistical) small-scale run
Release:      L3 + L4 full run
Production:   Drift detection (sampling + statistical comparison)
```

### Key Metrics (Anthropic)
- **pass@k**: Probability of at least 1 success in k trials (capability measurement)
- **pass^k**: Probability of all k trials succeeding (reliability measurement)

### Block Engineering's CI Strategy
```
CI Pipeline (every PR):
  |-- Layer 1: Deterministic unit tests (mock providers)
  +-- Layer 2: Record/replay integration tests (fixture files)

On-Demand Benchmarking (separate framework):
  |-- Layer 3: Probabilistic performance benchmarks
  +-- Layer 4: LLM-as-judge evaluations
```

### Key Challenges
1. **Non-determinism**: Same prompt produces different outputs across runs
2. **Cost**: Real LLM calls are expensive; record/replay eliminates cost for repeated runs
3. **Latency**: Full agent runs take minutes; mock providers and replay keep CI fast
4. **Behavioral drift**: Problems emerge gradually at scale, not immediately on deploy
5. **Evaluation complexity**: Multi-step reasoning and tool usage need specialized checks

### Practical Advice
Start with 20-50 real failure cases. Early on, effect sizes are large enough that small samples suffice.

---

## 8. Emerging Approaches

### Meta JiTTesting (2026.02)
- Generates tests on-the-fly for each code change
- Tests are NOT saved to codebase -- zero maintenance cost
- Rule-based + LLM-based ensemble for false positive filtering

### Property-Based Testing (Anthropic)
- Agent infers code properties -> writes Hypothesis tests
- Found 984 bugs across 100+ popular Python packages, 56% verified

### AICL (Agent Interaction Communication Language)
- Standard protocol for inter-agent communication
- Schema-driven, typed messages
- Ensures testability by design

---

## 9. Applicability to Diligent

### Immediate (can apply now):
1. **Mock Provider + Unit Tests**: Test agent's tool dispatch, state management, output parsing deterministically
2. **Record/Replay (VCR)**: Record real sessions -> cassette-based regression tests
3. **CLI harness**: Inject user messages via stdin/file -> capture structured output -> assert

### Medium-term:
4. **Containerized Benchmark**: Docker images with repo snapshots + task definitions -> automated scoring
5. **Multi-turn Simulation**: User persona simulator + conversation history injection
6. **Agent-as-Judge**: Claude Code evaluates diligent's output via trajectory-based analysis

### Long-term / Advanced:
7. **Statistical CI**: pass@k/pass^k tracking with drift detection
8. **Adversarial Testing**: DeepTeam etc. for automated prompt injection and edge case generation
9. **JiT Testing**: Automatic test generation on code changes

---

## Appendix A: Test Harness Design (Detailed)

### Block Engineering's Four-Layer Testing Pyramid

#### Layer 1: Deterministic Foundations (Unit Tests)

Mock LLM providers return canned responses. Tests validate software correctness, not AI quality.

```rust
// Mock provider that always returns an error
impl Provider for ErrorMockProvider {
    async fn complete(...) -> Result<(Message, ProviderUsage), ProviderError> {
        Err(ProviderError::ExecutionError("Simulated failure".into()))
    }
}

// Mock provider that returns simple text
impl Provider for TextOnlyMockProvider {
    async fn complete(...) -> Result<(Message, ProviderUsage), ProviderError> {
        Ok((Message::assistant().with_text("Here's my response"), ...))
    }
}
```

Tested components: retry behavior, max turn limits, tool schema validation, extension management, subagent delegation.

#### Layer 2: Reproducible Reality (Record/Replay)

Captures real LLM and tool interactions, replays them deterministically:

```rust
// Recording: wrap a real provider and capture interactions
let provider = TestProvider::new_recording(real_provider, "fixtures/session.json");
let (response, usage) = provider.complete(system, messages, tools).await?;
provider.finish_recording()?;

// Replaying: no real provider needed, just the fixture file
let provider = TestProvider::new_replaying("fixtures/session.json")?;
let (response, usage) = provider.complete(system, messages, tools).await?;
```

#### Layer 3: Probabilistic Performance (Benchmarks)

- Task completion rates
- Tool selection appropriateness
- "A single run tells us almost nothing but patterns tell us everything"
- Regression = success rates dropped (not output changed)

#### Layer 4: Vibes and Judgment (LLM-as-Judge)

- Run evaluations 3 times with majority voting
- Fourth tie-breaker if all 3 scores differ
- Used for summaries, research, explanations, creative tasks

### LangWatch Scenario: Simulation-Based Testing

Three mocking levels:
1. **Tool Function Mocking**: Patch tool functions, verify LLM extracted correct parameters
2. **API/Service Mocking**: Mock HTTP clients inside tools, keep tool implementation testable
3. **Dependency Injection**: Swappable dependencies from the ground up

Recommended pattern: Real LLM + mocked external dependencies:
```
Agent -> LLM (real) -> Tool Decision -> Mocked Tool/Service
```

### Anthropic's Evaluation Terminology
- **Task**: Single test with defined inputs and success criteria
- **Trial**: One attempt at a task (multiple trials per task for non-determinism)
- **Transcript/Trace**: Complete record including outputs, tool calls, reasoning
- **Outcome**: Final environmental state (e.g., actual DB state, not just agent's claim)
- **Grader**: Logic scoring performance; three types: code-based, model-based, human

---

## Appendix B: Replay & Deterministic Testing (Detailed)

### Docker Cagent: VCR Pattern for AI

**Recording mode:**
- Proxies requests to real AI providers (OpenAI, Anthropic, etc.)
- Captures full request/response cycle
- Normalizes volatile fields (IDs, timestamps)
- Strips sensitive headers (Authorization, X-Api-Key) before saving
- Stores interactions in YAML "cassette" files (safe to commit to VCS)

**Replay mode:**
- Matches incoming requests against cassette recordings
- Serves responses from cache -- no network calls
- Completes in milliseconds
- Blocks all external calls entirely

### Seven Primitives for Deterministic Replay (Sakura Sky)

#### Primitive 1: Structured Execution Trace
Append-only JSONL events:

```python
@dataclass
class TraceEvent:
    run_id: str
    step_id: int      # monotonically incrementing
    timestamp: float
    kind: str          # "llm_call", "tool_call", "decision"
    input: dict
    output: dict
    metadata: dict
```

#### Primitive 2: Stable Metadata
Record model ID, version hash, temperature, top_p, top_k, max_tokens, penalties, tool versions, safety configs.

#### Primitive 3: Replay Engine
```
load_trace() -> sort by step_id -> TraceIndex (group by kind, independent cursors)
```

#### Primitive 4: Deterministic Stubs
- **ReplayLLMClient**: Returns recorded LLM outputs verbatim
- **ReplayToolClient**: Returns recorded tool outputs without touching real services

#### Primitive 5: Agent Harness with Dependency Injection
Same agent code works in both record and replay modes.

#### Primitive 6: Governance Integration
Link traces to audit logs via shared run_id.

#### Primitive 7: Regression Testing
Use historical traces as frozen behavioral baselines.

### Aider Benchmark: SHA-Hash Verification
SHA hashes of all OpenAI API requests/replies detect nondeterminism. Even at temperature=0, API variance is measurable.

---

## Appendix C: Observability and Debugging

### Tracing Platforms

| Platform | Key Feature | Protocol |
|---|---|---|
| LangSmith | Auto-instrumentation of LangChain agents | Proprietary + OTEL |
| Arize Phoenix | OpenTelemetry-native | OTLP |
| Langfuse | Open-source, self-hostable | OTEL |
| AgentOps | Agent-specific session tracking | Proprietary |

### What to Trace (per Anthropic)
- All LLM prompts and responses
- Tool call inputs and outputs
- Reasoning steps and intermediate results
- Error states and recovery attempts
- Environmental state changes (filesystem, DB, etc.)

### Debugging Failed Agent Tests
Common failure causes:
- Ambiguous task specifications
- Graders rejecting valid alternative solutions
- Rigid scaffolding limiting model capabilities
- Stochastic tasks with unreproducible success criteria

### OpenTelemetry as Standard
Both LangSmith and Arize support OTEL -- instrument once, use many backends. Distributed tracing across traces, spans, generations, tool calls, and retrievals.

---

## Appendix D: Specific Implementations

### OpenAI Codex CLI
- **Sandbox**: OS-native (Landlock+seccomp on Linux, Seatbelt on macOS, AppContainer on Windows)
- **Testing**: `codex sandbox <platform>` for sandbox validation; `codex exec --json` for structured event streams
- **CI**: GitHub Action with `--output-schema`
- **Eval**: Deterministic checks + rubric-based grading

### Anthropic's Agent Evaluation
- Three grader types: code-based, model-based, human
- Agent-specific metrics: pass@k and pass^k
- Outcome-based grading (check DB state, not agent's claim)
- Swiss Cheese Model: evals + production monitoring + A/B testing + user feedback + transcript review

### Anthropic's Long-Running Agent Harness
- Two-agent architecture: initializer + coding agent
- Progress tracking via `claude-progress.txt` + git history + `feature_list.json`
- 200+ granular, testable features in JSON with `passes: boolean`
- Browser automation (Puppeteer MCP) for end-to-end verification

### Aider Benchmark System
- **Dataset**: 133 Exercism Python exercises (polyglot: 225 across 6 languages)
- **Methodology**: Two-attempt process
- **Scoring**: Percentage of exercises where all unit tests pass
- **Determinism**: SHA hashes of API requests/replies

### Docker Cagent
- Go-based multi-agent framework with YAML agent definitions
- VCR-pattern session recording with YAML cassettes
- Supports OpenAI, Anthropic, Gemini, and others

### LangWatch Scenario
- Simulation-based testing with LLM-powered user simulators
- Works with LangGraph, CrewAI, Pydantic AI
- MCP support for automatic test generation

### SWE-bench
- Three-layer Docker images (base -> env -> instance)
- 2290 task instances, 67 GiB total registry
- Cloud execution on Modal; `sb-cli` for leaderboard submission

---

## Architecture Patterns Summary

### Pattern 1: Record/Replay (VCR Pattern)
```
[Record Mode]  Agent -> Real LLM -> Real Tools -> Trace/Cassette File
[Replay Mode]  Agent -> Replay Stub -> Replay Stub
```
Used by: Docker Cagent, Block Engineering, Sakura Sky

### Pattern 2: Mock Provider + Real Tools
```
Agent -> Mock LLM (canned responses) -> Real Tool Execution -> Assertions
```
Used by: Block Engineering Layer 1, unit testing

### Pattern 3: Real LLM + Mock Tools
```
Agent -> Real LLM -> Tool Decision -> Mocked Tool -> Assertions
```
Used by: LangWatch Scenario, integration testing

### Pattern 4: Containerized Full-Stack
```
Docker Image (repo snapshot + deps) -> Agent patch -> Apply -> Run tests -> Pass/Fail
```
Used by: SWE-bench, SWE-smith

### Pattern 5: Multi-Trial Statistical
```
Run N trials -> Collect pass/fail -> Compute pass@k / pass^k -> Compare baseline
```
Used by: Anthropic evals, OpenAI evals, benchmarks generally

---

## Key Sources

- [Anthropic: Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Bloom Auto-Evals](https://alignment.anthropic.com/2025/bloom-auto-evals/)
- [Block Engineering: Testing Pyramid for AI Agents](https://engineering.block.xyz/blog/testing-pyramid-for-ai-agents)
- [Agent-as-a-Judge (ICML 2025)](https://arxiv.org/abs/2410.10934)
- [Docker: Deterministic AI Testing with Session Recording in cagent](https://www.docker.com/blog/deterministic-ai-testing-with-session-recording-in-cagent/)
- [Docker Cagent GitHub](https://github.com/docker/cagent)
- [Sakura Sky: Deterministic Replay Primitives](https://www.sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-8/)
- [Meta JiTTesting](https://engineering.fb.com/2026/02/11/developer-tools/the-death-of-traditional-testing-agentic-development-jit-testing-revival/)
- [OpenAI: Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills/)
- [OpenAI Codex Security](https://developers.openai.com/codex/security/)
- [OpenAI Codex Sandbox Docs](https://github.com/openai/codex/blob/main/docs/sandbox.md)
- [OpenAI Harness Engineering](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/)
- [LangWatch Scenario Framework](https://langwatch.ai/scenario/)
- [LangWatch Scenario: Mocking External APIs](https://langwatch.ai/scenario/testing-guides/mocks/)
- [LangWatch Scenario: Testing Tool Calls](https://langwatch.ai/scenario/testing-guides/tool-calling/)
- [Aider Benchmarks](https://aider.chat/docs/benchmarks.html)
- [SWE-bench GitHub](https://github.com/SWE-bench/SWE-bench)
- [SWE-bench Docker Setup](https://www.swebench.com/SWE-bench/guides/docker_setup/)
- [SWE-bench Docker Optimization (Epoch AI)](https://epoch.ai/blog/swebench-docker)
- [Arize Agent Observability](https://arize.com/ai-agents/agent-observability/)
- [LangSmith Observability](https://www.langchain.com/langsmith/observability)
- [NVIDIA: Sandboxing Agentic Workflows](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk)
- [Claude Code Sandboxing Docs](https://code.claude.com/docs/en/sandboxing)
- [Inspect AI](https://inspect.aisi.org.uk/)
- [Attest Framework](https://github.com/attest-framework/attest)
- [Promptfoo](https://github.com/promptfoo/promptfoo)
- [OpenAI Evals GitHub](https://github.com/openai/evals)
- [GKE Agent Sandbox](https://docs.google.com/kubernetes-engine/docs/how-to/agent-sandbox)
