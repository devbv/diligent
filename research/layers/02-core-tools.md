# Layer 2: Core Tools

## Key Questions

1. What built-in tools exist in each project?
2. How is bash/shell execution handled (spawn, timeout, output, signals)?
3. How is file reading implemented (encoding, pagination, binary detection)?
4. How is file editing implemented (replacement strategy, fuzzy matching, diff)?
5. How is file writing implemented (atomic writes, events)?
6. How are search tools implemented (ripgrep/fd integration)?
7. What common patterns are shared across tools?
8. How is output formatted and truncated?
9. How are tools organized in the codebase?

## codex-rs Analysis

### Built-in Tools (15+)

| Tool | Handler | Parallel? |
|---|---|---|
| shell / shell_command | ShellHandler / ShellCommandHandler | Yes |
| read_file | ReadFileHandler | Yes |
| list_dir | ListDirHandler | Yes |
| grep_files | GrepFilesHandler | Yes |
| apply_patch (freeform + JSON) | ApplyPatchHandler | No |
| search_tool_bm25 | SearchToolBm25Handler | Yes |
| view_image | ViewImageHandler | Yes |
| plan | PlanHandler | No |
| js_repl / js_repl_reset | JsReplHandler | No |
| request_user_input | RequestUserInputHandler | — |
| spawn_agent / send_input / resume_agent / wait / close_agent | MultiAgentHandler | No |

### Shell Execution

```rust
pub struct ExecParams {
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub expiration: ExecExpiration,  // Timeout(Duration) | DefaultTimeout(10s) | Cancellation(CancellationToken)
    pub env: HashMap<String, String>,
    pub network: Option<NetworkProxy>,
    pub sandbox_permissions: SandboxPermissions,
}
```

- **Spawn**: `spawn_child_async()` via tokio, piped stdio
- **Timeout**: `tokio::select!` on child.wait() vs expiration.wait() vs ctrl_c
- **Output streaming**: 8KB chunks → `ExecCommandOutputDelta` events, max 10,000 deltas per call
- **Output cap**: 1 MiB per stream (stdout/stderr separately)
- **Process tree kill**: `kill_child_process_group()` + `child.start_kill()` fallback
- **Exit codes**: SIGKILL → 124, signal base at 128, timeout → 64
- **Login shell**: `maybe_wrap_shell_lc_with_snapshot()` for env capture
- **I/O drain timeout**: 2 seconds after kill (prevent grandchild pipe holds)

### File Reading

```rust
struct ReadFileArgs {
    file_path: String,     // Must be absolute
    offset: usize,         // 1-indexed line (default 1)
    limit: usize,          // Max lines (default 2000)
    mode: ReadMode,        // Slice or Indentation
}
```

- **Slice mode**: Simple offset/limit, format `L{n}: {content}`, max 500 chars/line
- **Indentation mode**: Context-aware block extraction from anchor line
  - Expands by indentation level (tab width: 4)
  - Include siblings, headers (comments), max_levels
  - Bidirectional expansion (up/down from anchor)
- **Encoding**: UTF-8 with lossiness, CRLF stripping
- **Streaming**: Async BufReader line-by-line

### File Editing (apply_patch)

**Dual format:**
1. **Freeform** (Lark grammar): `*** Begin Patch / End Patch`, `@@` hunks, `+`/`-` lines
2. **JSON function**: Structured hunk arguments

- **Fuzzy matching**: Tolerance for hunk application
- **Verification**: `maybe_parse_apply_patch_verified()` validates before execution
- **Shell interception**: Detects apply_patch commands in shell and redirects
- **Events**: PatchApplyBegin/End, TurnDiff for file changes
- **Sandbox-aware**: read-only vs workspace-write vs full-access

### Search (grep_files)

- **Ripgrep wrapper**: spawns `rg --files-with-matches --sortr=modified --regexp`
- **Optional glob**: `--glob` filter
- **Timeout**: 30 seconds
- **Limit**: Default 100 files, max 2000

### Directory Listing

- **Breadth-first traversal**: depth limit (default 2)
- **Sorted alphabetically** per directory
- **Type indicators**: `/` (dir), `@` (symlink), `?` (other)
- **Output**: max 25 entries per call, 500 char max per entry name

