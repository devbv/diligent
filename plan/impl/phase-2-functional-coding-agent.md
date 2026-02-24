# Phase 2: Functional Coding Agent

## Goal

The agent can read, edit, and search a codebase — not just run bash commands. It handles LLM API errors gracefully with retry logic, and renders its responses as formatted markdown with a spinner during tool execution.

## Prerequisites

- Phase 1 artifact: Interactive CLI agent with bash tool, working Anthropic streaming, 15 AgentEvent types defined (D004), EventStream (D007), Tool/ToolContext/ToolResult interfaces (D013, D016, D020), ToolRegistryBuilder (D014), sequential executor (D015).
- `rg` (ripgrep) installed as a system dependency (D072). Used by glob and grep tools.
- All Phase 1 tests passing (`bun test`).

## Artifact

A coding agent that can read files, edit code, search codebases, and handle API errors. Markdown-formatted output with spinners during work.

**Demo 1 — Code change across files:**
```
diligent> find all TODO comments and list them

I'll search for TODO comments across the codebase.

⠹ Searching with grep...

[tool: grep] pattern: "TODO" → 5 matches

Found 5 TODO comments:
1. `src/config.ts:12` — TODO: validate config schema
2. `src/agent/loop.ts:89` — TODO: add compaction trigger
...

diligent> fix the typo in config.ts line 12 — "shcema" should be "schema"

I'll read the file and fix the typo.

⠹ Reading config.ts...

[tool: read] src/config.ts

⠹ Editing config.ts...

[tool: edit] old: "shcema" → new: "schema"

Fixed the typo on line 12. Here's the diff:
```diff
- // TODO: validate config shcema
+ // TODO: validate config schema
```
```

