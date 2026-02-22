# Design Decisions Log

Decisions made during synthesis reviews, with rationale.

## Round 0 Decisions (L0: REPL Loop)

### D001: Runtime — Bun + TypeScript
- **Decision**: Use Bun as runtime, TypeScript in strict mode
- **Rationale**: Fast startup, native TypeScript support, good DX. Aligns with opencode's approach (also Bun+TS). pi-agent uses Node/TS. Bun's native Bun.spawn and test runner reduce external dependencies.
- **Date**: 2026-02-22 (confirmed 2026-02-23)

### D002: Monorepo structure — packages/core + packages/cli
- **Decision**: Bun workspace monorepo with core library and CLI as separate packages
- **Rationale**: All three projects separate core from CLI. codex-rs: protocol/core/tui/cli crates. pi-agent: ai/agent/coding-agent packages. opencode: single package but with clear module boundaries + HTTP server separation. Two packages (core + cli) is the minimum viable separation.
- **Date**: 2026-02-22 (confirmed 2026-02-23)

### D003: Provider abstraction from day one
- **Decision**: Abstract LLM providers behind a common `Provider` interface. Roll our own streaming abstraction (not ai-sdk).
- **Rationale**: All three projects have provider abstraction. pi-agent's approach (custom `StreamFunction` returning uniform `AssistantMessageEventStream`) gives most control without ai-sdk dependency. opencode couples heavily to ai-sdk (20+ packages). Start with Anthropic + OpenAI providers.
- **Alternatives considered**: ai-sdk (opencode, heavy dependency), fully custom per-provider (codex-rs, most work)
- **Date**: 2026-02-22 (refined 2026-02-23)

### D004: Op/Event pattern for agent communication
- **Decision**: Use tagged union Op (user→agent) and AgentEvent (agent→user) types. Start with ~10-15 event types (pi-agent level), not 40+ (codex-rs level).
- **Rationale**: codex-rs's fine-grained events (40+) are powerful but complex. pi-agent's ~24 events (12 agent + 12 streaming) is a good middle ground. Start minimal, expand as needed. Key events: turn_start/end, message_start/update/end, tool_execution_start/update/end.
- **Date**: 2026-02-22 (refined 2026-02-23)

### D005: Unified messages (not part-based)
- **Decision**: Messages carry their content inline (like pi-agent), not as separate part entities (like opencode).
- **Rationale**: opencode's separate MessageTable + PartTable with PartDelta events enables granular streaming but adds significant complexity (3 DB tables, part lifecycle management). pi-agent's approach is simpler: messages contain content arrays directly. Part-based model can be introduced later if needed for advanced streaming.
- **Alternatives considered**: opencode's message+parts separation (deferred)
- **Date**: 2026-02-23

### D006: Session persistence — JSONL append-only
- **Decision**: Persist sessions as JSONL append-only files (like pi-agent), not SQLite (opencode) or pure in-memory (codex-rs).
- **Rationale**: JSONL is simple, append-only prevents data loss, tree-structured entries (parentId) enable branching/resuming. SQLite adds Drizzle ORM dependency and migration complexity. In-memory loses state on crash. pi-agent's `~/.pi/agent/sessions/<id>.txt` pattern is proven.
- **Alternatives considered**: SQLite (opencode, deferred to L5 if needed), in-memory only (codex-rs)
- **Date**: 2026-02-23

### D007: Custom EventStream (async iterable)
- **Decision**: Use a custom `EventStream<T, R>` class (like pi-agent) for streaming LLM responses and agent events.
- **Rationale**: pi-agent's EventStream is elegant: ~88 lines, producer pushes events, consumer uses `for await`, completion via `.result()` promise. More flexible than raw callbacks, lighter than ai-sdk's streaming infrastructure. Works with any provider.
- **Date**: 2026-02-23

### D008: Immutable TurnContext + mutable SessionState
- **Decision**: Separate per-turn immutable `TurnContext` (model, tools, policies) from per-session mutable `SessionState` (history, settings).
- **Rationale**: codex-rs makes this distinction clearly (TurnContext vs SessionState). Prevents accidental mutation of turn-specific config during tool execution. pi-agent mixes these in AgentContext. Clean separation helps with debugging and testing.
- **Date**: 2026-02-23

### D009: AbortController-based cancellation
- **Decision**: Use AbortController/AbortSignal for cancellation throughout the stack (like pi-agent and opencode).
- **Rationale**: All three TS-based patterns use AbortController. It's the platform-native approach, propagates through fetch/spawn/await chains. codex-rs uses CancellationToken (Rust equivalent). Add soft interruption (steering via message queue) later.
- **Date**: 2026-02-23