### Common Patterns

```rust
// Argument parsing:
fn parse_arguments<T: Deserialize>(arguments: &str) -> Result<T, FunctionCallError>

// Output construction:
ToolOutput::Function { body: FunctionCallOutputBody::Text(string), success: Option<bool> }

// All handlers implement:
impl ToolHandler for ConcreteHandler {
    fn kind(&self) -> ToolKind;
    async fn is_mutating(&self, invocation) -> bool;
    async fn handle(&self, invocation) -> Result<ToolOutput, FunctionCallError>;
}
```

### Output Formatting

- **Structured** (JSON): `{ "output": "...", "metadata": { "exit_code": i32, "duration_seconds": f32 } }`
- **Freeform** (text): `Exit code: N\nWall time: N seconds\nOutput:\n...`
- **Truncation policy**: Applied via TruncationPolicy module
- **Telemetry preview**: 2 KiB + 64 lines max for logging

### Module Organization

```
tools/
├── spec.rs                 # Tool specifications, build_specs() factory
├── registry.rs             # ToolRegistry, ToolHandler trait, builder
├── orchestrator.rs         # Approval + sandbox pipeline
├── context.rs              # ToolInvocation, ToolOutput, ToolPayload
├── events.rs               # ToolEmitter, event types
├── parallel.rs             # RwLock parallel execution
├── handlers/               # One file per tool/group
│   ├── shell.rs, read_file.rs, list_dir.rs, grep_files.rs, apply_patch.rs, ...
├── runtimes/               # Complex tool runtimes
│   ├── shell.rs, apply_patch.rs, unified_exec.rs
└── sandboxing.rs           # Sandbox policy enforcement
```

---

## pi-agent Analysis

### Built-in Tools (7)

| Tool | File | Purpose |
|---|---|---|
| read | read.ts | File reading (text + images, auto-resize) |
| bash | bash.ts | Shell execution (process tree kill) |
| edit | edit.ts | Exact text replacement (fuzzy fallback) |
| write | write.ts | File creation/overwrite |
| grep | grep.ts | Content search (ripgrep) |
| find | find.ts | File discovery (fd) |
| ls | ls.ts | Directory listing |

Collections: `codingTools = [read, bash, edit, write]`, `readOnlyTools = [read, grep, find, ls]`

### Shell Execution

```typescript
interface BashOperations {
  exec: (command, cwd, { onData, signal?, timeout?, env? }) => Promise<{ exitCode: number | null }>;
}
```

- **Spawn**: `spawn(shell, [...args, command])` with `detached: true`
- **Shell detection**: `getShellConfig()` finds bash/zsh (cross-platform, Windows Git Bash support)
- **Process tree kill**: `killProcessTree(pid)` → Unix: `process.kill(-pid, "SIGKILL")`, Windows: `taskkill /F /T /PID`
- **Timeout**: `setTimeout` → `killProcessTree()`, rejection with `timeout:${timeout}`
- **AbortSignal**: Listener → `killProcessTree()`, rejection with `"aborted"`
- **Large output**: Temp file (`/tmp/pi-bash-*.log`) when exceeds 50KB threshold
- **Rolling buffer**: Last 100KB in memory, trimmed on overflow
- **Streaming**: `onData` callback for each chunk
- **Command prefix**: Optional (e.g., `shopt -s expand_aliases`)
- **Spawn hook**: `BashSpawnHook` can modify command/cwd/env before spawn

### File Reading

```typescript
interface ReadOperations {
  readFile: (path) => Promise<Buffer>;
  access: (path) => Promise<void>;
  detectImageMimeType?: (path) => Promise<string | null>;
}
```

- **Text files**: Offset/limit pagination (1-indexed), truncateHead (2000 lines OR 50KB)
- **Images**: Auto-detect jpg/png/gif/webp, auto-resize to 2000x2000 max, base64 encoding
- **Large first line**: Returns actionable bash command: `sed -n '5p' {path} | head -c 50000`
- **Encoding**: UTF-8 via `buffer.toString("utf-8")`

### File Editing

```typescript
interface EditOperations {
  readFile: (path) => Promise<Buffer>;
  writeFile: (path, content) => Promise<void>;
  access: (path) => Promise<void>;
}
```