**Demo 2 — Bug fix workflow:**
```
diligent> there's a bug in the event handler — it doesn't handle tool_update events

⠹ Searching for event handler...

[tool: grep] pattern: "handleAgentEvent" → 1 match in tui/app.ts

⠹ Reading tui/app.ts...

[tool: read] packages/cli/src/tui/app.ts

I can see the `handleAgentEvent` method handles `message_delta`, `tool_start`,
`tool_end`, and `error`, but **doesn't have a case for `tool_update`**. Let me add it.

⠹ Editing tui/app.ts...

[tool: edit] Added tool_update case to handleAgentEvent

**Fixed.** The handler now displays partial tool output during execution.
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L0 (Provider) | +retry | Error classification (retryable/rate-limit/overflow), retry-after header parsing, exponential backoff wrapper |
| L1 (Agent Loop) | +full | Emit status_change during retry, emit usage/cost after each turn, exponential backoff retry, improved abort |
| L2 (Tool System) | +trunc | Auto-truncation in executor (50KB/2000 lines), truncation utilities, progress callback wiring |
| L3 (Core Tools) | +all 7 | Add read, write, edit, glob, grep, ls (bash already exists) |
| L7 (TUI) | +md+spin | Markdown rendering via `marked`, braille spinner during tool execution |

**Not touched:**
- L4 (Approval) — still auto-approve all. Permission UI requires overlays from Phase 4
- L5 (Config) — still env-based. Full JSONC deferred to Phase 3
- L6 (Session) — still in-memory. Persistence deferred to Phase 3
- L8 (Skills), L9 (MCP), L10 (Multi-Agent) — Phase 5

---

## File Manifest

### packages/core/src/tool/

| File | Action | Description |
|------|--------|-------------|
| `truncation.ts` | CREATE | `truncateHead()`, `truncateTail()`, `shouldTruncate()`, temp file persistence |
| `executor.ts` | MODIFY | Add auto-truncation after tool execution (D025) |
| `types.ts` | MODIFY | Add `truncateDirection` field to ToolResult |

### packages/core/src/tools/

| File | Action | Description |
|------|--------|-------------|
| `read.ts` | CREATE | Read tool — offset/limit, binary detection, line numbers (D023) |
| `write.ts` | CREATE | Write tool — create parent dirs, overwrite content |
| `edit.ts` | CREATE | Edit tool — exact string replacement, single-occurrence guard, unified diff (D018, D024) |
| `glob.ts` | CREATE | Glob tool — ripgrep `--files --glob`, mtime sort, 100 file limit (D022) |
| `grep.ts` | CREATE | Grep tool — ripgrep `-n`, regex/literal, include filter, context lines (D022) |
| `ls.ts` | CREATE | Ls tool — alphabetical sort, dir markers, 500 entry limit |
| `index.ts` | CREATE | Barrel export for all tool factories |

### packages/core/src/provider/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | MODIFY | Add `ProviderError` class with `isRetryable`, `retryAfterMs`, `errorType` |
| `anthropic.ts` | MODIFY | Classify SDK errors into `ProviderError`, parse retry-after headers |
| `retry.ts` | CREATE | `withRetry()` wrapper — exponential backoff around StreamFunction (D010) |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|-------------|
| `loop.ts` | MODIFY | Wire retry via `withRetry()`, emit `status_change` and `usage` events |

### packages/cli/src/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | MODIFY | Register all 7 tools, add `marked` dependency |

### packages/cli/src/tui/

| File | Action | Description |
|------|--------|-------------|
| `markdown.ts` | CREATE | `renderMarkdown(text: string, width: number): string` — marked + ANSI styling (D047) |
| `spinner.ts` | CREATE | `Spinner` class — braille animation, configurable message (D049) |
| `app.ts` | MODIFY | Use markdown renderer for assistant output, show spinner during tool execution, handle all tool event types |

### packages/core/test/

| File | Action | Description |
|------|--------|-------------|
| `tool-truncation.test.ts` | CREATE | Truncation: head/tail, threshold check, temp file persistence |
| `tools-read.test.ts` | CREATE | Read: offset/limit, binary detection, line numbering, missing file |
| `tools-write.test.ts` | CREATE | Write: create file, overwrite, parent dir creation |
| `tools-edit.test.ts` | CREATE | Edit: exact match, single-occurrence guard, no-match error, diff output |
| `tools-glob.test.ts` | CREATE | Glob: pattern matching, file limit, mtime sort |
| `tools-grep.test.ts` | CREATE | Grep: regex, literal, include filter, context, match limit |
| `tools-ls.test.ts` | CREATE | Ls: sort, dir markers, entry limit, missing dir |
| `provider-retry.test.ts` | CREATE | Retry: exponential backoff, retry-after, non-retryable bypass, max attempts |
| `agent-loop-retry.test.ts` | CREATE | Loop retry: status_change emission, usage emission, abort during retry |

### packages/cli/test/

| File | Action | Description |
|------|--------|-------------|
| `tui-markdown.test.ts` | CREATE | Markdown: headers, code blocks, bold/italic, links |
| `tui-spinner.test.ts` | CREATE | Spinner: animation frames, message update, start/stop |

---

## Implementation Tasks

### Task 1: Truncation Utilities + Auto-Truncation in Executor

**Files:** `tool/truncation.ts`, `tool/executor.ts`, `tool/types.ts`, `test/tool-truncation.test.ts`
**Decisions:** D025

Build the truncation infrastructure that all tools will rely on.

```typescript
// tool/truncation.ts

/** Truncation constants */
export const MAX_OUTPUT_BYTES = 50_000;   // 50KB
export const MAX_OUTPUT_LINES = 2_000;

export interface TruncationResult {
  output: string;
  truncated: boolean;
  originalBytes: number;
  originalLines: number;
  savedPath?: string;          // temp file with full output
}

/** Keep the first N lines / N bytes (for file reads — beginning is most relevant) */
export function truncateHead(
  output: string,
  maxBytes?: number,
  maxLines?: number,
): TruncationResult;

/** Keep the last N lines / N bytes (for bash — recent output is most relevant) */
export function truncateTail(
  output: string,
  maxBytes?: number,
  maxLines?: number,
): TruncationResult;

/** Check if output exceeds limits */
export function shouldTruncate(output: string): boolean;

