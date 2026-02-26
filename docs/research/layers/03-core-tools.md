# Layer 3: Core Tools

## Problem Definition

The Core Tools layer provides the **built-in tool implementations** that enable a coding agent to interact with the filesystem, execute commands, and search codebases. These are the concrete tools that plug into the Tool System framework (L2). Each tool must:

1. Define its schema (parameters the LLM can provide)
2. Implement execution logic with proper error handling
3. Handle edge cases (binary files, large outputs, encoding, concurrent access)
4. Format output for LLM consumption (truncated, structured)
5. Integrate with the tool context (cancellation, permissions, progress streaming)

### Key Questions

1. What built-in tools exist in each project?
2. How is bash/shell execution handled (spawn, timeout, output, signals, process tree kill)?
3. How is file reading implemented (encoding, pagination, binary detection, images)?
4. How is file editing implemented (replacement strategy, fuzzy matching, safety)?
5. How is file writing implemented (atomicity, directory creation, events)?
6. How are search tools implemented (ripgrep integration, output formatting)?
7. What common patterns are shared across tools?
8. How is output formatted and truncated per tool?
9. How are tools organized in the codebase?

### Layer Scope

- Shell/bash execution tool
- File read tool
- File write tool
- File edit tool
- Glob/find tool (file pattern matching)
- Grep tool (content search)
- Ls/directory listing tool
- Per-tool truncation and output formatting
- Tool-specific error handling and edge cases

### Boundary: What Is NOT in This Layer

- Tool framework (L2: Tool System)
- Batch/parallel tools (L2 concern)
- Task/sub-agent tools (L10: Multi-Agent)
- MCP tool implementations (L9: MCP)
- Permission evaluation (L4: Approval -- but tools may call ctx.ask())

---

## codex-rs Analysis

### Architecture

codex-rs organizes tools across two directories:

```
tools/handlers/     - Tool handlers (one per tool)
  shell.rs          - ShellHandler (shell tool)
  read_file.rs      - ReadFileHandler (read_file tool)
  list_dir.rs       - ListDirHandler (list_dir tool)
  grep_files.rs     - GrepFilesHandler (grep_files tool)
  apply_patch.rs    - ApplyPatchHandler (freeform + JSON apply_patch)
  search_tool_bm25.rs - BM25 search handler
  view_image.rs     - ViewImageHandler
  plan.rs           - PlanHandler
  js_repl.rs        - JavaScript REPL handler
  multi_agents.rs   - Spawn/send/resume/wait/close agent handlers
  unified_exec.rs   - UnifiedExec handler (alternative shell)
  dynamic.rs        - Dynamic tool handler

tools/runtimes/     - Complex execution runtimes
  shell.rs          - Shell execution runtime (spawn, timeout, output capture)
  apply_patch.rs    - Patch application runtime
  unified_exec.rs   - Unified execution runtime (PTY-based)
```

15+ built-in tools. All implement `ToolHandler` trait with `handle()` async method.

### Key Types/Interfaces

All handlers share the pattern:
```rust
pub struct ConcreteHandler;

#[async_trait]
impl ToolHandler for ConcreteHandler {
    fn kind(&self) -> ToolKind { ToolKind::Function }
    async fn is_mutating(&self, _invocation: &ToolInvocation) -> bool { false }
    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError> {
        let args: Args = parse_arguments(&arguments)?;
        // ... tool logic ...
        Ok(ToolOutput::Function { body: FunctionCallOutputBody::Text(output), success: Some(true) })
    }
}
```

Arguments are deserialized from JSON via `serde`. Output is `ToolOutput::Function` with text body.

### Implementation Details

**Shell Execution** (`tools/runtimes/shell.rs`):

```rust
pub struct ExecParams {
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub expiration: ExecExpiration,  // Timeout(Duration) | DefaultTimeout(10s) | Cancellation
    pub env: HashMap<String, String>,
    pub network: Option<NetworkProxy>,
    pub sandbox_permissions: SandboxPermissions,
}
```

