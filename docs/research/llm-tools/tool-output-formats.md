# Tool Output Format Effects on LLM Performance

## Research Question

When a tool returns results to an LLM, does the format of those results affect model performance? Are models specifically trained on particular tool output formats?

## Executive Summary

**Yes, tool output format significantly affects model performance, and yes, models are specifically trained on particular formats.** The evidence is stronger than expected:

1. **OpenAI explicitly trains GPT-4.1+ on a specific diff format** (V4A) and recommends it in their prompting guide
2. **Anthropic trains Claude on `cat -n` style line-numbered file content** and a specific `str_replace` edit confirmation format
3. **The Diff-XYZ benchmark (NeurIPS 2025 Workshop)** provides the first systematic evidence that diff format choice causes 15-88% performance swings depending on model and task
4. **Each major CLI (Claude Code, Codex, Gemini CLI) uses a different output format** for the same tool types, optimized for their respective models
5. **Aider's extensive benchmarks** show 3x performance differences between edit formats for the same model

## 1. File Content Display Format

### How Each CLI Formats File Content

| CLI | Format | Line Numbers | Truncation |
|-----|--------|-------------|------------|
| **Claude Code** | `cat -n` format (`"  1\tdef foo():"`) | Yes, tab-separated | 2000 lines, 2000 chars/line |
| **Codex CLI** | Plain text via shell commands | No built-in | 256 lines OR 10KiB head+tail |
| **Gemini CLI** | Plain text string | No | 2000 lines, 2000 chars/line |
| **Anthropic API text_editor** | `"1: def foo():"` colon-separated | Yes | Configurable `max_characters` |

### Evidence of Format-Specific Training

**Claude (Anthropic):**
- The official text_editor_20250728 API documentation explicitly shows file content returned with line numbers: `"1: def is_prime(n):\n2:     ..."`
- The documentation states: "Line numbers are not required, but they are essential for successfully using the `view_range` parameter to examine specific sections of files and the `insert_line` parameter to add content at precise locations."
- Claude Code's Read tool description specifies: "Results are returned using cat -n format, with line numbers starting at 1"
- The Edit tool description references the exact format: "preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number format is: spaces + line number + tab."
- **Implication**: Claude has been fine-tuned (via SFT and RLHF) on this specific line number format, including the `str_replace` workflow that follows `cat -n` output

**GPT-4.1+ (OpenAI):**
- The GPT-4.1 Prompting Guide explicitly states the model was "extensively trained" on the V4A diff format
- This format uses **no line numbers** -- it uses context lines for location identification
- The `apply_patch` format uses `*** Begin Patch` markers with `+/-` prefixes but no line number hunk headers
- **Implication**: OpenAI models are trained on context-based rather than line-number-based file addressing

**Gemini (Google):**
- Gemini CLI's `processSingleFileContent()` returns plain text with **no line numbers**
- Truncation metadata is provided separately, not inline with content
- **Implication**: Gemini models appear to work with raw file content without positional metadata

### Does Line Number Format Affect Performance?

**Direct evidence (Diff-XYZ paper, NeurIPS 2025 Workshop):**
- Removing line numbers from unified diff headers (`udiff` vs `udiff-h`) introduces "a distribution shift relative to pretraining corpora"
- Standard `udiff` with line numbers provides "implicit ordering cues that aid model performance"
- However, `search-replace` (no line numbers, context-based) outperforms `udiff` for larger proprietary models

**Indirect evidence (A Method for Line Number Referencing in LLMs, TDCommons):**
- Wrapping lines in XML-style tags with line numbers helps models "more reliably locate, reference, and perform operations on specific lines"
- This suggests line numbers serve as positional anchors that improve editing accuracy

**Practical finding (Aider):**
- Models that use diff-based formats achieve higher completion rates than those using whole-file formats
- But the choice of _which_ diff format matters significantly per model

### Recommendation for Custom Agent

Match the line number format to the model being targeted:
- **For Claude**: Use `cat -n` format (spaces + line number + tab + content)
- **For GPT models**: Skip line numbers; use context-based identification
- **For Gemini**: Use plain text without line numbers
- **Model-agnostic fallback**: Include line numbers in a format like `N: content` -- most models can parse this, and the Diff-XYZ paper shows removing line numbers degrades performance more often than it helps

## 2. Shell Command Output

### How Each CLI Formats Shell Output

**Codex CLI -- Three distinct formats:**