/** Save full output to temp file, return path */
export async function persistFullOutput(output: string): Promise<string>;
```

```typescript
// tool/types.ts — add to ToolResult
interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
  truncateDirection?: "head" | "tail";  // NEW: hint for auto-truncation. Default: "tail"
}
```

Auto-truncation in executor: after `tool.execute()` returns, check `shouldTruncate(result.output)`. If true, apply truncation using the result's `truncateDirection` (default `"tail"`), persist full output to temp file, and inject truncation metadata.

> Auto-truncation is a safety net. Individual tools may do their own truncation for UX reasons (e.g., read tool returns first 2000 lines), but the executor enforces the hard limit to prevent context overflow (D025).

**Verify:** `bun test tool-truncation` — truncation at both byte and line limits, temp file contains full output.

---

### Task 2: File Tools — read, write, edit

**Files:** `tools/read.ts`, `tools/write.ts`, `tools/edit.ts`, `test/tools-read.test.ts`, `test/tools-write.test.ts`, `test/tools-edit.test.ts`
**Decisions:** D013, D017, D018, D021, D023, D024

Three file operation tools. Each follows the same pattern: Zod schema, `Tool` interface implementation, error-as-content.

#### read

```typescript
// tools/read.ts
import { z } from "zod";
import type { Tool } from "../tool/types.js";

const ReadParams = z.object({
  file_path: z.string().describe("The absolute path to the file to read"),
  offset: z.number().int().min(1).optional()
    .describe("Line number to start reading from (1-indexed). Only provide for large files"),
  limit: z.number().int().positive().optional()
    .describe("Maximum number of lines to read. Default: 2000"),
});

export function createReadTool(): Tool<typeof ReadParams> {
  return {
    name: "read",
    description: "Read a file from the filesystem. Returns file contents with line numbers.",
    parameters: ReadParams,
    async execute(args, ctx) {
      // 1. Check file exists (return helpful error if not)
      // 2. Binary detection: check extension + sample first 4KB for null bytes (D023)
      //    - If binary: return "Binary file (N bytes). Cannot display contents."
      // 3. Read file content
      // 4. Apply offset/limit (default: first 2000 lines)
      // 5. Prepend line numbers: "   1\t<content>"
      // 6. Return with truncateDirection: "head"
    },
  };
}
```

**Binary detection (D023):** Check extension against known binary list (`.png`, `.jpg`, `.wasm`, `.zip`, etc.). If extension is ambiguous, sample first 4KB — if >30% of bytes are null or non-printable, treat as binary.

**Line numbering format:** Match `cat -n` format — right-aligned line numbers with tab separator. This is what LLMs expect from training data.

#### write

```typescript
// tools/write.ts
const WriteParams = z.object({
  file_path: z.string().describe("The absolute path to the file to write"),
  content: z.string().describe("The full content to write to the file"),
});

export function createWriteTool(): Tool<typeof WriteParams> {
  return {
    name: "write",
    description: "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing content.",
    parameters: WriteParams,
    async execute(args, ctx) {
      // 1. Create parent directories recursively (Bun.write handles this? If not, mkdir -p)
      // 2. Write content to file
      // 3. Return: "Wrote N bytes to <path>"
    },
  };
}
```

#### edit

```typescript
// tools/edit.ts
const EditParams = z.object({
  file_path: z.string().describe("The absolute path to the file to edit"),
  old_string: z.string().describe("The exact string to find and replace. Must match exactly."),
  new_string: z.string().describe("The replacement string"),
});

export function createEditTool(): Tool<typeof EditParams> {
  return {
    name: "edit",
    description: "Replace an exact string in a file. The old_string must appear exactly once in the file.",
    parameters: EditParams,
    async execute(args, ctx) {
      // 1. Read file content
      // 2. Find old_string — exact match
      // 3. Single-occurrence guard: count matches
      //    - 0 matches: error "old_string not found in file"
      //    - 2+ matches: error "old_string found N times — provide more context to make it unique"
      // 4. Replace the single occurrence
      // 5. Write file
      // 6. Generate unified diff (4 context lines)
      // 7. Return diff as output
    },
  };
}
```

**Unified diff generation:** Use a simple diff helper — find the replacement location, extract surrounding context lines, format as standard unified diff. No external dependency needed for exact replacement diffs.

**Verify:** `bun test tools-read tools-write tools-edit` — read with offset/limit, binary detection rejects PNG, write creates parent dirs, edit single-occurrence guard rejects ambiguous matches.

---

### Task 3: Search & Discovery Tools — ls, glob, grep

**Files:** `tools/ls.ts`, `tools/glob.ts`, `tools/grep.ts`, `test/tools-ls.test.ts`, `test/tools-glob.test.ts`, `test/tools-grep.test.ts`
**Decisions:** D017, D022, D072

Three tools for navigating and searching codebases. Glob and grep use ripgrep as the backend (D022).

#### ls

```typescript
// tools/ls.ts
const LsParams = z.object({
  path: z.string().describe("The directory path to list"),
});

