# Agentic Prompting Patterns: Transferability Across LLMs

**Research question**: Are system prompts and behavioral instructions for coding agents model-specific or transferable across LLMs? Beyond `edit_file`, do we need model-specific SYSTEM PROMPTS for optimal agent performance?

**Date**: 2026-02-24

---

## 1. The Three Major Pattern Sets

### 1.1 OpenAI's Agentic Patterns (GPT-4.1, GPT-5, Codex)

Source: [GPT-4.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide/), [GPT-5 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide), [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide/)

**Three core agentic reminders** (GPT-4.1, carried forward to GPT-5):

1. **Persistence**: "You are an agent — please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user."
2. **Tool-calling**: "If you are not sure about file content or codebase structure pertaining to the user's request, use your tools to read files and gather the relevant information: do NOT guess or make up an answer."
3. **Planning**: "You MUST plan extensively before each function call, and reflect extensively on the outcomes of the previous function calls."

These three instructions alone increased GPT-4.1's internal SWE-bench Verified score by ~20% (from baseline to 55% solve rate).

**GPT-5 evolution**: GPT-5 is "intrinsically thorough" — persistence prompts need *softening* to avoid redundant tool usage. Conflicting instructions impair GPT-5's reasoning more severely than GPT-4.1. The planning instruction becomes: "Always begin by rephrasing the user's goal, then immediately outline a structured plan."

**Codex CLI (GPT-5.1/5.2)** prompt evolution across versions shows progressive refinement:
- GPT-5 base prompt: generic 3-reminder pattern
- GPT-5.1-codex-max: leaner, adds `rg` preference, `apply_patch` specifics, frontend design guidance
- GPT-5.2: adds explicit "Autonomy and Persistence" section, plan status management rules, review mindset, preamble message patterns

Key Codex-specific patterns: "proactively gather context, plan, implement, test, and refine without waiting"; bias toward action over clarification; tool preambles for user progress updates.

### 1.2 Anthropic's Agentic Patterns (Claude Code)

Source: [Claude 4 Best Practices](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices), [Context Engineering for Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), Claude Code system prompt analysis

**Core behavioral instructions**:
- "Be concise, direct, and to the point"
- "Answer with fewer than 4 lines unless detail requested"
- Detailed tool routing: "Use Read instead of cat", "Use Edit instead of sed", "Use Grep instead of grep"
- Safety: reversibility assessment before destructive actions, "NEVER run destructive git commands unless explicitly requested"
- Parallel tool calling encouraged with explicit guidance
- Context awareness: model tracks remaining token budget

**Claude 4.6-specific adaptations**:
- Opus 4.6 over-explores — guidance needed to constrain: "Choose an approach and commit to it. Avoid revisiting decisions."
- Over-prompting tools that undertriggered in earlier models now causes *overtriggering* in 4.6
- Subagent overuse — 4.6 "has a strong predilection for subagents" and may spawn them unnecessarily
- Previous "CRITICAL: You MUST use this tool when..." can be replaced with "Use this tool when..."
- Adaptive thinking replaces manual budget_tokens

**Architecture**: Single-loop ReAct with compaction, sub-agent orchestration (Agent Teams), structured state via JSON files and git.

### 1.3 Google's Agentic Patterns (Gemini CLI)

Source: [Gemini CLI system prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Google/Gemini-cli%20system%20prompt.md), [Gemini 3 Prompting Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide)

**Core lifecycle**: Understand -> Plan -> Implement -> Verify

**Key patterns**:
- "Explain Before Acting": brief explanation before filesystem-modifying commands (not all tool calls)
- "Inquiries vs Directives": if asked "how to do X", explain; if told "do X", proceed after planning
- Conciseness: "fewer than 3 lines of text output per response"
- No preambles ("Okay, I will now...") or postambles
- Parallel tool calls for independent searches
- Context efficiency: glob/search_file_content before reading files, never assume library availability
- save_memory used sparingly for user-specific facts only
- Absolute paths required; avoid interactive commands

**Planning mode**: For new apps, propose high-level summaries before implementation. For existing code, share "extremely concise yet clear" plans.

