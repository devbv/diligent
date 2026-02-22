# Layer 2: Core Tools

## Key Questions

1. What built-in tools exist?
2. How is each tool implemented? What patterns are shared?
3. How is bash/shell execution handled?
4. How is file editing implemented?
5. What input/output schemas do tools use?
6. Are tools defined inline or in separate modules?

## codex-rs Analysis

**Built-in Tools:**

| Tool | Handler | Purpose |
|---|---|---|
| shell / local_shell / container.exec | ShellHandler | Execute shell commands |
| shell_command | ShellCommandHandler | Login shell support |
| exec_command / write_stdin | UnifiedExecHandler | Windows ConPTY/PTY |
| apply_patch | ApplyPatchHandler | File modifications via patch format |
| read_file | ReadFileHandler | Read file contents |
| grep_files | GrepFilesHandler | BM25 search |
| list_dir | ListDirHandler | Directory listing |
| view_image | ViewImageHandler | Display images |
| js_repl / js_repl_reset | JsReplHandler | JavaScript REPL |
| update_plan | PlanHandler | Agent planning |
| request_user_input | RequestUserInputHandler | User prompts |
| search_tool_bm25 | SearchToolBm25Handler | Full-text search |
| web_search | (built-in) | Web search |
| spawn_agent / send_input / resume_agent / wait / close_agent | MultiAgentHandler | Sub-agents |

**Shell Execution:**
- `ExecParams`: command (Vec<String>), cwd, expiration, env, network, sandbox_permissions
- `ExecExpiration`: Timeout(Duration), DefaultTimeout (10s), Cancellation(CancellationToken)
- `spawn_child_async()` with tokio, captures stdout/stderr asynchronously
- 8KB chunks, streaming deltas (ExecCommandOutputDeltaEvent)
- 1 MiB output cap, max 10K deltas per call
- Exit code handling: SIGKILL → 124, signal base at 128
- Shell wrapping: `maybe_wrap_shell_lc_with_snapshot()` for login shell env

**File Editing (apply_patch):**
- Two variants: Freeform (custom text format with Lark grammar) and Function (structured JSON hunks)
- Freeform format: `<file_path>`, `<old_content>`, `<new_content>` blocks
- Fuzzy matching tolerance for hunk application
- Emits PatchApplyBegin/End events
- Tracks changes via SharedTurnDiffTracker
- Sandbox-aware (read-only vs workspace-write vs full-access)

**Shared Handler Pattern:**
```
impl ToolHandler for XxxHandler {
    fn kind() → ToolKind
    async fn is_mutating() → bool
    async fn handle(invocation) → Result<ToolOutput, FunctionCallError>
}
```
- Parse args from JSON via `parse_arguments::<T>()`
- Validate inputs
- Execute logic
- Return `ToolOutput::Function { body, success }`
- Complex tools use `ToolRuntime` trait for approval/sandbox orchestration

**Tool Output:**
- `FunctionCallOutputBody::Text(String)` or `ContentItems(Vec<ContentItem>)`
- Structured JSON for shell: `{ exit_code, duration_seconds, stdout, stderr }`
- Freeform tools return plain String

**Module Structure:**
- Specs: `core/src/tools/spec.rs` (definitions + build_specs factory)
- Handlers: `core/src/tools/handlers/` (one file per tool/group)
- Runtimes: `core/src/tools/runtimes/` (shell.rs, apply_patch.rs, unified_exec.rs)
- Events: `core/src/tools/events.rs` (ToolEmitter)
- Orchestrator: `core/src/tools/orchestrator.rs` (approval pipeline)

## pi-agent Analysis

**Built-in Tools:**

| Tool | File | Purpose |
|---|---|---|
| read | read.ts | File reading (text + images) |
| bash | bash.ts | Shell command execution |
| edit | edit.ts | Text replacement in files |
| write | write.ts | File creation |
| grep | grep.ts | Content search (ripgrep) |
| find | find.ts | File search (fd/glob) |
| ls | ls.ts | Directory listing |

Collections: `codingTools` = [read, bash, edit, write], `readOnlyTools` = [read, grep, find, ls]

**Shell Execution:**
- `BashOperations.exec()`: spawns process via `spawn(shell, [...args, command])`
- `getShellConfig()` determines bash/zsh
- `detached: true` for process group (tree killing via `killProcessTree()`)
- Timeout via `setTimeout` → `killProcessTree(pid)`
- AbortSignal integration for cancellation
- Output streaming: `onData` callback for chunks
- Large output handling: temp file (`/tmp/pi-bash-*.log`) when exceeds threshold
- Rolling buffer for tail truncation
- Non-zero exit code → Error (output + exit code in message)

**File Editing:**
- Strategy: exact text replacement with fuzzy matching fallback
- `editSchema`: path, oldText, newText
- Flow: read file → strip BOM → normalize line endings → fuzzyFindText → replace → write
- Single occurrence guarantee (fails if multiple matches → ambiguity)
- Unified diff generation for result display
- BOM and line ending preservation

**Shared Implementation Pattern:**
```typescript
function createToolName(cwd, options?) → AgentTool {
  const ops = options?.operations ?? defaultOperations;
  return {
    name, label, description, parameters: TypeBox schema,
    execute: async (toolCallId, params, signal?, onUpdate?) => {
      // AbortSignal handling
      // Core logic using ops (pluggable for SSH/remote)
      // Return { content: [{type: "text", text}], details: {...} }
    }
  };
}
```
- **Pluggable operations** pattern: `ToolOperations` interface abstracts filesystem/process calls
- Default implementations use local fs/spawn
- Can be swapped for SSH, remote execution, etc.
- Every tool has factory function + default singleton