- **Spawn**: `spawn_child_async()` via tokio, piped stdio
- **Timeout**: `tokio::select!` on `child.wait()` vs `expiration.wait()` vs ctrl_c
- **Output streaming**: 8KB chunks emitted as `ExecCommandOutputDelta` events, max 10,000 deltas per call
- **Output cap**: 1 MiB per stream (stdout/stderr separately)
- **Process tree kill**: `kill_child_process_group()` with SIGKILL, fallback `child.start_kill()`
- **Exit codes**: SIGKILL -> 124, signal base at 128, timeout -> 64
- **Login shell**: `maybe_wrap_shell_lc_with_snapshot()` for environment variable capture
- **I/O drain timeout**: 2 seconds after kill to prevent grandchild pipe holds
- **Shell interception**: Detects apply_patch commands inside shell and redirects them

**File Reading** (`handlers/read_file.rs`):

Two modes: Slice and Indentation.

Slice mode:
- Offset (1-indexed), limit (default 2000 lines)
- Format: `L{n}: {content}`, max 500 chars per line
- Async BufReader, line-by-line, CRLF stripping
- UTF-8 with lossiness (`String::from_utf8_lossy`)

Indentation mode (unique to codex-rs):
- Context-aware block extraction from an anchor line
- Expands by indentation level (tab width: 4)
- Bidirectional expansion (up from anchor, down from anchor)
- Parameters: `anchor_line`, `max_levels`, `include_siblings`, `include_header`
- Detects comment prefixes (#, //, --) for header inclusion
- Blank lines inherit previous indentation for continuity
- Practical for code navigation: "show me the function around line 50"

**File Editing** (`handlers/apply_patch.rs` + `runtimes/apply_patch.rs`):

Dual format system:
1. **Freeform** (Lark grammar): `*** Begin Patch / End Patch`, `@@` hunks, `+`/`-` lines
2. **JSON function**: Structured hunk arguments

- Fuzzy matching for hunk application tolerance
- Verification: `maybe_parse_apply_patch_verified()` validates before execution
- Events: PatchApplyBegin/End, TurnDiff for file change tracking
- Sandbox-aware: read-only vs workspace-write vs full-access

**Search -- grep_files**:
- Ripgrep wrapper: spawns `rg --files-with-matches --sortr=modified --regexp`
- Optional glob filter: `--glob`
- Timeout: 30 seconds
- Limit: Default 100 files, max 2000

**Directory Listing** (`handlers/list_dir.rs`):
- Breadth-first traversal with depth limit (default 2)
- Sorted alphabetically per directory
- Type indicators: `/` (dir), `@` (symlink), `?` (other)
- Max 25 entries per call, 500 char max per entry name

**Output Formatting**:
- **Structured** (JSON): `{ "output": "...", "metadata": { "exit_code": i32, "duration_seconds": f32 } }`
- **Freeform** (text): `Exit code: N\nWall time: N seconds\nOutput:\n...`
- **Telemetry preview**: 2 KiB + 64 lines max for logging

### Layer Boundaries

- **Above (L2)**: Each handler implements `ToolHandler` trait. Framework calls `handle(invocation)` and receives `ToolOutput`.
- **Below (OS)**: Tools spawn processes, read files, list directories via tokio async I/O.
- **Lateral**: Shell handler integrates with sandbox system. Apply_patch integrates with event/diff tracking.

---

## pi-agent Analysis

### Architecture

pi-agent has 7 built-in tools, organized as one file per tool in `packages/coding-agent/src/core/tools/`:

```
tools/
  bash.ts       - Shell execution (process tree kill, temp file for large output)
  read.ts       - File reading (text + images, auto-resize)
  edit.ts       - Exact text replacement (fuzzy fallback)
  write.ts      - File creation/overwrite
  grep.ts       - Content search (ripgrep, JSON output parsing)
  find.ts       - File discovery (fd)
  ls.ts         - Directory listing
  truncate.ts   - Shared truncation utilities
  path-utils.ts - Path resolution (~ expansion, macOS Unicode normalization)
  edit-diff.ts  - Shared diff/BOM/line-ending utilities
  index.ts      - Collections and factory functions
```

Tool collections:
```typescript
codingTools = [read, bash, edit, write]        // Full access mode
readOnlyTools = [read, grep, find, ls]          // Exploration mode
```

### Key Types/Interfaces

All tools follow the factory pattern:
```typescript
export function createToolName(cwd: string, options?: ToolOptions): AgentTool<typeof schema> {
    const ops = options?.operations ?? defaultOperations;
    return {
        name: "toolName",
        label: "toolName",
        description: "...",
        parameters: schema,
        execute: async (toolCallId, params, signal?, onUpdate?) => {
            // ... tool logic ...
            return { content: [{type: "text", text: output}], details };
        },
    };
}
export const toolName = createToolName(process.cwd());
```

Every tool has a pluggable `Operations` interface for remote execution (SSH-ready pattern).

### Implementation Details

**Shell Execution** (`bash.ts`):

```typescript
interface BashOperations {
    exec: (command, cwd, { onData, signal?, timeout?, env? }) => Promise<{ exitCode: number | null }>;
}
```

- **Spawn**: `spawn(shell, [...args, command])` with `detached: true`
- **Shell detection**: `getShellConfig()` finds bash/zsh (cross-platform, Windows Git Bash support)
- **Process tree kill**: `killProcessTree(pid)` -- Unix: `process.kill(-pid, "SIGKILL")`, Windows: `taskkill /F /T /PID`
- **Timeout**: `setTimeout` -> `killProcessTree()`, error message `timeout:${timeout}`
- **AbortSignal**: Listener -> `killProcessTree()`, error message `aborted`
- **Large output**: Creates temp file (`/tmp/pi-bash-*.log`) when output exceeds 50KB threshold
- **Rolling buffer**: Last 100KB in memory (2x the truncation limit), trimmed on overflow
- **Streaming**: `onUpdate` callback for each chunk, with truncated rolling buffer
- **Command prefix**: Optional (e.g., `shopt -s expand_aliases`)
- **Spawn hook**: `BashSpawnHook` can modify command/cwd/env before spawn
- **Non-zero exit**: Wraps output in Error (rejected promise), LLM sees error

**File Reading** (`read.ts`):

- **Text files**: Offset/limit pagination (1-indexed), `truncateHead` (2000 lines OR 50KB)
- **Images**: Auto-detect jpg/png/gif/webp via `detectSupportedImageMimeTypeFromFile()`, auto-resize to 2000x2000 max, base64 encoding
- **Large first line**: Returns actionable bash command: `sed -n '5p' {path} | head -c 50000`
- **Encoding**: UTF-8 via `buffer.toString("utf-8")`
- **Path resolution**: `resolveReadPath()` handles `~` expansion, macOS Unicode normalization (NFD -> NFC)

**File Editing** (`edit.ts` + `edit-diff.ts`):

Strategy: Exact text replacement with fuzzy matching fallback.

```typescript
// Matching pipeline:
1. Exact match (indexOf)
2. Fuzzy match via normalizeForFuzzyMatch():
   - Strip trailing whitespace per line
   - Smart quotes -> ASCII quotes
   - Unicode dashes -> hyphen
   - Special spaces -> regular space
```

Safety guards:
- Single-occurrence guard: Rejects if multiple matches found (even fuzzy)
- BOM handling: Strip before processing, reattach after
- Line ending handling: Detect CRLF/LF, normalize to LF, process, restore original endings
- Diff generation: `generateDiffString()` -- unified diff with 4 context lines, line numbers
- AbortSignal checks at every async boundary

**File Writing** (`write.ts`):
- Standard `fs.writeFile()` (NOT atomic)
- Creates parent dirs: `mkdir` with `{ recursive: true }`
- Output: `Successfully wrote {length} bytes to {path}`
- Simple and minimal

**Search -- grep** (`grep.ts`):
- Spawns `rg --json --line-number --color=never --hidden`
- Supports: regex/literal, glob filter, ignore case, context lines
- JSON output parsing for structured match extraction
- Limit: 100 matches (configurable), line truncation at 500 chars
- `ensureTool("rg", true)` -- auto-downloads ripgrep if missing
- Context lines: reads file and extracts surrounding lines post-match

**Search -- find** (`find.ts`):
- Spawns `fd --glob --color=never --hidden --max-results N`
- Integrates `.gitignore` files (discovers and passes as `--ignore-file`)
- Excludes: `**/node_modules/**`, `**/.git/**`
- Limit: 1000 results
- `ensureTool("fd", true)` -- auto-downloads fd if missing

**Directory Listing** (`ls.ts`):
- Alphabetical sort (case-insensitive), `/` suffix for dirs
- Limit: 500 entries, 50KB byte limit
- Handles unreadable entries gracefully

**Shared Truncation** (`truncate.ts`):
```typescript
truncateHead(text, { maxLines: 2000, maxBytes: 50KB })  // For file reads
truncateTail(text, { maxLines: 2000, maxBytes: 50KB })   // For bash output (errors at end)
// Returns TruncationResult with: content, truncated, truncatedBy, totalLines/Bytes, etc.
```

Head truncation for file reads (beginning is most relevant). Tail truncation for bash output (errors appear at end). UTF-8 byte-safe truncation (finds valid character boundaries).

### Layer Boundaries

- **Above (L2)**: Tools are plain objects conforming to `AgentTool<TSchema>`. The agent loop calls `tool.execute()`.
- **Below (OS)**: Tools use `child_process.spawn()` for shell/search, `fs` for file I/O.
- **External deps**: ripgrep (auto-downloaded), fd (auto-downloaded).

---

## opencode Analysis

### Architecture

opencode has 14+ built-in tools in `packages/opencode/src/tool/`:

```
tool/
  bash.ts         - Shell execution (tree-sitter command parsing, permission model)
  read.ts         - File/directory reading (binary detection, images, instructions)
  write.ts        - File creation (LSP diagnostics, FileTime tracking)
  edit.ts         - Text replacement (9 fallback replacer strategies!)
  glob.ts         - File pattern matching (ripgrep --files)
  grep.ts         - Content search (ripgrep)
  batch.ts        - Parallel execution (Promise.all, up to 25 tools)
  task.ts         - Sub-agent invocation
  webfetch.ts     - URL content fetching
  websearch.ts    - Web search (Exa API)
  codesearch.ts   - Code search
  apply_patch.ts  - Multi-file unified diff
  skill.ts        - Custom skill invocation
  invalid.ts      - Malformed tool call recovery
  ls.ts           - Directory listing (unused, read.ts handles directories)
  lsp.ts          - LSP diagnostics tool
  plan.ts         - Plan mode tools
  question.ts     - Ask user question tool
  todo.ts         - Todo list management tools
  multiedit.ts    - Multi-file edit tool
```

All tools use `Tool.define("id", init)` pattern with Zod schemas.

### Key Types/Interfaces

```typescript
// Standard tool pattern:
export const ToolName = Tool.define("id", {
    description: DESCRIPTION_FROM_TXT_FILE,
    parameters: z.object({ ... }),
    async execute(params, ctx) {
        await ctx.ask({ permission: "...", patterns: [...], always: ["*"], metadata: {} });
        // ... tool logic ...
        ctx.metadata({ metadata: { ... } });
        return { title, metadata, output };
    },
});

// Or with lazy init for async setup:
export const ToolName = Tool.define("id", async () => ({
    description: "...",
    parameters: z.object({ ... }),
    async execute(params, ctx) { ... },
}));
```

### Implementation Details

**Shell Execution** (`bash.ts`):

The most sophisticated bash tool across all three projects.

- **Tree-sitter parsing**: Parses bash AST to extract commands and arguments
  - Detects: cd, rm, cp, mv, mkdir, touch, chmod, chown, cat
  - Resolves arguments via `realpath` for permission checking
  - Extracts command patterns for permission matching (BashArity)
- **Spawn**: `spawn(command, { shell, cwd, env, stdio, detached })`
- **Shell detection**: `Shell.acceptable()` finds an appropriate shell
- **Timeout**: Default 2 minutes (configurable via flag), setTimeout -> `Shell.killTree(proc)`
- **Process tree kill**: `Shell.killTree()` with platform-specific cleanup
- **Metadata streaming**: `ctx.metadata()` with 30KB cap, updated per stdout/stderr chunk
- **Abort handling**: `ctx.abort.addEventListener("abort")` -> `Shell.killTree(proc)`
- **Permission model**: External directory checks + BashArity command pattern matching
- **Plugin integration**: `Plugin.trigger("shell.env")` for custom environment variables
- **Description parameter**: LLM provides a 5-10 word description of each command
- **Working directory**: Explicit `workdir` parameter (avoids `cd` commands)

**File Reading** (`read.ts`):

The most feature-rich read tool.

- **MAX_LINE_LENGTH**: 2000 chars per line (truncated with suffix)
- **DEFAULT_READ_LIMIT**: 2000 lines
- **MAX_BYTES**: 50 KB total output cap
- **Directory support**: Returns sorted entry list with `/` suffix, offset/limit pagination
- **Binary detection**: Two-phase:
  1. Extension-based: 26+ known binary extensions (.zip, .exe, .wasm, .pyc, etc.)
  2. Sample-based: First 4KB, if >30% non-printable characters -> binary
  3. Null byte detection: Immediate binary classification
- **Image/PDF support**: Base64 encoded as attachment (excludes SVG as text)
- **Streaming**: `createReadStream()` + readline with `crlfDelay: Infinity`
- **FileTime tracking**: Records read time per session (for edit conflict detection)
- **File suggestions**: If file not found, suggests similar filenames from the same directory
- **Instruction loading**: `InstructionPrompt.resolve()` loads relevant instructions (like CLAUDE.md) and appends as `<system-reminder>`
- **Output format**: XML-structured with `<path>`, `<type>`, `<content>` tags

**File Editing** (`edit.ts`):

9 fallback replacement strategies tried in order:

```typescript
1. SimpleReplacer          // Exact literal indexOf match
2. LineTrimmedReplacer     // Line-by-line .trim() comparison, preserves original indentation
3. BlockAnchorReplacer     // First/last line anchors + Levenshtein distance for middle
4. WhitespaceNormalizedReplacer  // Collapse whitespace (\s+ -> " "), regex matching
5. IndentationFlexibleReplacer   // Strip minimum indentation, compare
6. EscapeNormalizedReplacer      // Unescape \n, \t, \\, quotes before matching
7. TrimmedBoundaryReplacer       // Leading/trailing whitespace trim
8. ContextAwareReplacer          // Context blocks with first/last anchors, 50% middle similarity
9. MultiOccurrenceReplacer       // All exact matches (for replaceAll flag only)
```

Each replacer is a **generator** function yielding candidate matches. The `replace()` function iterates replacers in order, checking for uniqueness.

Safety mechanisms:
- **FileTime.withLock()**: Serializes concurrent writes to same file via Promise chain
- **FileTime.assert()**: Verifies file unchanged since last read (detects external modifications)
- **Levenshtein distance**: For fuzzy matching (threshold 0.0 for single candidate, 0.3 for multiple)
- **replaceAll flag**: Optional, explicitly routes to MultiOccurrenceReplacer
- **LSP diagnostics**: Post-edit, checks for errors (max 20 per file)
- **Diff generation**: `createTwoFilesPatch()` + `trimDiff()` for readable output
- **File events**: `File.Event.Edited`, `FileWatcher.Event.Updated`
- **Snapshot integration**: Records before/after for undo capability

**File Writing** (`write.ts`):
- `Filesystem.write()`: Creates parent dirs recursively
- `FileTime.assert()`: Checks for conflicts (if file existed)
- Diff generation: `createTwoFilesPatch()` + `trimDiff()`
- LSP integration: Touches file -> collects diagnostics (max 20 errors/file, 5 project files)
- Permission check: `ctx.ask({ permission: "edit" })` before writing
- File events: `File.Event.Edited`, `FileWatcher.Event.Updated`
- FileTime tracking: Records write time for future conflict detection

**Search -- glob** (`glob.ts`):
- Thin wrapper around `Ripgrep.files({ cwd, glob: [pattern] })`
- 100 file limit, sorted by mtime descending (most recently modified first)
- Permission check before searching
- External directory validation

**Search -- grep** (`grep.ts`):
- Spawns `rg -nH --hidden --no-messages --field-match-separator=| --regexp`
- Exit codes: 0=matches, 1=none, 2=errors (still may have matches)
- Line truncation to 2000 chars, 100 match limit
- Output grouped by file, sorted by mtime (most recently modified first)
- Bun.spawn for process execution
- AbortSignal integration via `signal: ctx.abort`

**Advanced Tools**:
- **batch.ts**: Parallel execution via `Promise.all(toolCalls.map(execute))`, up to 25 tools. No nested batch.
- **apply_patch.ts**: Unified diff parser supporting Add/Update/Delete/Move operations. Creates parent dirs, LSP diagnostics post-apply.
- **invalid.ts**: Catches malformed tool calls, provides helpful error messages. Routes from `experimental_repairToolCall()` in processor.

### Layer Boundaries

- **Above (L2)**: Tools implement `Tool.Info` interface. AI SDK invokes `execute(args, ctx)`.
- **Below (OS)**: Tools use Bun.spawn, fs, readline for system interaction.
- **Lateral (L4)**: Permission checks via `ctx.ask()` inline in each tool.
- **Lateral (LSP)**: Edit/write tools integrate with LSP for diagnostics.
- **External deps**: ripgrep (managed by `Ripgrep.filepath()`), tree-sitter (for bash parsing).

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Tool Count** | 15+ built-in | 7 built-in | 14+ built-in |
| **Core Tools** | shell, read_file, list_dir, grep_files, apply_patch | bash, read, edit, write, grep, find, ls | bash, read, edit, write, glob, grep |
| **Shell Spawn** | tokio async, piped stdio | child_process spawn, detached | child_process spawn, detached |
| **Shell Timeout** | 10s default, ExecExpiration enum | No default (optional parameter) | 2min default, configurable |
| **Shell Output Cap** | 1 MiB + 10K delta events | 50KB (temp file for large) | 30KB metadata streaming |
| **Shell Process Kill** | kill_child_process_group + fallback | process.kill(-pid, SIGKILL) / taskkill | Shell.killTree() |
| **Shell Command Parsing** | parse_command() for event reporting | None | tree-sitter bash AST parsing |
| **File Read Modes** | Slice + Indentation (context-aware) | Offset/limit + image auto-detect | Offset/limit + binary detect + images + directories |
| **File Read Line Limit** | 2000 lines, 500 chars/line | 2000 lines, 50KB | 2000 lines, 2000 chars/line, 50KB |
| **Binary Detection** | None (relies on UTF-8 lossy) | Image MIME type only | Extension (26+) + sample (4KB, 30% threshold) + null byte |
| **Edit Strategy** | apply_patch (Lark grammar + JSON hunks) | Exact replace + fuzzy fallback (2 strategies) | 9 generator-based fallback strategies |
| **Edit Safety** | Fuzzy hunk matching, sandbox-aware | Single-occurrence guard, BOM/CRLF | FileTime.withLock, FileTime.assert, LSP diagnostics |
| **Edit Diff** | Patch format (hunk-based) | Unified diff (4 context lines) | createTwoFilesPatch + trimDiff |
| **Write Atomicity** | Sandbox-mediated | Not atomic (standard writeFile) | Filesystem.write() + directory creation |
| **Write Diagnostics** | None | None | LSP diagnostics (20 errors/file, 5 project files) |
| **Search Backend** | ripgrep (rg --files-with-matches) | ripgrep (rg --json) + fd | ripgrep (rg -nH) |
| **Search Output** | File list (sorted by mtime) | Structured matches with context lines | Grouped by file, sorted by mtime |
| **Search Match Limit** | 100 files (max 2000) | 100 matches | 100 matches |
| **External Tool Mgmt** | Bundled/expected | Auto-download (rg, fd) | Managed download (ripgrep) |
| **Glob Tool** | N/A (grep_files does file listing) | find (fd) | glob (rg --files) |
| **Directory Listing** | list_dir (BFS, depth limit 2) | ls (flat, 500 entries) | read tool handles directories |
| **Image Support** | view_image tool (separate) | read tool (auto-detect, auto-resize) | read tool (base64 attachment) |
| **Pluggable Ops** | Direct (Rust-native) | Yes (Operations per tool, SSH-ready) | Filesystem module |
| **Permission Checks** | Via orchestrator (external) | None | ctx.ask() per tool |
| **Tree-sitter** | No | No | Yes (bash command parsing for permissions) |
| **LSP Integration** | None | None | edit/write -> diagnostics |
| **FileTime Locking** | None | None | FileTime.withLock + FileTime.assert |
| **Module Structure** | handlers/ + runtimes/ (separate) | One file per tool + shared utils | One file per tool + shared utils |
| **Description Sources** | Inline strings + templates | Inline strings | Separate .txt files imported |

---

## Synthesis

### Common Patterns

1. **One File Per Tool**: All three projects organize tools as one file per tool. This is the universal pattern for maintainability and discoverability.

2. **Ripgrep as Search Backend**: All three use ripgrep for grep/search functionality. None implement custom search. Ripgrep is the de facto standard for fast code search. The main difference is output parsing: pi-agent uses `--json` for structured output, codex-rs uses `--files-with-matches` for file listing, opencode uses field separator for custom parsing.

3. **Pagination for Large Files**: All three support offset/limit pagination for file reading. Default limit is consistently 2000 lines. This prevents the LLM from consuming entire large files in one call.

4. **Separate Truncation for Different Tool Types**: Read tools truncate from the head (beginning of file is most relevant). Bash tools truncate from the tail (errors/results appear at the end). All three implement this dual-direction truncation.

5. **Process Tree Kill for Shell**: All three implement process tree killing to prevent orphaned child processes. This is essential for shell tools that spawn complex command pipelines.

6. **Error-as-Content**: When tools fail, error messages are formatted as tool output and sent to the LLM (not thrown as exceptions). This enables the LLM to self-correct based on error messages.

### Key Differences

1. **Edit Strategy Complexity**: The spectrum ranges from pi-agent (2 strategies: exact + fuzzy normalization) to opencode (9 fallback strategies with Levenshtein distance). codex-rs uses apply_patch (hunk-based patching, a fundamentally different approach). The 9-strategy approach handles more LLM output variations but adds complexity. The 2-strategy approach is simpler and covers the majority of cases.

2. **Binary Detection**: opencode has the most robust binary detection (extension + sample + null byte). pi-agent only detects images. codex-rs relies on UTF-8 lossy decoding. Binary detection prevents garbage output from reading compiled files and is worth adding from the start.

3. **Shell Command Parsing**: opencode uses tree-sitter to parse bash commands before execution, extracting file paths for permission checks and command patterns for security. pi-agent and codex-rs do not parse commands. This is sophisticated but valuable for the permission system.

4. **LSP Integration**: opencode checks LSP diagnostics after edit/write operations. This gives the LLM immediate feedback on type errors, syntax errors, etc. Neither pi-agent nor codex-rs has this integration. This is a higher-layer concern (L7+) but provides significant value.

5. **FileTime Conflict Detection**: opencode tracks when files are read and asserts they haven't changed before editing. This prevents the LLM from making edits based on stale file content. Neither pi-agent nor codex-rs has this mechanism. Simple and important for reliability.

6. **Pluggable Operations** (pi-agent): Each tool defines an `Operations` interface that can be replaced for remote execution. This is a clean abstraction for SSH support but adds boilerplate. Worth considering for future extensibility.

### Best Practices Identified

1. **opencode's edit replacer strategy**: The generator-based replacer chain is elegant. Each strategy is a generator yielding candidate matches. The main `replace()` function iterates strategies until one produces a unique match. This is composable and testable. However, starting with 2-3 strategies (exact, trimmed, block anchor) covers 95% of cases.

2. **opencode's FileTime.withLock()**: Serializing writes to the same file via a Promise chain prevents race conditions when multiple tool calls edit the same file. Simple to implement, prevents subtle bugs.

3. **pi-agent's temp file for large bash output**: Writing full output to a temp file when it exceeds the truncation limit, then providing the path in the truncated output. This lets the LLM access full output via follow-up read commands without storing megabytes in the conversation.

4. **opencode's binary detection**: Two-phase detection (extension + content sampling) catches both known binary formats and unknown ones. The null byte check is a fast early-exit for binary data.

5. **opencode's file suggestions**: When a file is not found, suggesting similar filenames from the same directory helps the LLM self-correct. Simple string matching with `toLowerCase().includes()`.

6. **pi-agent's abort pattern**: Consistent AbortSignal handling across all tools with cleanup in finally blocks. Check `signal?.aborted` before starting, add listener, clean up in all exit paths.

---

## Open Questions

### Q1: Minimum tool set for MVP?

**Existing decision D017**: 7 core tools (read, write, edit, bash, glob, grep, ls).

All three projects have read, edit, bash, and some form of search. The question is:
- **glob vs find**: pi-agent uses fd (find), opencode uses ripgrep --files (glob). Ripgrep is already needed for grep, so glob via ripgrep avoids the fd dependency.
- **ls**: opencode handles directories in the read tool. pi-agent has a separate ls tool. Combining into read is simpler (fewer tools for the LLM to choose from).

**Recommendation**: Start with 7 tools: read (with directory support), write, edit, bash, glob (rg --files), grep (rg), ls. Can merge ls into read later.

### Q2: How many edit fallback strategies?

**Existing decision D024**: Start with 2, expand later.

pi-agent has 2 (exact + fuzzy). opencode has 9. The practical distribution is:
- ~90% of edits work with exact match (SimpleReplacer)
- ~5-8% need whitespace/trim normalization (LineTrimmedReplacer, TrimmedBoundaryReplacer)
- ~2-5% need fuzzy matching (BlockAnchorReplacer with Levenshtein)

**Recommendation**: Start with 3 strategies: SimpleReplacer, LineTrimmedReplacer, BlockAnchorReplacer. These cover ~98% of cases. Add more based on failure patterns during testing.

### Q3: Should ripgrep be bundled or required as system install?

**Existing decision D072**: Require system install.

pi-agent auto-downloads. opencode manages the download. codex-rs expects it installed.

**Recommendation**: Check for system install first, auto-download to data directory as fallback. This provides the best user experience while avoiding bundling a binary. Bun's `$` shell command can check `which rg`.

### Q4: Should the edit tool include FileTime conflict detection?

opencode's `FileTime.assert()` / `FileTime.withLock()` prevents edits based on stale reads. Neither pi-agent nor codex-rs has this.

**Recommendation**: Yes, add from the start. Track `Map<sessionID, Map<filePath, timestamp>>`. Assert the file's mtime matches the recorded read time before editing. Use a Promise chain per file path for serialized writes. This prevents a common class of bugs where the LLM reads a file, makes decisions based on its content, then edits a version that has been modified by another tool call.

### Q5: Should the read tool detect binary files?

**Existing decision D023**: Yes, binary detection before read.

opencode's approach: extension-based (fast, covers 26+ known formats) + content sampling (4KB, >30% non-printable = binary). Null byte = immediate binary.

**Recommendation**: Adopt opencode's two-phase approach. Extension check is a simple switch statement. Content sampling is one file read of 4KB. Both are cheap and prevent the LLM from receiving pages of garbage binary data.

### Q6: Should bash tool include tree-sitter parsing?

opencode parses bash commands with tree-sitter to extract file paths and command patterns for permissions.

**Recommendation**: Defer to L4 (Approval). The bash tool should execute commands; permission checking should be in the approval layer. Tree-sitter adds a significant dependency for what is essentially a permission concern.

### Q7: Should edit/write include LSP diagnostic feedback?

opencode checks LSP diagnostics after edit/write and includes errors in the tool output.

**Recommendation**: Defer to later layers. LSP integration is valuable but adds complexity and external dependencies. The core edit/write tools should work without LSP. Add LSP feedback as an enhancement.

---

## Decision Validation

| Decision | Status | Notes |
|----------|--------|-------|
| D017 (7 core tools) | **Confirmed** | read, write, edit, bash, glob, grep, ls. Glob via ripgrep (no fd). |
| D018 (Exact text replacement) | **Confirmed + Refined** | Start with 3 strategies: exact, line-trimmed, block-anchor. Expand based on failures. |
| D019 (Bun.spawn with process tree kill) | **Confirmed** | All three projects use spawn + tree kill. Add Shell.killTree() helper. |
| D022 (Glob via ripgrep, no fd) | **Confirmed** | opencode proves rg --files works well. Avoids fd dependency. |
| D023 (Binary file detection) | **Confirmed** | Adopt opencode's two-phase: extension check + content sampling (4KB, 30% threshold). |
| D024 (Edit fallback: start with 2) | **Refined to 3** | Exact + LineTrimmed + BlockAnchor covers ~98% of cases. |
| D072 (Ripgrep: require system install) | **Refined** | Check system install first, auto-download as fallback. |
| New: FileTime conflict detection | **Proposed** | Track read timestamps, assert before edit. Serialize writes per file. Prevents stale-edit bugs. |
| New: File suggestions on not-found | **Proposed** | When read fails, suggest similar filenames from same directory. Low cost, high UX value. |
| New: Description parameter for bash | **Proposed** | opencode requires a short description for each bash command. Improves UI and logging. |