**Blog analysis** ([fsck.com](https://blog.fsck.com/2025/06/26/system-prompts-for-cli-coding-agents/)): Gemini CLI's prompt structure shows "striking structural resemblance" to Claude Code's, including similar example patterns and response formatting — suggesting convergent evolution or intentional borrowing.

---

## 2. Cross-Model Transferability: The Evidence

### 2.1 Academic Research: PromptBridge (Dec 2025)

Source: [PromptBridge: Cross-Model Prompt Transfer](https://arxiv.org/html/2512.01420v1)

**The "Model Drifting" problem is real and quantified**:
- GPT-5's optimal prompt achieved 99.39% on itself but only 68.70% on Llama-3.1-70B — a 30+ point absolute loss
- GPT-4o -> o3 transfer: 92.27% vs o3's achievable 98.37% (even within the same vendor!)
- SWE-Bench Verified (o4-mini -> o3): direct transfer 33.40% vs PromptBridge 46.00%

**Root causes of non-transferability**:
1. Different training corpora and linguistic distributions
2. Different tokenization schemes
3. Different role tags (e.g., Llama 3's `ipython` role absent from GPT)
4. Different human-feedback criteria (RLHF vs CAI/RLAIF)
5. Different alignment and interface conventions

**Notable gap**: Claude and Gemini were NOT included in the primary PromptBridge experiments. The study focused on OpenAI models + open-source (Llama, Qwen, Gemma).

### 2.2 Practical Evidence: Aider's Model-Specific Configuration

Source: [Aider advanced model settings](https://aider.chat/docs/config/adv-model-settings.html)

Aider — a model-agnostic coding agent — maintains **extensive per-model configuration**:

| Setting | Claude | GPT | Gemini |
|---------|--------|-----|--------|
| Edit format | `diff`, `editor-diff` | `diff`, `udiff`, `architect` | `diff-fenced` |
| System prompt | Yes | Yes (with prefix for o3/o4) | Yes |
| System prompt disabled | Never | o1-mini, o1-preview | Never |
| Behavioral flags | `overeager` (3.7 Sonnet) | `lazy` (GPT-4 turbo) | `overeager` (variants) |
| Reasoning tag | N/A | N/A for base, `think` for reasoning | N/A |
| Examples as system msg | Yes (newer Claude) | Varies | No |

This is strong empirical evidence that the same prompting strategy does NOT produce optimal results across models — Aider's maintainers found they needed model-specific tuning after extensive testing.

### 2.3 SWE-bench Harness Differences

Source: [SWE-bench evaluations](https://www.vals.ai/benchmarks/swebench)

SWE-bench measures the entire agent system, not just the model. The harness — including prompts, tools, parsing, memory, and context management — plays a "crucial role" in performance. Different labs optimize their harnesses specifically for their models.

Tool usage patterns vary significantly: o4 Mini uses search tools more heavily, while Claude Sonnet 4 shows a more balanced approach across tool categories. These differences emerge from model-specific behavioral tendencies that system prompts must account for.

### 2.4 Community Evidence

Source: [OpenAI Developer Community](https://community.openai.com/t/the-portability-of-a-llm-prompt/311147)

Community consensus:
- Prompts with **in-context examples are most portable**: "every prompt is 100% portable when a few examples are included"
- Smaller models (<100B params) require more careful per-model engineering
- **Extraction tasks** transfer more easily than **generative tasks**
- OpenAI models appear "more forgiving" of prompt variations than alternatives
- No formal studies on prompt portability in the agentic coding domain specifically

### 2.5 Tau-2 Benchmark: Cross-Model Prompt Optimization

Source: [Quesma blog](https://quesma.com/blog/tau2-benchmark-improving-results-smaller-models/)

A prompt rewrite improved GPT-5-mini from 55% to 67.5% (22.73% improvement) on a telecom agent benchmark. The technique: use Claude (a frontier model) to analyze and rewrite agent policies to be "easier to follow for an agent using a faster, non-flagship LLM." Key: simplifying language, reducing ambiguity, breaking reasoning into explicit steps. This shows prompts optimized for one model need transformation for others.

---

## 3. Pattern-by-Pattern Transferability Analysis

### 3.1 Persistence Instructions ("Keep Going")

| Pattern | OpenAI | Anthropic | Google | Transferable? |
|---------|--------|-----------|--------|--------------|
| Core instruction | "keep going until resolved" | "complete tasks fully, even if budget approaching" | "fulfill request thoroughly, including reasonable follow-up actions" | **Largely universal** |
| Model-specific tuning | GPT-5 needs *softer* persistence | Claude 4.6 naturally persistent, needs constraint | Gemini 3 needs less prompting than 2.x | Yes, but intensity varies |
| Escape hatch | "Never stop when uncertain — research or deduce" | "Never artificially stop any task early" | "Do not take significant actions beyond clear scope without confirming" | Different philosophies |

**Verdict**: The core concept of persistence is **universal** — all three vendors independently converged on it. But the **calibration differs by model generation**. Newer, more capable models (GPT-5, Claude 4.6, Gemini 3) tend to be naturally persistent and may need *dampening*, while earlier models needed *encouragement*.

### 3.2 Conciseness Instructions

| Pattern | OpenAI | Anthropic | Google |
|---------|--------|-----------|--------|
| Target | "very concise, no more than 10 lines" | "fewer than 4 lines unless detail requested" | "fewer than 3 lines of text output" |
| No preambles | Varies by model version | Not explicit but implied | "No preambles or postambles" |
| Progress updates | Yes, preamble messages 8-12 words | Summary after tool calls optional | Output only when communicating |

**Verdict**: Conciseness is **universal** but the threshold varies. All three converge on "be brief by default, elaborate when asked." This pattern likely transfers well across models because it constrains output rather than requiring model-specific capabilities.

### 3.3 Tool Usage Instructions

| Pattern | OpenAI | Anthropic | Google |
|---------|--------|-----------|--------|
| Prefer tools over guessing | "do NOT guess or make up an answer" | "Never speculate about code you have not opened" | "never assume library availability — verify" |
| Tool routing | Use `apply_patch`, prefer `rg` over `grep` | Use `Read` not `cat`, `Edit` not `sed`, `Grep` not `grep` | "prefer grep over individual file reads", use absolute paths |
| Parallel calls | Encouraged in GPT-5 | Explicit guidance for ~100% rate | "use parallel tool calls for independent searches" |
| File editing | `apply_patch` diff format | `Edit` with old_string/new_string | save changes via tools |

**Verdict**: Tool preference instructions are **harness-specific, not model-specific**. They depend on what tools are available, not what model is running. The patterns "use tools instead of guessing" and "read before writing" are universal. But the specific routing rules (e.g., "Use Edit not sed") reflect the agent harness architecture, not model capabilities.

**Key insight**: Pi-agent (our reference) demonstrates this well — it dynamically constructs tool-usage guidelines based on which tools are actually available:
```typescript
if (hasRead && hasEdit) {
    guidelinesList.push("Use read to examine files before editing. You must use this tool instead of cat or sed.");
}
```
This is harness-level configuration, not model-level.

### 3.4 Planning/Reasoning Instructions

| Pattern | OpenAI | Anthropic | Google |
|---------|--------|-----------|--------|
| When to plan | Non-trivial, multi-step tasks | Complex multi-step reasoning, long-horizon | New apps get upfront plans, existing code gets concise plans |
| How to plan | `update_plan` tool with step tracking | Adaptive thinking (model decides depth) | Tool restrictions in plan mode |
| Reflect on outcomes | "reflect extensively on outcomes of previous function calls" | "After receiving tool results, carefully reflect on quality" | Implied in Verify phase |
| Model switching | N/A (single model) | Sonnet for planning, Opus for execution (older pattern) | N/A |

**Verdict**: Planning instructions are **partially transferable**. The concept of "plan before complex tasks, skip for simple ones" is universal. But the *mechanism* differs:
- OpenAI: explicit planning tool + mandatory reflection text
- Anthropic: adaptive thinking (model self-regulates depth)
- Google: lifecycle-based (Understand -> Plan -> Implement -> Verify)

The GPT-4.1 finding that explicit planning prompting added 4% to SWE-bench suggests planning instructions provide model-agnostic value, but the optimal format may differ.

### 3.5 Safety and Reversibility

| Pattern | OpenAI | Anthropic | Google |
|---------|--------|-----------|--------|
| Destructive actions | "NEVER use destructive commands unless requested" | "Consider reversibility and potential impact" | "Remind users of sandboxing for critical modifications" |
| Git safety | Don't revert user changes, don't amend commits | Never force push, never skip hooks | Respect user cancellations |
| Confirmation | Based on approval mode (never/on-failure/untrusted) | Based on action reversibility | Most tool calls require user confirmation |

**Verdict**: Safety principles are **universal** in concept but vary in implementation. The "measure twice, cut once" philosophy appears everywhere. The specific git safety rules (don't force push, don't revert user changes, don't skip hooks) are **universal good practices** not tied to any model.

---

## 4. What Is Model-Specific vs. What Is Universal

### 4.1 Definitively Universal Patterns

These patterns appear across all three vendors and transfer well:

1. **Persistence** — complete the task before yielding (calibrate intensity per model)
2. **Use tools instead of guessing** — read files rather than hallucinating content
3. **Be concise by default** — elaborate only when requested
4. **Plan for complex tasks, skip for simple ones** — some form of structured planning
5. **Safety guardrails** — confirm before destructive actions, don't revert user changes
6. **Parallel tool calling** — execute independent operations simultaneously
7. **Read before writing** — understand context before making changes
8. **Progress updates** — keep the user informed during long operations
9. **Minimal changes** — be surgical, don't over-engineer
10. **Verify your work** — run tests, check formatting after changes

### 4.2 Model-Specific Calibration Required

These patterns exist universally but need per-model tuning:

1. **Eagerness/laziness calibration**: GPT-4 turbo is lazy (needs encouragement), Claude 3.7 and Gemini variants are overeager (need constraints), GPT-5 is intrinsically thorough (needs softening)
2. **Tool trigger thresholds**: Claude 4.6 overtriggers on aggressive "MUST use" language that was needed for older models. GPT-4.1 undertriggers without strong reminders.
3. **Thinking/reasoning depth**: Claude uses adaptive thinking, GPT uses reasoning summaries, Gemini has Deep Think mode — different mechanisms require different prompt strategies
4. **Verbosity defaults**: Claude 4.6 is more concise naturally, previous models needed explicit constraints
5. **Instruction sensitivity**: GPT-5 is more sensitive to conflicting instructions than GPT-4.1; Claude 4.6 is more responsive to system prompts than 4.5

### 4.3 Definitively Harness-Specific (Not Model-Specific)

These patterns depend on the agent architecture, not the LLM:

1. **Tool routing rules** ("Use Edit not sed") — depends on available tools
2. **Edit format** (`apply_patch` vs `old_string/new_string` vs `diff-fenced`) — depends on harness implementation
3. **Plan tool format** — depends on whether `update_plan` or `TaskCreate` or inline planning is used
4. **File path rules** ("absolute paths required") — depends on harness design
5. **Output format** ("plain text styled by CLI", "no inline citations") — depends on rendering engine
6. **Memory/context management** ("save_memory sparingly") — depends on available memory tools
7. **AGENTS.md / CLAUDE.md discovery** — depends on agent harness file convention

---

## 5. Key Findings and Implications

### Finding 1: The ~80/20 Rule of Prompt Transferability

Approximately 80% of agentic prompt content is universal (persistence, tool use, planning, safety, conciseness). The remaining ~20% requires model-specific calibration (eagerness thresholds, reasoning mechanisms, instruction sensitivity). This aligns with the PromptBridge finding that prompt transfer within the same vendor (GPT-4o -> o3) loses ~6% performance, while cross-vendor transfer can lose 30+%.

### Finding 2: Edit Format Is the #1 Non-Transferable Element

Aider's per-model configuration data proves this conclusively. The way an LLM formats file edits (whole file, unified diff, search/replace, patch format) is the single most model-dependent aspect. This is not just a tool format issue — it reflects how each model was trained on code editing examples. Our prior research (task #15) on model-specific tool format dependencies is validated here.

### Finding 3: Newer Models Converge on Behavioral Norms

GPT-5, Claude 4.6, and Gemini 3 all share similar behavioral tendencies: more naturally persistent, more eager to use tools, more prone to over-engineering. The prompting challenge is shifting from "encourage the model to act" to "constrain the model from overacting." This suggests that as models improve, the universal portion of prompts grows and the model-specific portion shrinks.

### Finding 4: All Three Vendors Converged on the Same Architecture

Despite independent development, all three major coding agents use:
- Single-agent ReAct loop (think -> tool -> observe -> repeat)
- Similar tool sets (read, edit, bash, search)
- Similar system prompt structure (role -> capabilities -> guidelines -> tools -> safety)
- Similar behavioral principles (persistence, conciseness, read-before-write, verify work)

This convergence suggests these are fundamental engineering patterns for coding agents, not arbitrary vendor choices.

### Finding 5: The "Explain Why" Principle Is Universal

All three vendors independently discovered that explaining *why* an instruction exists improves compliance:
- OpenAI: "This ensures the model understands it is entering a multi-message turn"
- Anthropic: "Your response will be read aloud by a text-to-speech engine, so never use ellipses" (from Claude 4 best practices)
- Google: Context efficiency mandates come with rationale

This is a meta-pattern: prompt instructions that include their motivation transfer better than bare directives.

---

## 6. Recommendations for Our Agent

### 6.1 System Prompt Architecture

Design the system prompt in layers:

```
Layer 1: Universal Core (~70% of tokens)
  - Persistence instruction
  - Tool-over-guessing principle
  - Conciseness defaults
  - Safety guardrails
  - Read-before-write
  - Planning heuristics
  - Progress update rules

Layer 2: Harness-Specific (~20% of tokens)
  - Available tool descriptions and routing
  - Edit format instructions (model-dependent!)
  - File path conventions
  - Output format requirements
  - Plan tool API
  - Memory/context tool API

Layer 3: Model-Specific Calibration (~10% of tokens)
  - Eagerness/laziness tuning
  - Thinking/reasoning configuration
  - Instruction sensitivity adjustments
  - Known behavioral quirks
```

### 6.2 Model-Specific Prompt Variants

At minimum, maintain per-model overrides for:

1. **Edit format instructions** (critical — largest performance impact)
2. **Eagerness calibration** (encourage lazy models, constrain eager ones)
3. **Tool trigger language** ("MUST use" vs "Use when appropriate")
4. **Reasoning/thinking guidance** (adaptive thinking vs explicit reflection)

### 6.3 Implementation Approach

```typescript
interface SystemPromptConfig {
  // Layer 1: Universal (shared across all models)
  universalCore: string;

  // Layer 2: Harness-specific (shared, depends on available tools)
  toolGuidelines: string;  // dynamically built from tool registry
  outputFormat: string;

  // Layer 3: Model-specific calibration
  modelOverrides: Record<string, {
    editFormatInstructions: string;
    eagernessCalibration: string;
    reasoningGuidance: string;
    behavioralTuning: string;
  }>;
}
```

This mirrors pi-agent's approach of dynamically constructing guidelines based on available tools, extended with a model-specific calibration layer.

### 6.4 The Answer to the Key Question

**"Beyond edit_file, do we need model-specific SYSTEM PROMPTS for optimal agent performance?"**

**Yes, but only partially.** The system prompt should be ~80% universal, ~10% harness-specific, and ~10% model-specific. The model-specific portion is small but has outsized impact, particularly for:

1. **Edit format** (the single highest-impact model-specific element)
2. **Eagerness calibration** (2-5% benchmark impact based on OpenAI data)
3. **Instruction intensity** ("MUST" vs "should" — matters for Claude 4.6 vs older models)

A model-agnostic prompt will "work" but leave 5-15% performance on the table compared to a tuned prompt. Whether that matters depends on the use case. For a SWE-bench competitor, every percent matters. For a general-purpose coding assistant, the universal core may suffice with minimal per-model tuning.

---

## 7. Sources

- [GPT-4.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide/)
- [GPT-5 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide/)
- [Claude 4 Prompting Best Practices](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices)
- [Effective Context Engineering for AI Agents (Anthropic)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Gemini CLI System Prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Google/Gemini-cli%20system%20prompt.md)
- [Gemini 3 Prompting Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide)
- [PromptBridge: Cross-Model Prompt Transfer](https://arxiv.org/html/2512.01420v1)
- [System Prompts for CLI Coding Agents (fsck.com)](https://blog.fsck.com/2025/06/26/system-prompts-for-cli-coding-agents/)
- [Aider Advanced Model Settings](https://aider.chat/docs/config/adv-model-settings.html)
- [Tau-2 Benchmark: Prompt Rewrite Results](https://quesma.com/blog/tau2-benchmark-improving-results-smaller-models/)
- [OpenAI Community: Portability of LLM Prompts](https://community.openai.com/t/the-portability-of-a-llm-prompt/311147)
- [SWE-bench Evaluations](https://www.vals.ai/benchmarks/swebench)
- Codex CLI prompts: `research/references/codex-rs/codex-rs/core/prompt.md` (GPT-5 base), `gpt-5.1-codex-max_prompt.md`, `gpt_5_2_prompt.md`
- Pi-agent system prompt: `research/references/pi-agent/packages/coding-agent/src/core/system-prompt.ts`