export function createLsTool(): Tool<typeof LsParams> {
  return {
    name: "ls",
    description: "List directory contents. Shows files and subdirectories with type indicators.",
    parameters: LsParams,
    async execute(args, ctx) {
      // 1. Readdir with file types
      // 2. Sort alphabetically (case-insensitive)
      // 3. Append "/" suffix for directories
      // 4. Cap at 500 entries
      // 5. Return one entry per line
    },
  };
}
```

#### glob

```typescript
// tools/glob.ts
const GlobParams = z.object({
  pattern: z.string().describe("Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.test.ts')"),
  path: z.string().optional().describe("Directory to search in. Default: current working directory"),
});

export function createGlobTool(cwd: string): Tool<typeof GlobParams> {
  return {
    name: "glob",
    description: "Find files matching a glob pattern. Returns file paths sorted by modification time (newest first).",
    parameters: GlobParams,
    async execute(args, ctx) {
      // 1. Spawn: rg --files --glob '<pattern>' <path>
      // 2. Parse output as file paths
      // 3. Stat each file for mtime, sort descending
      // 4. Cap at 100 files
      // 5. Return one path per line
    },
  };
}
```

> **Implementation note:** `rg --files --glob` returns matching file paths. The mtime sort requires `stat()` calls on each result. For performance, stat in parallel with `Promise.all()` but cap concurrency.

#### grep

```typescript
// tools/grep.ts
const GrepParams = z.object({
  pattern: z.string().describe("Regex pattern to search for in file contents"),
  path: z.string().optional().describe("File or directory to search in. Default: current working directory"),
  include: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts')"),
  ignore_case: z.boolean().optional().describe("Case-insensitive search. Default: false"),
  context: z.number().int().min(0).optional().describe("Lines of context before and after each match"),
});

export function createGrepTool(cwd: string): Tool<typeof GrepParams> {
  return {
    name: "grep",
    description: "Search file contents using regex. Returns matching lines with file paths and line numbers.",
    parameters: GrepParams,
    async execute(args, ctx) {
      // 1. Build rg command:
      //    rg -n [--ignore-case] [--glob '<include>'] [-C <context>] '<pattern>' <path>
      // 2. Spawn rg process
      // 3. Parse output lines (format: "file:line:content")
      // 4. Cap at 100 matches
      // 5. Truncate individual lines at 2000 chars
      // 6. Return with truncateDirection: "head"
    },
  };
}
```

> **Ripgrep availability:** At agent startup, check `rg --version`. If not found, log a warning and disable glob/grep tools. Don't crash — the agent should still work with the other 5 tools (D072).

**Verify:** `bun test tools-ls tools-glob tools-grep` — ls sorts and caps, glob respects pattern and file limit, grep finds regex matches with context. Tests that spawn rg should skip gracefully if rg is not installed.

---

### Task 4: Provider Error Classification + Retry

**Files:** `provider/types.ts`, `provider/anthropic.ts`, `provider/retry.ts`, `test/provider-retry.test.ts`
**Decisions:** D003, D010

Add structured error handling to the provider layer. Errors are classified so the agent loop knows whether to retry.

```typescript
// provider/types.ts — new error types

export type ProviderErrorType =
  | "rate_limit"        // 429 — retryable, respect retry-after
  | "overloaded"        // 529 — retryable
  | "context_overflow"  // 400 with "context length" — NOT retryable, triggers compaction
  | "auth"              // 401/403 — NOT retryable, fatal
  | "network"           // ECONNREFUSED, timeout — retryable
  | "unknown";          // everything else — NOT retryable

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly errorType: ProviderErrorType,
    public readonly isRetryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly statusCode?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