- **Strategy**: Exact text replacement with fuzzy matching fallback
- **Fuzzy matching**: `normalizeForFuzzyMatch()` — strips trailing whitespace, smart quotes → ASCII, Unicode dashes → hyphen, special spaces → space
- **Single-occurrence guard**: Rejects if multiple matches found
- **BOM handling**: Strip before processing, reattach after
- **Line ending handling**: Detect CRLF/LF, normalize to LF, process, restore
- **Diff generation**: `generateDiffString()` — unified diff with 4 context lines, line numbers

### File Writing

- **Not atomic**: Standard `fs.writeFile()`
- **Creates parent dirs**: `mkdir` with `{ recursive: true }`
- **Output**: `Successfully wrote {length} bytes to {path}`

### Search Tools

**grep.ts (ripgrep)**:
- Spawns `rg --json --line-number --color=never --hidden`
- Supports: regex/literal, glob filter, ignore case, context lines
- Limit: 100 matches, line truncation at 500 chars
- `ensureTool("rg", true)` — auto-downloads if missing

**find.ts (fd)**:
- Spawns `fd --glob --color=never --hidden --max-results N`
- Integrates `.gitignore` files (finds and passes as `--ignore-file`)
- Excludes: `**/node_modules/**`, `**/.git/**`
- Limit: 1000 results
- `ensureTool("fd", true)` — auto-downloads if missing

**ls.ts**:
- Alphabetical sort (case-insensitive), `/` suffix for dirs
- Limit: 500 entries, 50KB byte limit
- Handles unreadable entries gracefully

### Common Patterns

```typescript
// Factory function pattern:
export function createBashTool(cwd, options?): AgentTool { ... }
export const bashTool = createBashTool(process.cwd());

// Pluggable operations (SSH-ready):
const ops = options?.operations ?? defaultBashOperations;
await ops.exec(command, cwd, { onData, signal, timeout });

// AbortSignal handling:
signal?.addEventListener("abort", handleAbort);
try { ... } finally { signal?.removeEventListener("abort", handleAbort); }

// Output: { content: [{type: "text", text}], details: T }
```

### Output Truncation (truncate.ts)

```typescript
// Two modes:
truncateHead(text, { maxLines: 2000, maxBytes: 50KB })  // For file reads
truncateTail(text, { maxLines: 2000, maxBytes: 50KB })   // For bash output (errors at end)

// Returns: { content, truncated, truncatedBy: "lines"|"bytes"|null, totalLines, totalBytes, ... }
```

### Module Organization

```
packages/coding-agent/src/core/tools/
├── index.ts           # Collections, exports, factories
├── bash.ts, read.ts, edit.ts, write.ts, grep.ts, find.ts, ls.ts  # One per tool
├── truncate.ts        # Shared truncation utilities
├── path-utils.ts      # Path resolution (~ expansion, macOS Unicode)
├── edit-diff.ts       # Shared diff/BOM/line-ending utilities
└── types.ts           # Shared type definitions
```

---

## opencode Analysis

### Built-in Tools (14+)

| Tool | File | Purpose |
|---|---|---|
| bash | bash.ts | Shell execution (tree-sitter parsing) |
| read | read.ts | File/directory reading (binary detection) |
| write | write.ts | File creation (LSP diagnostics) |
| edit | edit.ts | Text replacement (9 fallback strategies!) |
| glob | glob.ts | File pattern matching (ripgrep --files) |
| grep | grep.ts | Content search (ripgrep) |
| batch | batch.ts | Parallel execution (up to 25 tools) |
| task | task.ts | Sub-agent invocation |
| webfetch | webfetch.ts | URL content fetching |
| websearch | websearch.ts | Web search (Exa API) |
| codesearch | codesearch.ts | Code search |
| apply_patch | apply_patch.ts | Multi-file unified diff |
| skill | skill.ts | Custom skill invocation |
| invalid | invalid.ts | Malformed tool call recovery |

### Shell Execution

- **Spawn**: `spawn()` from `child_process`, shell via `Shell.acceptable()`
- **Tree-sitter parsing**: Parses bash AST to detect file modifications and command intentions
  - Detects: cd, rm, cp, mv, mkdir, touch, chmod, chown, cat
  - Extracts arguments via realpath for permission checking