1. **Structured format** (`shell` tool): JSON with explicit fields
   ```json
   {"output": "<stdout>", "metadata": {"exit_code": 0, "duration_seconds": 1.2}}
   ```

2. **Freeform format** (`shell_command` tool): Minimized for token efficiency
   ```
   Exit code: 0
   Wall time: 1.2 seconds
   Output:
   <aggregated stdout+stderr>
   ```

3. **Unified exec format** (`exec_command` tool): For interactive PTY sessions
   ```
   Chunk ID: a1b2c3
   Wall time: 1.2 seconds
   Process exited with code 0
   Original token count: 450
   Output:
   <output>
   ```

**Gemini CLI**: Label-value pairs joined by newlines
```
Output: <stdout or (empty)>
Error: <stderr if present>
Exit Code: <non-zero only>
Signal: <if present>
```

**Claude Code**: Raw stdout captured, truncated at 30,000 characters. No explicit structured wrapper around the output visible in the tool result.

### Does Including Exit Codes Help Error Reasoning?

**Yes, with caveats:**
- Codex's structured format explicitly includes `exit_code` in metadata
- Gemini CLI only includes `Exit Code` for non-zero exits (token optimization)
- Codex had bugs where non-zero exit codes suppressed stdout/stderr (GitHub issue #1367), demonstrating that **the model expects both output AND status together**
- The Codex `freeform` format was created specifically for token efficiency while preserving error context -- only stderr is appended on failure

### Recommendation

- Always include exit code (even 0) for consistency
- Include stderr separately from stdout so the model can reason about errors
- Include duration for timeout detection
- For token efficiency, consider only including stderr on non-zero exit codes (Gemini's approach)

## 3. Search Result Presentation

### How Each CLI Formats Search Results

**Claude Code Grep tool** offers three output modes:
- `files_with_matches` (default): File paths sorted by modification time
- `content`: Matching lines with optional context lines (-A, -B, -C) and line numbers (-n, default true)
- `count`: Match counts per file

**Codex CLI**: Uses shell commands (`rg`, `grep`) -- output is whatever the command produces

**Gemini CLI**: Uses shell commands via `run_shell_command` -- raw tool output

### Does Search Result Format Affect Planning?

**Indirect evidence suggests yes:**
- Claude Code's design defaults to `files_with_matches` mode, giving the model a high-level map before deep-diving -- this supports a "broad then narrow" search strategy
- The Grep tool includes `head_limit` and `offset` for pagination, preventing context window flooding
- Anthropic's engineering blog on evals notes that tool results "can sometimes consume 50,000+ tokens before an agent reads a request" -- controlling search output format directly affects this

### Recommendation

- Default to file-path-only results for initial searches
- Include line numbers in content mode (models are trained on numbered output)
- Provide count mode for estimation before full retrieval
- Always support pagination/limiting

## 4. Error Message Format

### How Each CLI Formats Errors

**Claude Code (Anthropic API text_editor):**
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01...",
  "content": "Error: No match found for replacement. Please provide more context.",
  "is_error": true
}
```
Key design: The `is_error: true` flag signals to the model that this is an error, separate from the error message content.

**Codex CLI:**
- Uses `FunctionCallError::RespondToModel(response)` for recoverable errors
- Timeout errors include the partial output + timeout message
- Sandbox denial errors include the output captured before denial

**Gemini CLI:**
```
Output: (empty)
Error: <error message>
Exit Code: 1
```

### Do Models Recover Differently Based on Error Format?

**Evidence from Aider:**
- Aider's error feedback includes the exact expected format: "The SEARCH section must exactly match an existing block of lines including all white space, comments, indentation, docstrings, etc"
- It suggests potential correct targets from the actual file
- This **specific, actionable error messaging** reduces retry cycles

**Evidence from Codex:**
- The structured JSON format preserves full context even on errors
- Codex issues show that when error handling logic suppressed output, the model could not diagnose problems

**Evidence from Anthropic's eval guide:**
- "Grade what the agent produced, not the path it took" -- suggesting error recovery is less about format and more about content quality

### Recommendation

- Use a structured error format with an explicit error flag/field
- Include actionable context (what was expected vs what was found)
- For edit errors, include nearby content that might match
- Always preserve partial output from failed commands
- Include the error type/category to help the model classify the failure mode

## 5. Diff/Change Confirmation Format

### What Each CLI Returns After a Successful Edit

**Claude Code (Anthropic API text_editor):**
- Returns: `"Successfully replaced text at exactly one location."`
- Minimal confirmation -- does NOT return the changed content or a diff
- The model is expected to already know what it changed (it specified `old_str` and `new_str`)

**Claude Code (internal Edit tool):**
- Returns success/failure status
- On failure: "Found 2 matches of the string to replace, but replace_all is false"

**Codex CLI:**
- `apply_patch` returns success/failure with specific mismatch details on error
- On success: Returns exit code 0 and any patch output

**Aider:**
- "Changes successfully applied" or detailed failure reasons
- Uses fuzzy matching with feedback on what couldn't be matched

**Gemini CLI:**
- Write tool returns success confirmation

### Does Edit Feedback Format Affect Subsequent Edit Quality?

**Evidence from Aider's benchmarks (strongest evidence available):**
- When GPT-4 Turbo used unified diffs (vs search/replace), lazy coding dropped from 12 to 4 out of 20 benchmark tasks (3x improvement)
- "With unified diffs, GPT acts more like it's writing textual data intended to be read by a program, not talking to a person"
- Removing high-level diff prompting caused "30-50% increase in editing errors"
- Disabling flexible patching caused "9X increase in editing errors"

**Evidence from Diff-XYZ benchmark:**
- GPT-4.1 defaults to V4A diff format "by default" -- it has been trained so heavily on this format that it gravitates toward it even without instruction
- Search-replace format achieves 0.96 exact match on Apply (vs 0.81 for unified diff) with GPT-4.1
- Claude 4 Sonnet: 0.97 search-replace vs 0.95 udiff on Apply

### Recommendation

- Return minimal confirmation on success (the model already knows what it changed)
- Return detailed error + context on failure
- Do NOT return the full modified file after edit (wastes tokens, model already has the mental model)
- If multiple edits are planned, a lightweight "edit N of M succeeded" counter may help the model track progress

## 6. Key Academic/Empirical Evidence

### Diff-XYZ Benchmark (Glukhov, NeurIPS 2025 Workshop)

**The most directly relevant academic work found.** Key findings:

| Format | GPT-4.1 Apply | Claude 4 Sonnet Apply | GPT-4.1 Diff Gen |
|--------|---------------|----------------------|-------------------|
| search-replace | **0.96** | **0.97** | **0.92** |
| udiff | 0.81 | 0.95 | 0.83 |
| udiff-h (no line nums) | ~0.80 | ~0.93 | ~0.78 |
| udiff-l (verbose tags) | ~0.60 | ~0.85 | **0.08** (!) |

Critical insight: "Removing line numbers in udiff-h introduces a distribution shift relative to pretraining corpora" -- confirming that models are trained on specific formats.

### Aider Benchmarks (133 Exercism Python exercises)

- Top performers with diff format: o1 (84.2%), Claude 3.5 Sonnet (84.2%)
- Top performers with whole format: Gemini-exp-1206 (80.5%)
- Format compliance: whole format achieves 100% compliance more consistently; diff formats trade some compliance for higher completion

### GPT-4.1 Prompting Guide (OpenAI, 2025)

- Explicit admission: "the model has been extensively trained" on the V4A diff format
- Format uses `*** Begin Patch` / `*** End Patch` markers
- No line numbers -- uses 3 lines of context above and below each change
- Multiple `@@` section markers for nested context (class + method)

### Anthropic SFT for Coding (revealed via engineering blog)

- Claude's training includes "~1,000 coding transcripts from a previous production training run" for SFT initialization
- This teaches "basic formatting including user/assistant roles and reasoning"
- The text_editor tool has had four versions (20241022, 20250124, 20250429, 20250728), each optimized per model generation

## 7. Cross-Cutting Findings

### Format-Training Co-evolution

Each provider has created a tight coupling between their model training and their tool output format:

| Provider | Model | Edit Format | File View Format | Trained On |
|----------|-------|-------------|-----------------|------------|
| **Anthropic** | Claude 4.x | str_replace (exact match) | Line numbers (`N: content`) | str_replace with `cat -n` output |
| **OpenAI** | GPT-4.1+ | V4A patch (context-based) | Shell output (no numbers) | V4A diff format, extensively |
| **Google** | Gemini | Shell commands | Plain text (no numbers) | Standard code corpora |

### The Distribution Shift Problem

The Diff-XYZ paper identifies three mechanisms by which format affects performance:
1. **Global vs local constraints**: Search-replace avoids predicting line numbers, reducing interdependent errors
2. **Header scaffolding**: Line number anchors provide ordering cues
3. **Distribution shift**: Deviating from training format degrades performance

This means: if you use the "wrong" format for a model, you get a performance penalty proportional to how far the format deviates from training data.

### Token Efficiency vs Accuracy Tradeoff

- Codex uses THREE different shell output formats, trading accuracy for token efficiency based on tool type
- Gemini CLI omits exit codes on success (saves tokens)
- Claude Code returns minimal edit confirmations (saves tokens)

The emerging pattern: **structured formats for accuracy-critical operations, minimal formats for routine operations**.

## 8. Implications for Custom Agent Design

### Model-Adaptive Output Formatting

A well-designed agent should format tool outputs differently based on the target model:

```
if model == Claude:
    file_content = cat_n_format(content)      # "  1\tdef foo():"
    edit_result = "Successfully replaced text at exactly one location."
    shell_output = raw_stdout_truncated(30000)

elif model == GPT:
    file_content = plain_text(content)         # No line numbers
    edit_result = json({"exit_code": 0, "output": "patch applied"})
    shell_output = json({"output": stdout, "metadata": {"exit_code": 0}})

elif model == Gemini:
    file_content = plain_text(content)         # No line numbers
    edit_result = "Output: patch applied successfully"
    shell_output = "Output: ...\nExit Code: 0"
```

### If Model-Agnostic (Single Format)

If forced to pick one format:
1. **File content**: Include line numbers (`N: content`) -- most models handle this, and removing line numbers is worse than adding them (Diff-XYZ finding)
2. **Shell output**: Structured with labeled sections (Exit code, stdout, stderr) -- universally parseable
3. **Edit confirmation**: Minimal success message, detailed failure message with context
4. **Search results**: File paths by default, with content+line numbers on demand
5. **Errors**: Structured with error flag, type, message, and actionable context

### Token Budget Awareness

- Set truncation limits based on model context window
- Use head+tail truncation for shell output (Codex approach: first 128 + last 128 lines)
- Provide metadata about truncation (total lines, which lines shown) so the model can request more

## Sources

- [Diff-XYZ: A Benchmark for Evaluating Diff Understanding (NeurIPS 2025 Workshop)](https://arxiv.org/abs/2510.12487)
- [GPT-4.1 Prompting Guide (OpenAI Cookbook)](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide/)
- [Anthropic Text Editor Tool Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)
- [Anthropic Advanced Tool Use Engineering Blog](https://www.anthropic.com/engineering/advanced-tool-use)
- [Aider Edit Formats Documentation](https://aider.chat/docs/more/edit-formats.html)
- [Aider: Unified Diffs Make GPT-4 Turbo 3x Less Lazy](https://aider.chat/docs/unified-diffs.html)
- [Aider Code Editing Leaderboard](https://aider.chat/docs/leaderboards/edit.html)
- [Claude Code System Prompts (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [OpenAI Codex CLI (GitHub)](https://github.com/openai/codex)
- [Gemini CLI (GitHub)](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI Read File Tool Source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/read-file.ts)
- [Gemini CLI Shell Tool Source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shell.ts)
- [Gemini CLI Tools API Documentation](https://google-gemini.github.io/gemini-cli/docs/core/tools-api.html)
- [Code Surgery: How AI Assistants Make Precise Edits (Fabian Hertwig)](https://fabianhertwig.com/blog/coding-assistants-file-edits/)
- [Context Over Line Numbers: A Robust Way to Apply LLM Code Diffs](https://medium.com/@surajpotnuru/context-over-line-numbers-a-robust-way-to-apply-llm-code-diffs-eb239e56283f)
- [A Method for Line Number Referencing in LLMs (TDCommons)](https://www.tdcommons.org/dpubs_series/8606/)
- [CodeEditorBench: Evaluating Code Editing Capability of LLMs](https://arxiv.org/html/2404.03543v1)
- [Codex Tool Output Truncation Issue](https://github.com/openai/codex/issues/6426)
- [Codex Shell Output Formatting (DeepWiki)](https://deepwiki.com/openai/codex/5.2-model-provider-configuration)
- [Anthropic Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Claude Code Internals: Tools Reference](https://kotrotsos.medium.com/claude-code-internals-part-5-tools-reference-d7c9c50eb779)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