```

```typescript
// provider/anthropic.ts — add error classification

function classifyAnthropicError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers);
      return new ProviderError(err.message, "rate_limit", true, retryAfter, status, err);
    }
    if (status === 529) {
      return new ProviderError(err.message, "overloaded", true, undefined, status, err);
    }
    if (status === 400 && err.message.includes("context length")) {
      return new ProviderError(err.message, "context_overflow", false, undefined, status, err);
    }
    if (status === 401 || status === 403) {
      return new ProviderError(err.message, "auth", false, undefined, status, err);
    }
  }
  if (isNetworkError(err)) {
    return new ProviderError(String(err), "network", true);
  }
  return new ProviderError(String(err), "unknown", false);
}

function parseRetryAfter(headers?: Record<string, string>): number | undefined {
  // Check retry-after-ms first (milliseconds), then retry-after (seconds)
  const ms = headers?.["retry-after-ms"];
  if (ms) return parseInt(ms, 10);
  const s = headers?.["retry-after"];
  if (s) return parseInt(s, 10) * 1000;
  return undefined;
}
```

```typescript
// provider/retry.ts — retry wrapper

export interface RetryConfig {
  maxAttempts: number;       // default: 5
  baseDelayMs: number;       // default: 1000 (1s)
  maxDelayMs: number;        // default: 30_000 (30s)
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void;
}

/**
 * Wraps a StreamFunction with exponential backoff retry.
 * Only retries on retryable errors. Respects retry-after headers.
 */
export function withRetry(
  streamFn: StreamFunction,
  config: RetryConfig,
): StreamFunction {
  return (model, context, options) => {
    // Return a new EventStream that internally retries on retryable errors
    // 1. Call streamFn
    // 2. If stream errors with retryable ProviderError:
    //    a. Calculate delay: max(baseDelay * 2^attempt, retryAfterMs)
    //    b. Cap at maxDelayMs
    //    c. Call onRetry callback (for status_change events)
    //    d. Wait delay (respecting abort signal)
    //    e. Retry from step 1
    // 3. If non-retryable or max attempts exceeded: propagate error
  };
}
```

> The retry wrapper is a StreamFunction decorator. The agent loop doesn't need to know about retry mechanics — it just sees a StreamFunction that's more resilient. The `onRetry` callback is the bridge: the loop passes a callback that emits `status_change` events (D010).

**Verify:** `bun test provider-retry` — retries on 429 with backoff, respects retry-after header, stops on 401, max attempts limit, abort cancels retry wait.

---

### Task 5: Agent Loop Retry + Usage Emission

**Files:** `agent/loop.ts`, `test/agent-loop-retry.test.ts`
**Decisions:** D004, D009, D010

Wire retry and usage tracking into the existing agent loop.

```typescript
// agent/loop.ts — changes to runLoop()

