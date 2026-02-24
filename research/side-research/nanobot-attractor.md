# Side Research: nanobot & attractor

Date: 2026-02-23
Repos: https://github.com/HKUDS/nanobot / https://github.com/strongdm/attractor

---

## 1. HKUDS/nanobot

Ultra-lightweight Python AI assistant (~4,000 lines core). Multi-channel (Telegram, Discord, WhatsApp, etc. 9+ platforms). Multi-provider via LiteLLM.

### Agent Loop Structure (`nanobot/agent/loop.py`, 435 lines)

```
while iteration < max_iterations (default 20):
    response = await provider.chat(messages, tools, ...)
    if response.has_tool_calls:
        append assistant message
        for tool_call in response.tool_calls:
            result = await tools.execute(...)
            append tool result
        continue
    else:
        final_content = response.content
        break
```

**Key characteristics:**
- **Not a state machine** — simple while loop with only 2 branches (tool calls vs. final response)
- **Sequential tool execution** — no parallel execution
- **Error → string** — all tools catch exceptions and return error strings; LLM decides how to handle
- **No streaming** — waits for full response before processing
- **Iteration cap** — max_iterations=20 prevents infinite loops

### Notable Patterns

| Pattern | Description | Implications for Us |
|---------|-------------|---------------------|
| **Message Bus** | Two asyncio.Queue instances (inbound/outbound) fully decouple channels from agent | I/O layer and agent core separation pattern |
| **Provider Registry** | Declarative ProviderSpec dataclass for provider matching (keyword, prefix, etc.) | Declarative registry instead of if-elif chains |
| **LLM-powered memory consolidation** | When session exceeds memory_window, LLM is given a save_memory tool to summarize | Delegating memory management to the LLM itself |
| **Background subagents** | Independent asyncio tasks, restricted tool set (no spawn/message), results via bus | Subagents need tool restrictions + depth limits |
| **Prompt caching injection** | Provider layer auto-injects cache_control (Anthropic) transparently | Handle within provider abstraction layer |
| **Shell safety guard** | Regex-based dangerous command blocking + workspace restriction + 10K char output truncation | Execution environment safety measures |
| **Think-tag stripping** | Removes `<think>...</think>` blocks (for DeepSeek-R1 etc.) | Needed for multi-provider support |

### Limitations
- No parallel tool execution
- No streaming (waits for full response)
- Single-message sequential processing (no concurrent requests)
- No LLM error retry (error message becomes the final response)

---

## 2. strongdm/attractor

**Not code but 3 NLSpec (Natural Language Specification) documents.** Designed to be fed to AI agents to generate the system.

Three specs:
1. **`unified-llm-spec.md`** — Multi-provider unified LLM client
2. **`coding-agent-loop-spec.md`** — Core coding agent loop (most relevant)
3. **`attractor-spec.md`** — DOT-based pipeline orchestrator

### Agent Loop Spec — Core Design

#### State Machine (4 states)
```
IDLE -> PROCESSING          (on submit)
PROCESSING -> PROCESSING    (tool loop continues)
PROCESSING -> AWAITING_INPUT (model asks a question)
PROCESSING -> IDLE          (completion or turn limit)
PROCESSING -> CLOSED        (unrecoverable error)
any -> CLOSED               (abort signal)
AWAITING_INPUT -> PROCESSING (user provides answer)
```

#### Core Loop Pseudocode
```
1. Append user input to history
2. Drain steering queue
3. LOOP:
   - Check limits (round/turn limit, abort signal)
   - Build LLM request (system prompt + history + tools)
   - Client.complete() (NOT SDK's generate() — need fine-grained control)
   - Record assistant turn
   - If no tool calls -> BREAK
   - Execute tool calls (parallel if supported)
   - Drain steering messages
   - Loop detection check
4. Process follow-up queue or -> IDLE
```

### Most Notable Design Decisions

#### A. Provider-Aligned Toolsets
Each LLM family gets **native tool format**:
- **OpenAI** -> `apply_patch` (v4a diff format)
- **Anthropic** -> `edit_file` (old_string/new_string)
- **Gemini** -> gemini-cli mirror

> "The initial base for each provider should be a **1:1 copy** of the provider's reference agent — the exact same system prompt, the exact same tool definitions, **byte for byte**."

**Implication:** Provider-optimized tools and prompts outperform generic abstractions.