- **Timeout**: Default 2 minutes, configurable
- **Metadata streaming**: `ctx.metadata()` with 30KB cap, updated per stdout/stderr chunk
- **Abort handling**: `ctx.abort.addEventListener("abort", ...)` → `Shell.killTree(proc)`
- **Process tree killing**: `Shell.killTree()` for cleanup
- **Permission model**: External directory checks + BashArity command pattern matching

### File Reading

- **MAX_LINE_LENGTH**: 2000 chars per line (truncated)
- **DEFAULT_READ_LIMIT**: 2000 lines
- **MAX_BYTES**: 50 KB total output cap
- **Directory support**: Returns sorted entry list with `/` suffix, offset/limit
- **Binary detection**: Extension-based + sample-based (first 4KB, >30% non-printable)
- **Image/PDF**: Base64 encoded as attachment (excludes SVG as text)
- **Streaming**: `createReadStream()` + readline with `crlfDelay: Infinity`
- **FileTime tracking**: Records read time per session (for edit conflict detection)

### File Writing

- **Filesystem.write()**: Creates parent dirs recursively
- **Diff generation**: `createTwoFilesPatch()` + `trimDiff()`
- **LSP integration**: Touches file → collects diagnostics (max 20 errors/file, 5 files)
- **File events**: `File.Event.Edited`, `FileWatcher.Event.Updated`

### File Editing (9 Fallback Strategies!)

```typescript
// Replacement strategies tried in order:
1. SimpleReplacer        // Exact literal match
2. LineTrimmedReplacer   // Line-by-line trim comparison
3. BlockAnchorReplacer   // First/last line anchors + Levenshtein
4. WhitespaceNormalizedReplacer  // Whitespace-insensitive
5. IndentationFlexibleReplacer   // Strips minimum indentation
6. EscapeNormalizedReplacer      // Unescapes \n, \t, etc.
7. TrimmedBoundaryReplacer       // Leading/trailing whitespace trim
8. ContextAwareReplacer          // Context blocks with anchors
9. MultiOccurrenceReplacer       // All matches (for replaceAll flag)
```

- **FileTime.withLock()**: Serializes concurrent writes to same file via Promise chain
- **FileTime.assert()**: Verifies file unchanged since last read
- **Levenshtein distance**: For fuzzy matching (threshold 0.0 for single candidate, 0.3 for multiple)
- **replaceAll flag**: Optional, uses MultiOccurrenceReplacer
- **LSP diagnostics**: Post-edit, max 20 errors
- **Diff**: `diffLines()` for structured additions/deletions count

### Search Tools

**glob.ts**: Thin wrapper around `Ripgrep.files()` — 100 file limit, sorted by mtime descending

**grep.ts**: Spawns `rg -nH --hidden --no-messages --field-match-separator=| --regexp`
- Exit codes: 0=matches, 1=none, 2=errors (still may have matches)
- Line truncation to 2000 chars, 100 match limit
- Output grouped by file, sorted by mtime

### Advanced Tools

**batch.ts**: Parallel execution via `Promise.all(toolCalls.map(execute))`, up to 25 tools. No nested batch. Each call gets Part tracking in session.

**apply_patch.ts**: Unified diff parser, supports Add/Update/Delete/Move operations. Creates parent dirs, LSP diagnostics post-apply.

### Common Patterns

```typescript
// Lazy init:
export const ReadTool = Tool.define("read", { description, parameters: z.object({...}), execute })
// OR:
export const BashTool = Tool.define("bash", async () => ({ description, parameters, execute }))

// Permission:
await ctx.ask({ permission: "read", patterns: [filepath], always: ["*"], metadata: {} })

// Metadata streaming:
ctx.metadata({ metadata: { output: truncated, description } })

// Automatic truncation: Tool framework truncates if metadata.truncated is undefined
```

### Output Truncation

- **Truncate.output()**: 2000 lines OR 50KB, direction "head" or "tail"
- **Per-tool metadata cap**: 30KB for bash streaming
- **Tools can opt out**: Set `metadata.truncated` to skip auto-truncation
- **Full output saved**: Written to disk with path in metadata

### Module Organization