**Tool Output:**
- `AgentToolResult<T>`: content blocks (text/image) + tool-specific details
- Streaming via `onUpdate` callback during execution
- Truncation utilities shared across tools

**Module Structure:**
- All tools in `packages/coding-agent/src/core/tools/`
- One file per tool: bash.ts, read.ts, edit.ts, write.ts, grep.ts, find.ts, ls.ts
- Shared utilities: truncate.ts, path-utils.ts, edit-diff.ts, types.ts
- index.ts exports collections and factory functions

## opencode Analysis

**Built-in Tools:**

| Tool | File | Purpose |
|---|---|---|
| bash | bash.ts | Shell execution (tree-sitter parsing) |
| read | read.ts | File/directory reading |
| glob | glob.ts | File pattern matching (ripgrep) |
| grep | grep.ts | Content search (ripgrep) |
| edit | edit.ts | Text replacement |
| write | write.ts | File creation |
| task | task.ts | Sub-agent invocation |
| batch | batch.ts | Parallel tool execution (up to 25) |
| webfetch | webfetch.ts | HTTP content fetching |
| websearch | websearch.ts | Web search |
| codesearch | codesearch.ts | Code-specific search |
| apply_patch | apply_patch.ts | Unified diff patching |
| lsp | lsp.ts | Language server integration |
| skill | skill.ts | User-defined skills |
| invalid | invalid.ts | Malformed tool call recovery |

**Shell Execution:**
- `spawn(params.command, { shell, cwd, env, stdio, detached })`
- Tree-sitter parsing of bash AST to extract command intentions
- Timeout via `setTimeout` → `kill()` (process tree)
- AbortSignal integration
- Output streaming via `ctx.metadata()` (30KB metadata cap)
- Truncation for LLM output

**File Editing:**
- Strategy: exact text replacement (oldString → newString)
- Optional `replaceAll` flag for multiple occurrences
- Atomic updates via `FileTime.withLock()`
- Unified diff generation via `createTwoFilesPatch()`
- Event publishing for file watchers: `File.Event.Edited`, `FileWatcher.Event.Updated`
- LSP integration: touch file + check diagnostics after edit

**Shared Implementation Pattern:**
```typescript
Tool.Info = {
  id: "tool-name",
  init: async (ctx?) => ({
    description: "...",
    parameters: z.object({...}),
    execute: async (args, ctx) => ({
      title: "...",
      metadata: {...},
      output: "string result",
      attachments?: [...]
    })
  })
}
```
- Lazy initialization via `init()`
- Permission requests via `ctx.ask()`
- Metadata streaming via `ctx.metadata()`
- Truncation via `Truncate.output()`
- File operations via `Filesystem` module (atomic writes)
- Event bus integration for state changes

**Tool Output:**
- Single `output` string for LLM
- Separate `metadata` object for UI/logging
- Optional `attachments` for files/images
- Automatic truncation with outputPath fallback

**Module Structure:**
- All tools in `packages/opencode/src/tool/`
- One file per tool
- registry.ts for discovery and filtering
- tool.ts for core types
- Shared utilities: Filesystem, Truncate, Ripgrep, FileTime

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Tool Count** | ~15+ built-in | 7 built-in | 14+ built-in |
| **Shell Execution** | tokio async spawn, 10s default timeout, 1MiB cap | child_process spawn, tree kill, temp file for large output | Bun.spawn, tree-sitter AST analysis, metadata streaming |
| **File Editing** | apply_patch (freeform + JSON), fuzzy hunk matching | Exact text replace, fuzzy fallback, single-match guard | Exact text replace, replaceAll flag, atomic locks |
| **Output Truncation** | Max bytes/lines policies | Rolling buffer, tail truncation | Truncate.output() utility |
| **Operations Abstraction** | Direct (Rust-native) | Pluggable ToolOperations (SSH-ready) | Filesystem module |
| **External Tools** | BM25 search | ripgrep, fd | ripgrep |
| **Multi-Agent** | spawn/send/resume/wait/close | None (at tool level) | task tool (recursive agent) |
| **Batch Execution** | N/A (parallel via RwLock) | N/A | batch tool (up to 25) |
| **LSP Integration** | None at tool level | None | Diagnostics after edit/write |
| **Module Organization** | specs + handlers + runtimes (3 layers) | One file per tool + factories | One file per tool + registry |

## Open Questions

1. **Minimum tool set**: pi-agent's 7 tools (read, bash, edit, write, grep, find, ls) covers core needs. Is this the right starting set for diligent, or do we need glob/grep separation from day one?

2. **Edit strategy**: All three use text replacement (not line-based). codex-rs also supports freeform patch format. Which is simpler to implement and more reliable?

3. **Shell output handling**: pi-agent's temp file approach for large output is pragmatic. codex-rs's streaming deltas are more real-time. What's the right balance?

4. **Operations abstraction**: pi-agent's pluggable `ToolOperations` pattern enables SSH/remote execution. Should this be designed in from the start or deferred?

5. **Batch/parallel tool**: opencode's batch tool is a separate concern from parallel tool calls in the agent loop. Is this needed early?

6. **Tree-sitter for bash**: opencode parses bash commands with tree-sitter for intent detection. Useful for permission decisions but adds complexity. Worth it?

7. **LSP integration at tool level**: opencode checks diagnostics after edit/write. This is L6+ territory but tightly coupled with core tools. When to introduce?