#### B. Low-Level LLM Calls
Uses `Client.complete()` directly instead of SDK's `generate()` (built-in tool loop). Reasons:
- Output truncation needed between tool executions
- Steering injection needed
- Event emission needed
- Timeout enforcement needed
- Loop detection needed

**Implication:** Agent loop must be implemented below the SDK's high-level API for fine-grained control.

#### C. Two-Queue Steering
- **`steer(message)`** — injected between tool rounds (mid-task redirection)
- **`follow_up(message)`** — triggers next cycle after current processing completes

**Implication:** Need a mechanism for external intervention into the running agent loop.

#### D. Two-Phase Output Truncation
1. **Character-based** (always first) — head/tail split
2. **Line-based** (secondary) — for readability

| Tool | Chars | Lines | Mode |
|------|-------|-------|------|
| read_file | 50,000 | - | head_tail |
| shell | 30,000 | 256 | head_tail |
| grep | 20,000 | 200 | tail |
| glob | 20,000 | 500 | tail |

**Key:** Event stream receives **full output**, LLM receives **truncated output**. Host app always has complete data.

**Implication:** Character-first truncation handles edge cases like a 2-line 10MB file. Line-based alone is insufficient.

#### E. Loop Detection
Tracks (name + args hash) signatures of recent N tool calls (default 10). Detects repeating patterns of length 1, 2, or 3 and injects a warning SteeringTurn.

#### F. Execution Environment Abstraction
All tool operations pass through an `ExecutionEnvironment` interface:
- Local, Docker, Kubernetes, WASM, RemoteSSH
- Process group spawn, SIGTERM -> 2s -> SIGKILL
- Environment variable filtering (`*_API_KEY`, `*_SECRET` excluded)

#### G. System Prompt 5 Layers
```
1. Provider-specific base instructions (lowest priority)
2. Environment context (platform, git, cwd, date)
3. Tool descriptions (active profile)
4. Project-specific docs (AGENTS.md, CLAUDE.md, etc.)
5. User instructions override (highest priority)
```
Project doc discovery: walks git root to cwd, loads only files matching active provider. Total budget: 32KB.

#### H. Unified LLM Client — Native API Requirement
Uses each provider's **native API** directly instead of compatibility shims:
- OpenAI: Responses API (`/v1/responses`) — NOT Chat Completions
- Anthropic: Messages API (`/v1/messages`)
- Gemini: Gemini API (`/v1beta/.../generateContent`)

Reason: Shims lose access to reasoning tokens, extended thinking, prompt caching, and other provider-specific features.

---

## 3. Comparison Summary

| Aspect | nanobot | attractor |
|--------|---------|-----------|
| **Nature** | Working implementation (Python) | NLSpec design documents |
| **Loop structure** | Simple while + branch | State machine (4 states) |
| **Tool execution** | Sequential only | Parallel supported |
| **LLM calls** | LiteLLM unified (shim) | Native API direct (rejects shims) |
| **Provider tools** | Universal tool set | Provider-aligned (format-optimized) |
| **Steering** | None | steer() + follow_up() 2-queue |
| **Loop detection** | None (iteration cap only) | Pattern matching on signatures |
| **Truncation** | Shell output 10K chars | Two-phase (char->line), per-tool limits |
| **Streaming** | Not supported | Not mentioned (complete()-based) |
| **Memory** | LLM-powered consolidation | Not mentioned |
| **Subagent** | Background asyncio tasks | Independent sessions, depth-limited |

---

## 4. Gap Analysis vs Main Research