```
packages/opencode/src/tool/
├── tool.ts            # Framework: Tool.define(), Tool.Context, Tool.Info
├── registry.ts        # Discovery, filtering, registration
├── truncation.ts      # Output truncation management
├── bash.ts, read.ts, write.ts, edit.ts, glob.ts, grep.ts  # Core tools
├── batch.ts, task.ts, webfetch.ts, apply_patch.ts          # Advanced tools
├── skill.ts, question.ts, todo.ts, plan.ts, invalid.ts     # System tools
└── external-directory.ts  # External path validation
```

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Tool Count** | 15+ built-in | 7 built-in | 14+ built-in |
| **Shell Spawn** | tokio async, piped stdio | child_process spawn, detached | child_process spawn, detached |
| **Shell Timeout** | 10s default, ExecExpiration enum | setTimeout + tree kill | 2min default, setTimeout + tree kill |
| **Shell Output Cap** | 1 MiB + 10K delta events | 50KB (temp file for large) | 30KB metadata + Truncate.output |
| **File Read Modes** | Slice + Indentation (context-aware) | Offset/limit + image auto-detect | Offset/limit + binary detect + images |
| **Edit Strategy** | apply_patch (Lark grammar + JSON hunks) | Exact replace + fuzzy fallback | 9 fallback strategies (!) |
| **Edit Safety** | Fuzzy hunk matching, sandbox-aware | Single-occurrence guard, BOM/CRLF | FileTime.withLock, 9 strategies, LSP diagnostics |
| **Write Atomicity** | Sandbox-mediated | Not atomic (standard writeFile) | Filesystem.write() + file events |
| **Search Backend** | ripgrep (rg), BM25 for tool search | ripgrep (rg) + fd | ripgrep (rg) |
| **External Tools** | No auto-download | Auto-download (rg, fd) | Ripgrep downloaded lazily |
| **Multi-Agent** | spawn/send/resume/wait/close tools | None at tool level | task tool (recursive agent) |
| **Batch/Parallel** | RwLock per-tool parallelism | N/A | batch tool (Promise.all, up to 25) |
| **LSP Integration** | None at tool level | None | Edit/write → diagnostics |
| **Pluggable Ops** | Direct (Rust-native) | Yes (ToolOperations per tool) | Filesystem module |
| **Output Truncation** | TruncationPolicy (bytes/lines) | truncateHead/truncateTail (2000 lines/50KB) | Truncate.output (2000 lines/50KB) |
| **Tree-sitter** | No | No | Yes (bash command parsing) |
| **Module Structure** | specs + handlers + runtimes (3 layers) | One file per tool + shared utils | One file per tool + registry |

## Open Questions

1. **Minimum tool set**: pi-agent's 7 tools (read, bash, edit, write, grep, find, ls) is proven sufficient. We chose this set in D017. The question is whether glob should replace find (opencode uses ripgrep for both glob and grep, no fd dependency).

2. **Edit strategy**: pi-agent's exact+fuzzy (2 strategies) is simple. opencode's 9 fallback strategies is battle-tested. Start with exact+fuzzy, add more strategies based on failure patterns during implementation.

3. **Shell output handling**: pi-agent's temp file for large output is practical. codex-rs's streaming deltas are real-time. opencode's metadata streaming is good for UI. Start with pi-agent's approach (temp file + tail truncation), add streaming later.

4. **Read modes**: codex-rs's indentation-aware reading is sophisticated and useful for code navigation. But it adds complexity. Start with simple offset/limit, defer indentation mode.

5. **Operations abstraction**: pi-agent's pluggable ToolOperations enables SSH/remote. Worth designing in? Probably not initially — can be added later without breaking changes.

6. **Binary detection**: opencode detects binary files before attempting read. Worth adding from start — prevents garbage output from reading compiled files.

7. **External tool dependencies**: pi-agent auto-downloads rg and fd. opencode downloads rg lazily. We should bundle or auto-download ripgrep for grep/glob tools.

8. **LSP integration**: opencode checks diagnostics after edit/write. This is L6+ territory but useful. Defer to later layer.

9. **Tree-sitter for bash**: opencode parses bash commands for permission decisions. Adds complexity. Defer until L3 (Approval).

10. **FileTime locking**: opencode's `withLock()` prevents concurrent write conflicts. Simple and important for reliability. Worth adding from start.