async function runLoop(
  messages: Message[],
  config: AgentLoopConfig,
  stream: EventStream<AgentEvent, Message[]>,
): Promise<void> {
  // Wrap the stream function with retry
  const retryStreamFn = withRetry(config.streamFn, {
    maxAttempts: config.maxRetries ?? 5,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    signal: config.signal,
    onRetry: (attempt, delayMs, error) => {
      // Emit status_change for TUI to display
      stream.push({
        type: "status_change",
        status: "retry",
        retry: { attempt, delayMs },
      });
    },
  });

  // ... existing loop logic, but use retryStreamFn instead of config.streamFn

  // After each successful turn, emit usage:
  // stream.push({
  //   type: "usage",
  //   usage: providerResult.usage,
  //   cost: calculateCost(config.model, providerResult.usage),
  // });
}
```

```typescript
// Cost calculation helper (simple, in agent/loop.ts or a separate utils file)
function calculateCost(model: Model, usage: Usage): number {
  // model.inputCostPer1M and model.outputCostPer1M from Model type
  // If not defined, return 0
  const inputCost = (usage.inputTokens / 1_000_000) * (model.inputCostPer1M ?? 0);
  const outputCost = (usage.outputTokens / 1_000_000) * (model.outputCostPer1M ?? 0);
  return inputCost + outputCost;
}
```

**Changes to AgentLoopConfig:**

```typescript
// agent/types.ts — add retry config fields
interface AgentLoopConfig {
  // ... existing fields
  maxRetries?: number;        // NEW: default 5
}
```

**Changes to Model type:**

```typescript
// provider/types.ts — add cost fields to Model
interface Model {
  // ... existing fields
  inputCostPer1M?: number;    // NEW: cost per 1M input tokens in USD
  outputCostPer1M?: number;   // NEW: cost per 1M output tokens in USD
}
```

**Verify:** `bun test agent-loop-retry` — status_change emitted on retry, usage emitted after turn, abort cancels retry, non-retryable error propagates immediately.

---

### Task 6: TUI Markdown Rendering + Spinner

**Files:** `cli/src/tui/markdown.ts`, `cli/src/tui/spinner.ts`, `cli/src/tui/app.ts`, `cli/test/tui-markdown.test.ts`, `cli/test/tui-spinner.test.ts`, `cli/src/index.ts`
**Decisions:** D047, D049

Add visual polish: agent output rendered as markdown, spinner shown during tool execution.

#### Markdown renderer

```typescript
// cli/src/tui/markdown.ts
import { marked } from "marked";

/**
 * Render markdown text as ANSI-styled terminal output.
 * Uses marked for parsing, custom renderer for ANSI output.
 */
export function renderMarkdown(text: string, width: number): string {
  // Custom marked renderer:
  // - **bold** → \x1b[1m...\x1b[22m
  // - *italic* → \x1b[3m...\x1b[23m
  // - `code` → \x1b[36m...\x1b[39m (cyan)
  // - ```block``` → indented, with language label
  // - # heading → \x1b[1m\x1b[4m...\x1b[24m\x1b[22m (bold+underline)
  // - links → text (url) — show both
  // - lists → indented with bullet
  // - Word wrap at `width`
}
```

> **Streaming approach for Phase 2:** Simple — accumulate full text, render on `message_end`. Newline-gated streaming (D047) adds complexity better suited for Phase 4's full TUI refactor. For Phase 2, the agent already streams `message_delta` events which the TUI renders as raw text. The markdown rendering applies to the final output only.

Wait — that means streaming text will appear raw, then re-render as markdown at the end? That's jarring. Better approach: **render markdown incrementally on each delta.** Accumulate the full text so far, re-render, and replace the displayed output. This is simple with the current inline rendering approach — just overwrite the previous output.

Revised approach:
```typescript
// In app.ts handleAgentEvent:
// - On message_delta: append to accumulated text, re-render markdown, replace display
// - On message_end: final render (no change needed)
```

This means the markdown renderer must handle partial/incomplete markdown gracefully (e.g., unclosed bold, partial code fence). The `marked` library handles this by default — unclosed elements are rendered as plain text.

#### Spinner

```typescript
// cli/src/tui/spinner.ts

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

export class Spinner {
  private frameIndex = 0;
  private timer: Timer | null = null;
  private message = "";
  private onRender: (frame: string) => void;

  constructor(onRender: (frame: string) => void) {
    this.onRender = onRender;
  }

  start(message: string): void {
    this.message = message;
    this.frameIndex = 0;
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_FRAMES.length;
      this.onRender(this.render());
    }, FRAME_INTERVAL_MS);
    this.onRender(this.render());
  }

  setMessage(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private render(): string {
    return `\x1b[36m${BRAILLE_FRAMES[this.frameIndex]}\x1b[39m ${this.message}`;
  }
}
```

#### App integration

Update `handleAgentEvent` in `app.ts`:

```typescript
// app.ts — updated event handling (sketch)

private accumulatedText = "";
private spinner = new Spinner((frame) => this.renderSpinner(frame));

handleAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "message_start":
      this.accumulatedText = "";
      break;

    case "message_delta":
      // Accumulate and re-render markdown
      if (event.delta.type === "text_delta") {
        this.accumulatedText += event.delta.delta;
        this.terminal.write(renderMarkdown(this.accumulatedText, this.terminal.columns));
      }
      break;

    case "message_end":
      // Final markdown render
      break;

    case "tool_start":
      this.spinner.start(`Running ${event.toolName}...`);
      break;

    case "tool_update":
      // Update spinner message with partial output
      break;

    case "tool_end":
      this.spinner.stop();
      // Display tool result summary
      break;

    case "status_change":
      if (event.status === "retry") {
        this.spinner.start(`Retrying (attempt ${event.retry!.attempt})...`);
      }
      break;

    case "usage":
      // Optional: display token/cost info (subtle, gray text)
      break;

    // ... existing error handling
  }
}
```

**New dependency:** Add `marked` to `packages/cli/package.json`.

**Verify:** `bun test tui-markdown tui-spinner` — markdown renders headers/bold/code/lists with ANSI, spinner cycles frames and updates message.

---

## Migration Notes

Phase 1 stubs and placeholders replaced in Phase 2:

- **ToolResult** — was `{ output, metadata? }`, now adds `truncateDirection?: "head" | "tail"` field. Backward compatible.
- **Tool executor** — was pass-through, now applies auto-truncation on output exceeding limits (D025).
- **Provider error handling** — was generic try/catch with untyped Error, now classifies into structured `ProviderError` with retryable flag.
- **Agent loop retry** — was no retry (immediate failure), now retries with exponential backoff via `withRetry()` wrapper.
- **Agent loop usage** — `usage` event type was defined but never emitted, now emitted after each turn.
- **Agent loop status_change** — `status_change` event type was defined but never emitted, now emitted during retry.
- **TUI output** — was raw text with basic ANSI colors, now markdown-rendered with ANSI styling.
- **TUI tool execution** — was static `[tool: name]` text, now animated spinner during execution.
- **Tool count** — was 1 (bash), now 7 (bash, read, write, edit, glob, grep, ls).
- **Model type** — was basic, now includes optional `inputCostPer1M`/`outputCostPer1M` fields for cost tracking.

---

## Acceptance Criteria

1. `bun install` — resolves all dependencies including `marked`
2. `bun test` — all unit tests pass (Phase 1 + Phase 2)
3. `rg --version` — ripgrep available (prerequisite check)
4. **read** — Agent can read a file and display contents with line numbers
5. **write** — Agent can create a new file with specified content
6. **edit** — Agent can find and replace a string in a file, with single-occurrence guard
7. **glob** — Agent can find files matching a pattern
8. **grep** — Agent can search file contents with regex
9. **ls** — Agent can list directory contents
10. **Auto-truncation** — Large tool output is automatically truncated with full output saved to temp file
11. **Retry** — Agent retries on 429/529 errors with exponential backoff
12. **Usage tracking** — Token usage and cost emitted after each turn
13. **Markdown** — Agent output renders with bold, code, headings, lists formatted in ANSI
14. **Spinner** — Braille spinner animates during tool execution
15. **Full loop** — Multi-tool conversation works: user asks question → agent reads code → edits file → verifies with bash
16. No `any` type escape hatches in new code

---

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Truncation utilities | `bun test` — truncateHead/truncateTail at byte/line limits, temp file persistence |
| Unit | Each tool's core logic | `bun test` — isolated tests per tool with filesystem fixtures (tmp dirs) |
| Unit | Binary detection | `bun test` — extension check + content sampling on known binary/text files |
| Unit | Edit single-occurrence guard | `bun test` — 0 matches, 1 match, 2+ matches |
| Unit | ProviderError classification | `bun test` — mock SDK errors → verify error type and retryable flag |
| Unit | Retry backoff timing | `bun test` — mock clock, verify delay progression and retry-after respect |
| Unit | Markdown renderer | `bun test` — known markdown → expected ANSI output |
| Unit | Spinner frames | `bun test` — frame cycling, message update |
| Integration | Auto-truncation in executor | `bun test` — tool returning >50KB → truncated with temp file path in metadata |
| Integration | Agent loop with retry | `bun test` — mock provider that fails twice then succeeds → verify status_change events |
| Integration | Full tool loop | `bun test` — mock provider, real tools → read file → edit → read again → verify change |
| Manual | Multi-tool conversation | Run CLI → ask agent to find and fix a typo across files → verify it works |
| Manual | Retry behavior | Set invalid API key → verify error. Use real key with rate limit scenario → verify retry spinner |
| E2E | Real API coding task | `bun run test:e2e` (only when requested) — ask agent to make a code change, verify result |

---

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Edit tool false matches | Ambiguous replacements corrupt files | Single-occurrence guard rejects ambiguous matches. Start with exact-only matching, no fuzzy |
| Ripgrep not installed | Glob/grep tools fail | Check `rg --version` at startup, disable glob/grep if missing, log warning (D072) |
| Markdown renderer breaks on partial input | Garbled streaming output | `marked` handles unclosed elements gracefully. Test with truncated markdown strings |
| Auto-truncation loses important context | LLM makes worse decisions with truncated output | Include truncation metadata in output: "... (truncated, N total lines). Full output at: /tmp/...". LLM can ask to read the full file |
| Retry delays slow down interactive use | User waits 30s for unrecoverable error | Cap retry at 5 attempts, classify auth errors as non-retryable immediately |
| Cost calculation inaccuracy | Misleading cost display | Mark cost as approximate. Use published pricing. If model has no pricing data, show tokens only |
| Spinner flicker on fast terminal redraws | Visual noise | Use synchronized output wrapping (`\x1b[?2026h`/`\x1b[?2026l`) if terminal supports it |

---

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D003 | Custom provider abstraction, roll own streaming | Provider error classification |
| D004 | 15 AgentEvent types | Usage + status_change emission |
| D007 | EventStream<T, R> class | Retry wrapper returns EventStream |
| D009 | AbortController-based cancellation | Abort during retry wait |
| D010 | Exponential backoff retry, max 5 attempts | Provider retry wrapper |
| D013 | Tool.define() with execute function | All 6 new tools |
| D014 | Map registry with builder | Tool registration |
| D015 | Sequential execution | No change, still sequential |
| D016 | ToolContext with approve placeholder | Tool context passed to all tools |
| D017 | 7 core tools (read, write, edit, bash, glob, grep, ls) | Core tool set |
| D018 | Exact text replacement for edits | Edit tool |
| D019 | Bun.spawn with tree kill | Glob/grep spawn rg |
| D020 | String output + metadata | All tool results |
| D021 | One file per tool | File organization |
| D022 | Glob via ripgrep, no fd | Glob + grep tools |
| D023 | Binary file detection | Read tool |
| D024 | Start with exact match (expand later) | Edit tool — exact only |
| D025 | Auto-truncation 50KB/2000 lines with temp file | Executor auto-truncation |
| D047 | Markdown rendering via marked | TUI markdown |
| D049 | Braille spinner | TUI spinner |
| D071 | Progress via callback | Tool update events |
| D072 | Ripgrep as system dependency | Glob + grep prerequisite |

---

## What Phase 2 Does NOT Include

- **No fuzzy edit matching** — Exact string replacement only. Whitespace-normalized and block-anchor fallbacks deferred (D024 says "expand later")
- **No FileTime conflict detection** — Write/edit don't check if file changed since last read. Deferred to when it causes real problems
- **No parallel tool execution** — Still sequential (D015). Parallel execution deferred to when needed
- **No multi-provider support** — Still Anthropic only. OpenAI/other providers deferred to Phase 3
- **No context window management** — Context overflow error is classified but compaction is deferred to Phase 3
- **No permission prompts** — Still auto-approve all tool calls. Full approval system is Phase 4
- **No TUI component refactor** — Keep existing App class structure. Full Component interface (D045) deferred to Phase 4
- **No newline-gated streaming** — Re-render full accumulated text on each delta. Differential line rendering deferred to Phase 4
- **No slash commands** — No command system yet. Deferred to Phase 4
- **No overlay system** — No modal UI. Deferred to Phase 4
- **No image support in read tool** — Binary detection rejects images. Image display deferred to when TUI supports it
- **No syntax highlighting in code blocks** — Markdown renderer styles code blocks with color but no per-language highlighting. Deferred to Phase 4
- **No ripgrep auto-download** — System install required (D072). Auto-download adds complexity not worth it for MVP