Cross-referenced all 12 findings against main research (layers/*, decisions.md D001-D078, cycle1-review.md).

### Already Covered (7 of 12)

| # | Finding | Where Covered |
|---|---------|---------------|
| 2 | Low-level LLM calls | D003 (roll own streaming), L0 provider research |
| 5 | Event stream vs LLM output separation | D020 (output vs metadata), D025 (temp file for full), D071 (progress events) |
| 6 | Steering queue | L1 research "Steering: The Key Differentiator", D009, D011 |
| 10 | LLM-powered memory consolidation | D037/D038 (LLM-based compaction with structured templates) |
| 11 | Background subagent + restricted tools | D062-D064 (TaskTool pattern, agent types, permission isolation) |
| 12 | Shell safety guard | D027 (rule-based permission), L4 approval research |
| 7 | Message Bus pattern | D004 (Op/Event pattern) — similar concept; multi-frontend bus not explored but not needed for MVP (D046) |

### True Gaps (4 findings with missing nuance)

#### Gap A: Provider-specific tool definitions and system prompts (Finding 1)

**What main research has**: Provider-native API calls (D003), provider-specific message transforms (D026 deferred).

**What's missing**: The concept that different providers should receive **different tool definitions and system prompts** tailored to what the model was fine-tuned on:
- OpenAI models -> `apply_patch` (v4a diff format)
- Anthropic models -> `edit_file` (old_string/new_string)
- Each provider -> system prompts matching its reference agent ("byte-for-byte copy")

**Why it matters**: If a model was fine-tuned on a specific tool format, using a different format degrades performance. The current design assumes a universal tool set for all providers.

**Action**: Consider a `ToolProfile` per provider at the L0/L2 boundary. At minimum, record this as a design consideration for when multi-provider support is implemented.

#### Gap B: Two-phase truncation — character-first pipeline (Finding 3)

**What main research has**: D025 specifies "2000 lines OR 50KB" auto-truncation. Pi-agent's `truncateHead`/`truncateTail` with line and byte limits documented.

**What's missing**: The explicit **two-phase pipeline** where:
1. Character-based truncation always runs first (safety net against pathological cases)
2. Line-based truncation runs second (readability pass)

Also missing: **per-tool differentiated limits** (read_file=50K chars, shell=30K, grep=20K, glob=20K).

**Why it matters**: A file with 2 lines but 10MB per line passes a 2000-line limit but produces massive output. Character-first truncation prevents this. Per-tool limits optimize context usage (grep results need less space than file reads).

**Action**: Refine D025 to specify character-first as phase 1, line-based as phase 2. Add per-tool limit table.

#### Gap C: Multi-length loop pattern detection (Finding 4)

**What main research has**: D031 specifies "same tool called with same input 3 times in a row" (length-1 pattern only, window of 3).

**What's missing**: Detection of **repeating patterns of length 2 and 3** over a larger window:
- Length 1: A-A-A (already covered)
- Length 2: A-B-A-B-A-B (NOT covered)
- Length 3: A-B-C-A-B-C-A-B-C (NOT covered)
- Window: last 10 tool call signatures (name + args hash)

**Why it matters**: The LLM can get stuck in oscillating patterns. Example: read_file -> edit_file (fail) -> read_file -> edit_file (fail) — a length-2 loop that D031 would miss entirely.

**Action**: Enhance D031 to include multi-length pattern detection (1, 2, 3) over a sliding window of N=10 recent tool calls.

#### Gap D: Unified Execution Environment abstraction (Finding 9)

**What main research has**: Per-tool `Operations` interfaces from pi-agent (D026, deferred). Each tool defines its own `BashOperations`, `ReadOperations`, etc.

**What's missing**: A **unified `ExecutionEnvironment` interface** that ALL tools pass through, supporting swappable environments (Local, Docker, Kubernetes, WASM, RemoteSSH) with shared:
- Process group lifecycle (SIGTERM -> 2s -> SIGKILL)
- Environment variable filtering (`*_API_KEY`, `*_SECRET` excluded)
- Filesystem context

**Why it matters**: For containerized execution, all tools need the same execution context. A unified interface is simpler than per-tool `Operations`. The per-tool approach risks inconsistent behavior when tools need the same environment switch.

**Action**: Record as an alternative to per-tool Operations for future consideration. Not needed for local-only MVP, but important for remote/container execution.

### Minor Gaps (not actionable now)

| # | Finding | Status | Note |
|---|---------|--------|------|
| 8 | Provider registry (declarative) | Partially covered | Registry exists (D014 for tools); declarative data-driven specs are a minor variation, easily accommodated |

---

## 5. Summary

**7 of 12** findings were already well covered by main research.
**4 true gaps** identified (A-D), each with actionable recommendations.
**1 minor gap** (declarative registry) — not architecturally significant.

Priority ordering for gap resolution:
1. **Gap C** (multi-length loop detection) — low cost to enhance D031, high value for robustness
2. **Gap B** (char-first truncation) — low cost to refine D025, prevents pathological edge cases
3. **Gap A** (provider-specific tools/prompts) — significant design consideration, record now, implement with multi-provider
4. **Gap D** (unified ExecutionEnvironment) — future consideration, not MVP