### D010: Exponential backoff retry with retryable error classification
- **Decision**: Classify errors as retryable/non-retryable. Retry with exponential backoff (2^n seconds, cap at 30s). Context overflow triggers compaction, not retry.
- **Rationale**: All three projects implement error retry. opencode's approach is cleanest: explicit retryable check, retry-after header support, separate handling for context overflow. pi-agent's pattern-match approach is also good. Max 5 retries by default.
- **Date**: 2026-02-23

### D011: Deferred decisions (resolve during implementation or later rounds)
- **Deferred**: Server architecture between TUI and core (opencode's HTTP/RPC pattern) — resolve in L6
- **Deferred**: Doom loop detection — resolve in L3 or implementation phase
- **Deferred**: Auto-compaction — resolve in L5
- **Deferred**: Steering/soft interruption — resolve in implementation phase
- **Date**: 2026-02-23

## Round 1 Decisions (L1: Tool System + L2: Core Tools)

### D012: Schema system — Zod
- **Decision**: Use Zod for tool parameter schemas
- **Rationale**: Most popular TS validation library, used by opencode. Native JSON Schema export via `z.toJSONSchema()`. Better ecosystem support than TypeBox (pi-agent). Custom schema subsets (codex-rs) are too much maintenance in TS.
- **Date**: 2026-02-23

### D013: Tool definition — Interface with execute function
- **Decision**: Tools defined as objects with `name`, `description`, `parameters` (Zod schema), and `execute(args, ctx)` function. No lazy init pattern initially.
- **Rationale**: pi-agent's `AgentTool` pattern is the cleanest. opencode's lazy `init()` is useful but adds complexity we don't need yet. codex-rs's trait-based approach is Rust-specific.
- **Alternatives considered**: opencode's lazy init (deferred), codex-rs's ToolHandler trait (Rust pattern)
- **Date**: 2026-02-23

### D014: Tool registry — Simple Map with builder
- **Decision**: `ToolRegistry` as a `Map<string, Tool>` with a builder that collects tools. No filesystem discovery initially.
- **Rationale**: Middle ground between pi-agent (just an array) and opencode (filesystem + plugin discovery). Map gives O(1) lookup by name. Builder pattern allows conditional registration. Plugin/filesystem discovery can be added in L7/L8.
- **Date**: 2026-02-23

### D015: Sequential tool execution with parallel-ready interface
- **Decision**: Execute tools sequentially initially (like pi-agent), but design the ToolHandler interface to support parallel execution later. Each tool declares `supportParallel: boolean`.
- **Rationale**: Sequential is simplest and allows steering/interruption between tools. codex-rs's RwLock parallel approach is the eventual target but premature for MVP. The `supportParallel` flag can be used later without interface changes.
- **Date**: 2026-02-23

### D016: Tool context with approval hook placeholder
- **Decision**: `ToolContext` carries session info, abort signal, and an `approve(request)` function that initially auto-approves. L3 will replace the approve implementation.
- **Rationale**: codex-rs and opencode both integrate approval into tool execution context. Designing the hook now avoids L1 interface changes when L3 is implemented. pi-agent handles approval externally which requires more refactoring later.
- **Date**: 2026-02-23

### D017: Initial tool set — 7 core tools
- **Decision**: Start with read, write, edit, bash, glob, grep, ls. Matches pi-agent's tool set.
- **Rationale**: This covers all basic coding agent needs. Additional tools (batch, task, webfetch, apply_patch) can be added incrementally. pi-agent proves this set is sufficient for a functional agent.
- **Date**: 2026-02-23

### D018: Edit strategy — Exact text replacement
- **Decision**: File editing via exact oldText → newText replacement (like pi-agent and opencode), not patch format.
- **Rationale**: All three projects implement this pattern. It's simpler than patch format, LLM-friendly, and reliable. codex-rs's freeform patch format is an alternative for models that prefer it, but can be added later. Single-occurrence guard prevents ambiguous edits.
- **Date**: 2026-02-23

### D019: Shell execution — Bun.spawn with process tree kill
- **Decision**: Use Bun.spawn for shell execution with detached process groups and tree killing for timeout/abort.
- **Rationale**: Follows pi-agent's pattern adapted for Bun. Detached process groups enable clean tree kill. Timeout via setTimeout + kill. Output streaming via onData callback. Temp file fallback for large output (>1MiB).
- **Date**: 2026-02-23

### D020: Tool result format — String output + metadata object
- **Decision**: Tools return `{ output: string, metadata?: Record<string, unknown> }`. Output goes to LLM, metadata goes to events/UI.
- **Rationale**: Separating LLM-facing output (string) from UI-facing metadata follows opencode's pattern. Simpler than pi-agent's content blocks (text/image arrays) for initial implementation. Image support can be added to metadata later.
- **Date**: 2026-02-23

### D021: One file per tool, separate from framework
- **Decision**: Tool framework in `packages/core/src/tool/` (types, registry, executor). Individual tools in `packages/core/src/tools/` (read.ts, bash.ts, etc.).
- **Rationale**: All three projects separate framework from implementations. One file per tool is the universal pattern. Clear boundary between "how tools work" (L1) and "what tools exist" (L2).
- **Date**: 2026-02-23

### D022: Glob via ripgrep, no fd dependency
- **Decision**: Use ripgrep's `--files` mode for glob/file discovery instead of fd. Glob and grep both use ripgrep as the single external dependency.
- **Rationale**: opencode uses ripgrep for both grep and glob. This eliminates the fd dependency (pi-agent uses fd for find tool). Ripgrep is sufficient for file matching with `--files --glob` flags. One fewer binary to bundle.
- **Date**: 2026-02-23

### D023: Binary file detection before read
- **Decision**: Detect binary files before attempting to read them. Use extension-based check + first-4KB sample analysis.
- **Rationale**: opencode implements this to prevent garbage output from compiled files, images, etc. Simple to implement and prevents common failure mode. Extension check is fast, sample-based check (>30% non-printable) is fallback.
- **Date**: 2026-02-23

### D024: Edit fallback strategies (start with 2, expand later)
- **Decision**: Start with exact match + fuzzy match (normalize whitespace, smart quotes, Unicode). opencode's 9-strategy cascade can be added incrementally as failure patterns emerge.
- **Rationale**: pi-agent's 2-strategy approach (exact + fuzzy) covers most cases. opencode's BlockAnchorReplacer, IndentationFlexibleReplacer, etc. are advanced and can be added when we see specific failure modes. Start simple.
- **Date**: 2026-02-23

### D025: Auto-truncation with output path fallback
- **Decision**: Tool framework automatically truncates output exceeding 2000 lines or 50KB. Full output saved to temp file, path included in metadata. Tools can opt out by setting `metadata.truncated`.
- **Rationale**: Both pi-agent and opencode implement this pattern. Prevents context overflow from large tool outputs. Head truncation for file reads, tail truncation for bash output. Full output accessible via temp file path.
- **Date**: 2026-02-23

### D026: Deferred L1/L2 decisions
- **Deferred**: Pluggable ToolOperations for SSH/remote (pi-agent pattern) — resolve if needed
- **Deferred**: Tree-sitter bash parsing for permissions (opencode) — resolve in L3
- **Deferred**: LSP diagnostics after edit/write (opencode) — resolve in L6+
- **Deferred**: Indentation-aware file reading (codex-rs) — resolve if needed
- **Deferred**: FileTime.withLock for concurrent write safety (opencode) — add during implementation
- **Date**: 2026-02-23

## Round 2 Decisions (L3: Approval & Sandbox + L4: Config System + L5: Session & Persistence)

### D027: Approval system — Rule-based with wildcard pattern matching
- **Decision**: Implement a rule-based permission system with `{ permission, pattern, action }` rules, wildcard matching, and last-match-wins semantics. Actions are `"allow"`, `"deny"`, `"ask"`.
- **Rationale**: opencode's `PermissionNext` approach is the right complexity level. codex-rs's trait-based orchestrator with OS sandboxing is too complex for MVP. pi-agent has no approval at all. Rule-based matching with wildcards is simple to implement, declarative, and extensible. D016 already placed an `approve()` hook in ToolContext — this decision fills in the implementation.
- **Alternatives considered**: Trait-based orchestrator (codex-rs, deferred), no approval (pi-agent, insufficient for safety), AskForApproval policy enum (codex-rs, simpler but less flexible)
- **Date**: 2026-02-23

### D028: Permission evaluation — ctx.ask() inline in tool execution
- **Decision**: Tools request permission via `ctx.ask({ permission, patterns, always })` mid-execution. The call blocks until the user responds (allow once, always, reject). Builds on D016's approval hook.
- **Rationale**: opencode's inline `ctx.ask()` pattern is the cleanest integration with tool execution. The tool knows what it needs permission for (file path, command, etc.) and requests it at the right moment. codex-rs's approach separates approval from execution (trait-level), which is harder to compose.
- **Date**: 2026-02-23

### D029: Approval responses — once, always, reject with cascading
- **Decision**: Three user responses: `"once"` (approve this call), `"always"` (add rule for future calls), `"reject"` (cancel this and all pending in session). "Always" cascading: approving one request auto-resolves other pending requests that now match.
- **Rationale**: opencode's three-response model covers the common cases. The cascading behavior (approve once → resolve matching pending) reduces user fatigue. "Reject" canceling all session-pending is aggressive but safe (user can re-run). Persistent "always" rules stored in session, not disk (for MVP).
- **Date**: 2026-02-23

### D030: No OS-level sandboxing at MVP
- **Decision**: Defer OS-level sandboxing (seatbelt, seccomp, Windows Sandbox) to post-MVP. Permission enforcement is at the tool-call level only.
- **Rationale**: Only codex-rs implements OS sandboxing, and it's highly complex (platform-specific, 3 different implementations). opencode and pi-agent both work without OS sandboxing. Tool-level permission checks are sufficient for MVP safety. OS sandboxing can be added later without changing the permission model.
- **Deferred**: macOS seatbelt, Linux seccomp, Windows Sandbox, network proxy/domain control
- **Date**: 2026-02-23

### D031: Doom loop detection — same tool+input 3x
- **Decision**: Detect when the same tool is called with the same input 3 times in a row. On detection, require explicit user approval to continue (regardless of normal permission rules). Resolves D011 deferred item.
- **Rationale**: opencode implements this pattern. Prevents the LLM from endlessly retrying failed operations. Simple to implement: hash (tool name + serialized args), track last 3 calls. Integrates with the permission system as a special "doom_loop" permission check.
- **Date**: 2026-02-23

### D032: Config format — JSONC with Zod validation
- **Decision**: Use JSONC (JSON with Comments) for configuration files. Validate with Zod schemas (consistent with D012). Config file: `diligent.jsonc` (or `diligent.json`).
- **Rationale**: JSONC allows comments (user-friendly for config files) while being trivially parseable. Zod validation (D012) provides type-safe config with helpful error messages. TOML (codex-rs) is less natural for a TS project. Plain JSON (pi-agent) lacks comments. `jsonc-parser` library handles parsing.
- **Date**: 2026-02-23

### D033: Config hierarchy — 3 layers (global, project, CLI)
- **Decision**: Three config layers with clear precedence: global (`~/.config/diligent/diligent.jsonc`) < project (`diligent.jsonc` in project root) < CLI arguments. Enterprise/managed layer deferred.
- **Rationale**: pi-agent's 2-layer approach is too minimal (no CLI overrides as a concept). opencode's 7+ layers is over-engineered for MVP. Three layers cover the essential use cases: user defaults (global), project customization (project), and one-off overrides (CLI). Enterprise managed config can be added later as a 4th layer.
- **Alternatives considered**: 2 layers (pi-agent, too few), 7+ layers (opencode, too many), TOML with layer stack (codex-rs, wrong format)
- **Date**: 2026-02-23

### D034: Config deep merge with array concatenation for instructions
- **Decision**: Config layers merged via deep merge. Objects merge recursively (later layers win for scalar values). `instructions` and `plugins` arrays are concatenated (deduplicated) across layers, not replaced.
- **Rationale**: opencode's merge strategy is the right approach. Deep merge allows projects to override specific settings without repeating all global config. Array concatenation for instructions means global instructions (e.g., "always use English") are preserved when project adds its own. pi-agent's approach (arrays replaced) loses global context.
- **Date**: 2026-02-23

### D035: Project instructions — CLAUDE.md discovery via findUp
- **Decision**: Discover `CLAUDE.md` and `AGENTS.md` files by searching up from cwd. Support both project-root and global (`~/.config/diligent/CLAUDE.md`) locations. Truncate to 32 KiB (codex-rs's limit).
- **Rationale**: opencode's instruction file discovery pattern is well-established. codex-rs also supports AGENTS.md with the same truncation limit. This is critical for usability — users expect their CLAUDE.md to be respected. `findUp` is standard and handles monorepo structures.
- **Date**: 2026-02-23

### D036: Session persistence — JSONL with tree structure (confirming D006)
- **Decision**: Confirm D006. Sessions persisted as JSONL append-only files with pi-agent's tree structure (id/parentId on every entry). Session directory: `~/.config/diligent/sessions/<project-hash>/<session-id>.jsonl`.
- **Rationale**: Round 2 deep-dive confirms JSONL+tree is the right approach. pi-agent's implementation is proven and supports branching, compaction entries, version migration, and session listing. Tree structure enables non-destructive branching without creating new files. Path includes project hash for per-project organization.
- **Date**: 2026-02-23

### D037: Compaction — LLM-based with iterative summary updating
- **Decision**: Use LLM-based summarization for context compaction. Adopt pi-agent's iterative summary updating: if a previous summary exists, merge new information into it rather than generating from scratch. Structured template: Goal/Instructions/Progress/Key Decisions/Next Steps/Relevant Files. Resolves D011 auto-compaction deferred item.
- **Rationale**: All three projects use LLM-based summarization. pi-agent's iterative approach is more token-efficient for repeated compactions (don't re-summarize what's already summarized). The structured template ensures consistent, useful summaries. opencode's prune-before-summarize is a good optimization to add later.
- **Date**: 2026-02-23

### D038: Compaction trigger — Token-based automatic
- **Decision**: Trigger compaction when `contextTokens > contextWindow - reserveTokens`. Default `reserveTokens = 16384`. Token estimation via chars/4 heuristic (like pi-agent). Configurable via settings.
- **Rationale**: All three projects use token-based triggers. pi-agent's chars/4 heuristic is simple and avoids a tiktoken dependency. The reserve ensures enough room for the next response. Users can disable via config (`compaction.enabled = false`).
- **Date**: 2026-02-23

### D039: Compaction — File operation tracking across compactions
- **Decision**: Track which files were read and modified during the session. Carry this information across compactions in `CompactionEntry.details`. Append file lists to the summary so the LLM maintains file awareness.
- **Rationale**: pi-agent's `CompactionDetails { readFiles, modifiedFiles }` pattern is valuable. After compaction, the LLM loses tool call history, but file operation tracking ensures it still knows which files exist and which were modified. Cumulative tracking (from previous compaction details + new messages) maintains a complete picture.
- **Date**: 2026-02-23

### D040: Session listing, resume, and forking
- **Decision**: Support session listing (`list()`), resume (`open(id)`), continue recent (`continueRecent()`), and forking (`forkFrom()`). Sessions listed by project, sorted by modification time.
- **Rationale**: Both pi-agent and opencode support session management. Essential for usability — users need to resume interrupted work and branch from decision points. pi-agent's implementation is the reference (JSONL-based). opencode's SQL queries are more powerful but we chose JSONL.
- **Date**: 2026-02-23

### D041: Context re-injection after compaction
- **Decision**: After compaction, explicitly re-inject initial context (system prompt, CLAUDE.md content, environment info) into the conversation. The summary alone may not capture these.
- **Rationale**: codex-rs's `InitialContextInjection` pattern addresses a real problem: compaction summaries capture conversation content but may miss system-level context. Re-injection ensures the LLM always has the current system prompt and instructions, even after heavy compaction. pi-agent and opencode rely on the summary carrying this, which can be lossy.
- **Date**: 2026-02-23

### D042: Deferred persistence — Write on first assistant message
- **Decision**: Don't create the session file until the first assistant message arrives. Prevents empty/abandoned session files.
- **Rationale**: pi-agent's deferred persistence pattern avoids cluttering the sessions directory with files from sessions where the user typed something but the LLM never responded (e.g., user aborted before response, connection error). Simple optimization with real usability benefit.
- **Date**: 2026-02-23

### D043: Session version migration
- **Decision**: Include a version number in the session header. Support forward migration on load (parse → detect version → transform if needed). Follow pi-agent's pattern of backward-compatible entry additions.
- **Rationale**: pi-agent's v1→v2→v3 migration demonstrates that session format evolves. JSONL makes migration straightforward (line-by-line parse and transform). Version in header enables detection without reading all entries.
- **Date**: 2026-02-23

### D044: Deferred Round 2 decisions
- **Deferred**: OS-level sandboxing (seatbelt, seccomp, Windows Sandbox) — resolve post-MVP if needed
- **Deferred**: Network proxy/domain control — resolve post-MVP
- **Deferred**: Enterprise/managed config layer — resolve when needed
- **Deferred**: Remote config (.well-known) — resolve when needed
- **Deferred**: Tree-sitter bash parsing for command-level permissions — resolve during implementation
- **Deferred**: Config template substitution ({env:VAR}, {file:path}) — add during implementation
- **Deferred**: Markdown-based agent/command definitions (.md with frontmatter) — resolve in L7
- **Deferred**: opencode's prune-before-summarize optimization — add during implementation if needed
- **Deferred**: Per-session permission ruleset persistence — resolve during implementation
- **Deferred**: Compaction plugin hooks — resolve in L7/L8
- **Date**: 2026-02-23
