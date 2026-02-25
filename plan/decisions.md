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
- **Confirmed** (2026-02-25): 15 AgentEvent types implemented in Phase 2. `MessageDelta` type introduced (`core/src/agent/types.ts`) to prevent ProviderEvent types leaking into L1 events — a boundary refinement that strengthened the L0/L1 separation.

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
- **Refined** (2026-02-24): `z.toJSONSchema()` replaced with `zod-to-json-schema` library — simpler and more reliable for converting Zod schemas to Anthropic API's JSON Schema format. Hand-rolled converter initially implemented, then replaced (commit `8649b94`).

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
- **REVISED by D036-REV** (2026-02-24): Session directory changed to `.diligent/sessions/<session-id>.jsonl` (project-local). See D036-REV in Memory System Decisions section.

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

## Round 3 Decisions (L6: TUI + L7: Slash Commands & Skills)

### D045: TUI rendering — Inline mode with custom ANSI framework
- **Decision**: Use inline terminal rendering (no alternate screen) with a custom ANSI-based component framework. Render components as ANSI-styled string arrays with line-level differential rendering. Adopt pi-agent's `Component` interface pattern: `render(width): string[]` + `handleInput(data)` + `invalidate()`.
- **Rationale**: Inline rendering preserves terminal scrollback history, which is valuable for a coding agent (users can scroll up to see previous context). pi-agent proves this approach works well in practice. codex-rs's alternate-screen ratatui approach is more sophisticated but loses scrollback. opencode's web-based approach (Solid.js) is too complex and requires a full web stack. A custom ANSI framework is the right level of abstraction for Bun/TS — lightweight, no native dependencies, and gives full control. The `Component` interface is minimal yet sufficient.
- **Alternatives considered**: ratatui (Rust only), Ink/React for terminals (heavy dependency, React overhead), opencode's Solid.js (over-engineered for TUI), alternate screen mode (loses scrollback)
- **Date**: 2026-02-23

### D046: No server between TUI and core (resolves D011)
- **Decision**: The TUI communicates with the agent core via direct in-process function calls. No HTTP server between TUI and core. Resolves D011 deferred item.
- **Rationale**: codex-rs and pi-agent both use direct in-process communication for their TUI. opencode's HTTP server adds complexity and latency for the primary use case (terminal UI). The server architecture makes sense for opencode because it enables web UI, desktop app, and IDE extensions — but for diligent's MVP, the TUI is the only frontend. An HTTP server can be added later (as codex-rs did with `app-server`) when IDE integration is needed. Starting with direct calls keeps the architecture simple and avoids premature abstraction.
- **Alternatives considered**: opencode's HTTP server (deferred — add when multiple frontends needed), JSON-RPC like pi-agent's RPC mode (deferred)
- **Date**: 2026-02-23

### D047: Markdown rendering — marked + ANSI styling
- **Decision**: Use `marked` (Markdown parser) with custom ANSI styling renderers for terminal output. Code blocks use a syntax highlighting library (Shiki or similar). Streaming markdown rendered incrementally with newline-gated commits.
- **Rationale**: pi-agent uses `marked` successfully for terminal markdown rendering. codex-rs uses `pulldown_cmark` (Rust equivalent). Both produce terminal-friendly output by converting markdown tokens to styled text. `marked` is mature, fast, and works well with Bun. Newline-gated streaming (render only completed lines during streaming, finalize remaining at end) from codex-rs is an excellent pattern for smooth streaming UX.
- **Date**: 2026-02-23

### D048: Input handling — Raw mode with Kitty protocol support
- **Decision**: Use raw mode (`process.stdin.setRawMode(true)`) with Kitty keyboard protocol detection/enablement for better key disambiguation. Implement a `StdinBuffer` for batched input splitting (pi-agent's pattern). Support bracketed paste mode.
- **Rationale**: pi-agent's input handling model is well-proven for Node/Bun TS. Kitty protocol provides reliable key modifier detection across modern terminals with graceful fallback for legacy terminals. `StdinBuffer` ensures components receive single events even when the terminal batches input.
- **Date**: 2026-02-23

### D049: Spinner — Braille spinner with configurable messages
- **Decision**: Implement spinners using braille animation characters (`["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]`) with 80ms update interval. Spinners display a configurable message alongside the animation.
- **Rationale**: pi-agent's braille spinner is clean, lightweight, and universally supported. codex-rs's shimmer gradient is visually impressive but requires true-color support and is more complex to implement. Braille spinners are the standard for CLI applications and work across all terminals.
- **Date**: 2026-02-23

### D050: Overlay system for modals and pickers
- **Decision**: Implement an overlay stack system for modal UI elements (model picker, session selector, approval dialogs). Overlays render on top of base content with configurable positioning. Follow pi-agent's pattern: `showOverlay(component, options): OverlayHandle`.
- **Rationale**: Both codex-rs and pi-agent implement overlay systems for interactive pickers and dialogs. Pi-agent's overlay API with anchor-based positioning and show/hide handles is clean and flexible. Essential for commands like `/model`, `/resume`, approval prompts.
- **Date**: 2026-02-23

### D051: Slash commands — Registry pattern with handler functions
- **Decision**: Implement slash commands as a registry of `{ name, description, handler, availableDuringTask, supportsArgs }` objects. Commands registered at startup from built-in definitions. Handler receives `(args: string, context: CommandContext)`. Start with ~15 essential commands.
- **Rationale**: pi-agent's if/else chain is too fragile for a growing command set. codex-rs's enum is Rust-specific. A registry pattern combines the best: named handlers (testable, modular), dynamic registration (extensions can add commands later), and O(1) lookup. The `CommandContext` provides access to session, TUI, config without tight coupling.
- **Alternatives considered**: Enum-based dispatch (Rust pattern, not idiomatic TS), if/else chain (pi-agent, fragile), template-only (opencode, too limited for UI commands)
- **Date**: 2026-02-23

### D052: Skills — SKILL.md with frontmatter, progressive disclosure
- **Decision**: Adopt the SKILL.md format with YAML frontmatter (`name`, `description`). Skills discovered from `~/.config/diligent/skills/`, project `.diligent/skills/`, and `.agents/skills/` (for cross-tool compatibility). Progressive disclosure: metadata always in system prompt, body loaded on invocation. Resolves D044 deferred item for markdown-based definitions.
- **Rationale**: All three projects converge on the SKILL.md with YAML frontmatter format — this is a de facto standard emerging across coding agents. Progressive disclosure (metadata always loaded, ~100 tokens; body loaded on demand) is critical for context efficiency. Cross-compatibility with `.agents/skills/` directory enables shared skills across tools.
- **Date**: 2026-02-23

### D053: Skill invocation — Implicit (LLM-driven) with explicit fallback
- **Decision**: Skills are available for implicit LLM invocation by default (skill metadata in system prompt, LLM can decide to use them). Users can also explicitly invoke via `/skill:name` or the skills picker. Skills can opt out of implicit invocation via `disable-model-invocation: true` in frontmatter.
- **Rationale**: codex-rs's implicit invocation model is the most seamless UX — the LLM reads skill metadata and decides when to use each skill. pi-agent requires explicit `/skill:name` which adds friction. The opt-out mechanism (`disable-model-invocation`) handles skills that should only be explicitly invoked (e.g., destructive operations).
- **Date**: 2026-02-23

### D054: Multi-mode support — Interactive + Print modes
- **Decision**: Support two modes from the start: Interactive (full TUI) and Print (one-shot, pipe-friendly). Interactive mode is the default. Print mode accepts input from stdin/args, outputs to stdout, exits when done.
- **Rationale**: pi-agent supports Interactive, Print, and RPC modes. Print mode is essential for scripting and piping (`echo "fix the bug" | diligent`). RPC mode can be added later for IDE integration. Two modes is the minimum viable set.
- **Date**: 2026-02-23

### D055: Deferred Round 3 decisions
- **Deferred**: Syntax highlighting library selection (Shiki vs tree-sitter-highlight vs highlight.js) — resolve during implementation
- **Deferred**: LSP diagnostics display in TUI (D026) — resolve during implementation if needed
- **Deferred**: Command palette (Cmd+Shift+P style) as alternative to slash commands — resolve post-MVP
- **Deferred**: Remote skill discovery (opencode's URL-based pull) — resolve post-MVP
- **Deferred**: Extension/plugin system scope — resolve in L8/L9 or post-MVP
- **Deferred**: Compaction plugin hooks (from D044) — resolve in L8 or post-MVP
- **Deferred**: RPC mode for IDE integration — resolve when needed
- **Deferred**: Custom theme loading from filesystem — resolve during implementation
- **Date**: 2026-02-23

## Round 4 Decisions (L8: MCP + L9: Multi-Agent)

### D056: MCP client — Official @modelcontextprotocol/sdk
- **Decision**: Use the official `@modelcontextprotocol/sdk` TypeScript SDK for MCP client implementation. Do not roll a custom MCP client.
- **Rationale**: opencode uses this SDK and it is the canonical TypeScript MCP implementation. codex-rs uses the `rmcp` Rust crate (also an official SDK). The official SDK handles protocol details, transport negotiation, and capability discovery. Rolling a custom client would duplicate significant work with no advantage. The SDK supports all three transport types (stdio, StreamableHTTP, SSE).
- **Date**: 2026-02-23

### D057: MCP transport — Stdio + StreamableHTTP (SSE fallback)
- **Decision**: Support two MCP transport types: Stdio (for local servers) and StreamableHTTP with SSE fallback (for remote servers). Follow opencode's pattern of trying StreamableHTTP first, falling back to SSE.
- **Rationale**: Stdio is essential for local MCP servers (the common case). StreamableHTTP is the modern remote transport. SSE is the legacy remote transport that many existing servers still use. opencode's try-HTTP-then-SSE pattern provides maximum compatibility with minimal complexity. OAuth deferred to post-MVP (see D063).
- **Date**: 2026-02-23

### D058: MCP config — Discriminated union (local/remote) in JSONC
- **Decision**: MCP servers configured in `diligent.jsonc` under an `mcp` key. Config uses a discriminated union on `type`: `local` (command + environment) or `remote` (url + headers). Each server has optional `enabled` and `timeout` fields.
- **Rationale**: opencode's discriminated union pattern is clean and type-safe with Zod (D012). The two types map directly to the two transport types (D057). Configuration follows D032 (JSONC) and D033 (3-layer hierarchy) — MCP servers can be defined at global, project, or CLI level. codex-rs's TOML format doesn't apply since we chose JSONC.
- **Date**: 2026-02-23

### D059: MCP tool integration — Convert to regular tools in registry
- **Decision**: MCP tools are converted to regular tool objects and registered in the tool registry (D014). Tool names are namespaced: `serverName_toolName`. MCP tools go through the same permission system as built-in tools (D027/D028).
- **Rationale**: Both codex-rs and opencode convert MCP tools into their respective tool systems. opencode's `convertMcpTool()` → `dynamicTool()` pattern is the model. MCP tools become indistinguishable from built-in tools in the LLM's tool list. Namespacing prevents collisions between servers. Same permission system means no special MCP permission logic needed.
- **Date**: 2026-02-23

### D060: MCP capabilities at MVP — Tools only
- **Decision**: Support MCP tools capability at MVP (listTools, callTool, ToolListChangedNotification). Defer MCP resources, prompts-as-commands, and elicitation to post-MVP.
- **Rationale**: Tools are the primary MCP use case. Resources add read-only data access (useful but not essential). opencode's prompts-as-commands pattern is elegant but requires L7 integration. codex-rs's elicitation support requires L3 integration. Starting with tools-only keeps the MCP surface area small and focused. Additional capabilities can be added incrementally.
- **Deferred**: MCP resources (listResources, readResource), MCP prompts as slash commands, MCP elicitation, MCP sampling
- **Date**: 2026-02-23

### D061: MCP lifecycle — Connect at startup, dynamic refresh via events
- **Decision**: Connect all configured MCP servers at startup (in parallel). Support dynamic tool list changes via ToolListChangedNotification. Defer runtime add/remove of servers to post-MVP.
- **Rationale**: opencode connects all servers in parallel at startup via `Promise.all()`. The ToolListChangedNotification from the MCP SDK signals when a server's tools change, triggering a registry refresh. Runtime server management (add/connect/disconnect) is useful but not essential for MVP. codex-rs's `Op::RefreshMcpServers` is the eventual target.
- **Date**: 2026-02-23

### D062: Multi-agent — TaskTool pattern (single tool, child sessions)
- **Decision**: Implement multi-agent via a single `task` tool (like opencode) that creates child sessions. Not the 5-tool interactive model (codex-rs) or the process-spawning model (pi-agent). Args: `description`, `prompt`, `subagent_type`, optional `task_id` for resume.
- **Rationale**: opencode's single-tool pattern is the right complexity level for a TypeScript/Bun agent. It leverages the existing session system (D036/D040) for isolation and persistence. codex-rs's 5-tool interactive model (spawn/send_input/resume/wait/close) is powerful but adds substantial complexity. pi-agent's process-spawning model has high overhead per agent. A single tool with agent type selection gives the LLM enough flexibility while keeping the implementation tractable.
- **Date**: 2026-02-23

### D063: Agent types — Code-defined with config override
- **Decision**: Define built-in agent types in code (like opencode): at minimum `general` (full access subagent) and `explore` (read-only subagent). Users can override, disable, or add agents via config `agent` section. Each agent has: name, description, mode, permission ruleset, optional model/prompt/steps.
- **Rationale**: opencode's agent definition pattern is the most flexible. Code-defined defaults ensure agents work out of the box. Config override enables customization without code changes. Two initial agent types cover the main use cases: `general` for tasks that need write access, `explore` for read-only codebase investigation. More roles (like codex-rs's `worker` and `monitor`) can be added later.
- **Date**: 2026-02-23

### D064: Sub-agent permission isolation — Explicit deny rules
- **Decision**: Sub-agent sessions created with explicit permission deny rules (like opencode): deny `todowrite`/`todoread` (no task list modification by sub-agents), deny `task` tool by default (prevents infinite nesting). Parent's permission system controls which agent types can be invoked.
- **Rationale**: opencode's explicit deny approach is more principled than codex-rs's blanket auto-approve. Auto-approving everything for sub-agents (codex-rs) bypasses the permission system entirely, which is convenient but reduces safety guarantees. Denying the `task` tool by default provides an implicit depth limit without a separate numeric configuration. Agent types that explicitly include `task` permission can spawn sub-agents (controlled nesting).
- **Date**: 2026-02-23

### D065: Sub-agent result format — Wrapped text with session ID
- **Decision**: Sub-agent results returned as text wrapped in `<task_result>` tags, along with the session ID for potential resumption. Result includes only the final text output, not the full conversation history.
- **Rationale**: opencode's result format is simple and effective. The `<task_result>` wrapper helps the LLM distinguish agent output from tool metadata. Including the session ID enables resume support (pass `task_id` to continue a previous agent's session). Full conversation history would be too large for the parent's context.
- **Date**: 2026-02-23

### D066: Deferred Round 4 decisions
- **Deferred**: MCP OAuth/authentication — resolve post-MVP (both codex-rs and opencode implement full OAuth flows, but it's complex)
- **Deferred**: MCP server mode (exposing diligent as an MCP server) — resolve post-MVP
- **Deferred**: MCP prompts as slash commands — resolve post-MVP (elegant bridge between L8 and L7)
- **Deferred**: MCP resources capability — resolve post-MVP
- **Deferred**: MCP elicitation — resolve post-MVP (requires L3 integration)
- **Deferred**: Runtime MCP server add/remove — resolve post-MVP
- **Deferred**: Interactive multi-agent communication (send_input, interrupt) — resolve post-MVP (codex-rs pattern)
- **Deferred**: Built-in parallel execution mode for sub-agents (pi-agent pattern) — resolve post-MVP
- **Deferred**: Agent generation from natural language (opencode pattern) — resolve post-MVP
- **Deferred**: Rich collaboration events for TUI (codex-rs's 10 event types) — resolve during implementation
- **Deferred**: Filesystem-based agent discovery (pi-agent's .md files) — resolve post-MVP
- **Deferred**: Extension/plugin system as alternative to MCP (pi-agent pattern, relates to D055) — resolve post-MVP
- **Date**: 2026-02-23

## Full Review Pass Decisions (Post Round 4)

### D067: Layer decomposition validated — No changes needed
- **Decision**: The 10-layer decomposition (L0-L9) is validated across all research rounds. No layers need to be merged, split, or reordered. The decomposition cuts along functional capability boundaries, which aligns with how all three reference projects organize their code.
- **Note**: Subsequently revised to 11 layers (L0-L10) by D077. The validation conclusion remains valid — D077 was a refinement (split two overloaded layers), not a structural change.
- **Rationale**: After researching all 10 layers across 3 projects:
  - Each layer represents a coherent, distinct concept (no "grab bags")
  - Layer boundaries are natural — they correspond to module/crate/directory boundaries in all three reference projects
  - No capabilities were discovered that don't fit into the existing layers
  - The dependency graph (L0 ← L1 ← L2/L3, L0 ← L4/L5, L1 ← L6/L7/L8/L9) is confirmed correct
  - Inter-layer interfaces are well-defined: tool system (L1) is the universal integration point for L2, L3, L7, L8, L9
- **Date**: 2026-02-23

### D068: Cross-layer consistency confirmed
- **Decision**: Early-round research (L0-L2) remains valid in light of later rounds (L3-L9). No updates needed to earlier research files.
- **Rationale**: Key cross-layer validations:
  - D014 (Map-based tool registry) confirmed as the integration point for L2 (core tools), L7 (slash commands), L8 (MCP tools), L9 (task tool)
  - D016 (tool context with approval hook) confirmed as the L1-L3 bridge — MCP and multi-agent tools use the same `ctx.ask()` pattern
  - D006/D036 (JSONL sessions) confirmed as the L0-L5-L9 bridge — sub-agent sessions use the same persistence format
  - D004 (Op/Event pattern) accommodates MCP events (tool list changed) and multi-agent events (spawn/wait/close) without changes
  - D033 (3-layer config hierarchy) accommodates MCP server config and agent type config without changes
- **Date**: 2026-02-23

### D069: Implementation order recommendation
- **Decision**: Recommended implementation order follows the layer numbering: L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9. L4 (Config) can be introduced in parallel with L2/L3. L5 (Session) can be introduced in parallel with L3/L4.
- **Rationale**: The dependency graph supports this order. L0-L2 form the core agent loop. L3 adds safety. L4-L5 add persistence/configuration. L6-L7 add user experience. L8-L9 add extensibility. The later layers (L8/L9) build on nearly everything below them, confirming they should be implemented last.
- **Date**: 2026-02-23

## Gap-Filling Decisions (Post Cycle 1 Review)

### D070: Denied tools removed from LLM tool list
- **Decision**: Tools that match "deny" permission rules are completely removed from the LLM's tool list, not left visible to fail at execution time.
- **Rationale**: opencode follows this pattern. Removing denied tools (a) saves context tokens — each tool definition costs ~100-200 tokens, (b) prevents the LLM from attempting denied operations and generating confusing error loops, (c) is cleaner than returning "permission denied" errors mid-execution. The LLM adapts naturally to the available tool set. If a tool is conditionally denied (pattern-based), it remains in the list and the specific invocation is checked at call time.
- **Date**: 2026-02-23

### D071: Tool execution progress via callback → event emission
- **Decision**: Tools emit progress during execution via an `onProgress(event)` callback in ToolContext. Progress events are forwarded to the agent event stream (D004/D007) as `tool_execution_update` events. This is the same pattern as pi-agent's `onUpdate` and opencode's `ctx.metadata()`.
- **Rationale**: All three projects support mid-execution progress (bash output streaming, file read progress). The callback approach maps cleanly to the EventStream pattern (D007). Tools call `ctx.onProgress({ type, data })`, the executor wraps it as an AgentEvent, and the EventStream delivers it to consumers (TUI, persistence, etc.).
- **Date**: 2026-02-23

### D072: Ripgrep — require system install, document in prerequisites
- **Decision**: Require ripgrep (`rg`) as a system dependency. Do not bundle or auto-download at MVP. Document as a prerequisite in README.
- **Rationale**: ripgrep is widely available via system package managers (brew, apt, cargo). Auto-downloading binaries adds complexity (platform detection, binary verification, storage location) that's not worth it for MVP. pi-agent auto-downloads but this adds significant code. opencode also downloads lazily but has more infrastructure. Can be revisited post-MVP.
- **Alternatives considered**: Bundle in npm package (binary size), auto-download like pi-agent (complexity), use Node.js glob/grep (much slower)
- **Date**: 2026-02-23

### D073: Config file — no locking at MVP, advisory warning
- **Decision**: No file locking for config files at MVP. If multiple instances detect concurrent modification (via mtime check), emit a warning. Use atomic write (write to temp file, rename) to prevent corruption.
- **Rationale**: File locking adds complexity (proper-lockfile dependency, cleanup on crash). The common case is single-instance usage. Atomic writes prevent the worst case (corrupted config). mtime-based detection catches the second-worst case (stale reads). Full locking can be added post-MVP if users report issues.
- **Date**: 2026-02-23

### D074: Config editing — read-modify-write with JSONC preservation deferred
- **Decision**: Config edits (via `/settings` or programmatic) use read-parse-modify-serialize-write. JSONC comment preservation is deferred — edits may strip comments in MVP. Warn users that programmatic edits may remove comments.
- **Rationale**: JSONC comment preservation requires a specialized parser that maintains the AST including comments (like `jsonc-parser` with edit operations). This is nice-to-have but not essential for MVP. Most config edits are infrequent. Users can be warned and manually re-add comments if needed.
- **Date**: 2026-02-23

### D075: Skill dependency validation deferred
- **Decision**: Defer skill dependency validation (checking that required MCP servers/tools are available before skill execution) to post-MVP.
- **Rationale**: codex-rs's `SkillDependencies` pattern is elegant but adds complexity. At MVP, skills that reference unavailable tools will simply fail at execution time with a clear error message. This is acceptable because (a) the failure is immediate and obvious, (b) most skills don't have complex dependencies, (c) dependency validation requires MCP connection state awareness which ties L7 to L8.
- **Date**: 2026-02-23

### D076: Research convergence — Cycle 2 not needed
- **Decision**: Cycle 1 research has converged. No Cycle 2 needed. All 103 open questions across 10 layers are resolved (94 by existing decisions, 9 by gap-filling decisions D070-D075). Layer decomposition, boundaries, ordering, and round grouping are stable.
- **Rationale**: Full evaluation in `plan/cycle1-review.md`. Outer loop exit criteria met:
  - Full cycle produced no fundamental new insights after review
  - All research files are coherent end-to-end (D068)
  - Layer boundaries and dependencies are stable (D067)
  - Decisions are consistent across all layers (D068)
  - Remaining gaps were implementation details, not architectural questions
- **Date**: 2026-02-23

## Layer Redesign Decisions (Post Convergence)

### D077: Layer redesign v2 — 10 → 11 layers
- **Decision**: Restructure from 10 to 11 layers by splitting two overloaded layers:
  1. Old L0 (REPL Loop) → **L0 (Provider)** + **L1 (Agent Loop)** — Provider is an independent subsystem in all 3 reference projects
  2. Old L7 (Slash Commands & Skills) → Commands merged into **L7 (TUI & Commands)**, Skills split to **L8 (Skills)** — Commands are imperative TUI actions, Skills are declarative LLM content
- **Rationale**:
  - **Provider split**: codex-rs has `codex-api` crate, pi-agent has `ai` package, opencode has `provider/` directory. All three separate the LLM client from the agent loop. Combining them in one layer would create an implementation unit too large and with two distinct concerns (protocol/streaming vs orchestration/state).
  - **Skills split**: Slash commands are dispatched from TUI input, trigger UI actions, make no sense outside TUI. Skills are filesystem-discovered content that affects LLM behavior via system prompt injection. Different consumers (TUI vs LLM), different lifecycles (runtime dispatch vs startup discovery), different extension points.
- **Impact**: All existing decisions remain valid. Only layer numbering changes. Research files and analysis are unaffected — the observations apply to the new structure without modification.
- **Date**: 2026-02-23

### D078: Implementation order updated for 11 layers
- **Decision**: L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9 → L10. Updates D069.
  - L0 (Provider): LLM abstraction — foundation, no dependencies
  - L1 (Agent Loop): core loop using L0
  - L2 (Tool System): framework consumed by L1
  - L3 (Core Tools): implementations of L2
  - L4 (Approval): permission layer for L2
  - L5 (Config): settings, parallelizable with L3/L4
  - L6 (Session): persistence, parallelizable with L4/L5
  - L7 (TUI & Commands): user interface + command dispatch
  - L8 (Skills): SKILL.md system, depends on system prompt (L1) and tool awareness (L2)
  - L9 (MCP): external tools, depends on L2 + L4 + L5
  - L10 (Multi-Agent): sub-agents, depends on L2 + L4 + L6
- **Date**: 2026-02-23

## Memory System Decisions (L6 Extension)

### D036-REV: Session storage location → project-local `.diligent/sessions/`
- **Decision**: Revise D036. Session directory changed from `~/.config/diligent/sessions/<project-hash>/` to `.diligent/sessions/<session-id>.jsonl` (project-local). All other aspects of D036 (JSONL format, tree structure, entry types) remain unchanged.
- **Rationale**: Global path (`~/.config/`) prevents portability (project migration loses sessions), sharing (team knowledge transfer), and easy backup. Project-local storage aligns with Claude Code's `.claude/` pattern. Compatible with D040 (session listing — path change only), D042 (deferred persistence — location-agnostic), and D052 (skill paths already include `.diligent/skills/`).
- **Revises**: D036
- **Date**: 2026-02-24

### D080: Project data directory `.diligent/` convention
- **Decision**: Store project runtime data in `.diligent/` directory. Layout: `sessions/`, `knowledge/`, `skills/`. Auto-generate `.diligent/.gitignore` excluding `sessions/` and `knowledge/` (skills are git-tracked per D052). Global config (`~/.config/diligent/`) remains settings-only (D033).
- **Rationale**: Separates config (global `~/.config/`) from data (project-local `.diligent/`), following XDG Base Directory Specification principles. Claude Code's `.claude/` provides precedent for project-local agent data. Auto-generated `.gitignore` prevents accidental commit of session/knowledge data.
- **Date**: 2026-02-24

### D081: Knowledge store — JSONL append-only with typed entries
- **Decision**: Accumulated knowledge stored in `.diligent/knowledge/knowledge.jsonl` as JSONL append-only. Each entry follows `KnowledgeEntry` schema: id, timestamp, sessionId, type, content, confidence, supersedes, tags. Five knowledge types: pattern, decision, discovery, preference, correction. Updates use `supersedes` field (append new entry referencing old).
- **Rationale**: Consistent with D006 (JSONL choice). Type classification enables priority ranking and filtering. `supersedes` pattern maintains append-only immutability while allowing knowledge updates. Vector DB (OpenClaw approach) deferred — adds embedding dependency unsuitable for MVP.
- **Date**: 2026-02-24

### D082: Knowledge extraction — `add_knowledge` tool with turn_end nudge
- **Decision**: Knowledge extraction via a dedicated `add_knowledge` tool that the agent calls directly, not a side-channel LLM. Three invocation paths: (1) user request ("기억해줘"), (2) agent autonomous (스스로 판단), (3) system nudge (turn_end 시 시스템 메시지 주입으로 판단 기회 보장). Emit `knowledge_saved` event.
- **Rationale**: Side-channel approach was rejected because: (a) it also relies on LLM judgment (can return empty), so no reliability advantage over tool, (b) uses partial context vs main model's full context, (c) incurs extra LLM cost per turn, (d) cannot support user-initiated knowledge recording. Tool approach naturally covers all three invocation paths with a single mechanism. Turn_end nudge preserves the "guaranteed judgment opportunity" benefit of side-channel without the cost.
- **Date**: 2026-02-24

### D083: Knowledge injection — system prompt section with token budget
- **Decision**: On new session start, load knowledge from `knowledge.jsonl`, rank by recency × confidence with type weighting, inject into system prompt "Project Knowledge" section. Default token budget: 8192. Budget configurable via `knowledge.injectionBudget`.
- **Rationale**: Claude Code's auto memory "always loaded" pattern. 8192 tokens is 5-10% of context window — sufficient knowledge without excessive context pressure. Time decay (OpenClaw temporal decay pattern, 30-day half-life) reflects decreasing relevance of old knowledge.
- **Date**: 2026-02-24

### D084: Knowledge-compaction interaction — flush before compact via prompt
- **Decision**: When compaction is triggered, prompt the agent to record any important knowledge via `add_knowledge` BEFORE running compaction (D037). Knowledge persists independently of session logs — survives compaction, session end, and session deletion.
- **Rationale**: Directly from OpenClaw's `memoryFlush` (`before_compaction` hook), adapted to tool-based approach (D082). Agent uses full conversation context to judge what would be lost in compaction. No side-channel needed — flush prompt is part of main conversation flow.
- **Date**: 2026-02-24

### D085: Export/import mechanism
- **Decision**: `diligent export/import` CLI commands for `.diligent/` data as tar.gz archive with `manifest.json`. Export supports `--sessions`, `--knowledge`, `--skills` flags. Import supports `merge` (default, append with dedup) and `replace` modes.
- **Rationale**: Project-local storage (D080) enables straightforward archiving. Portability (machine migration) and sharing (team knowledge transfer) are core motivations. tar.gz is platform-agnostic. Merge mode leverages knowledge `supersedes` chains for conflict-free merging.
- **Date**: 2026-02-24

## Codex Protocol Alignment (Cross-Cutting)

### D086: Codex protocol alignment strategy — SessionManager mediator + item abstraction + serialization contract
- **Decision**: Align Phase 3 architecture with codex-rs patterns to ensure a future web UI protocol layer (JSON-RPC 2.0 over WebSocket) can be added as a thin wrapper rather than a deep refactor. Three concrete changes:
  1. **SessionManager mediator**: Introduce a `SessionManager` class that wraps `agentLoop()` and owns session lifecycle (create, resume, fork, rollback). Both TUI and future protocol layer consume this single API surface instead of calling `agentLoop()` directly. SessionManager handles persistence (L6), compaction triggers (D037), and session state — the agent loop remains a pure stateless function.
  2. **Item abstraction via `itemId`**: Add an optional `itemId: string` field to grouped AgentEvent subtypes (`message_start/delta/end`, `tool_start/update/end`). Events sharing the same `itemId` form a logical item — equivalent to codex-rs's `item/started → item/delta(N) → item/completed` pattern. Existing consumers ignore the field (backward-compatible). A protocol layer maps `itemId` groups directly to codex-style item notifications.
  3. **Serialization contract**: All types that cross the core↔consumer boundary (AgentEvent, Message, session JSONL entries, knowledge entries) must be JSON-serializable. Enforce via `JSON.parse(JSON.stringify(x))` roundtrip assertions in tests. Closures, class instances with methods, and non-serializable state must never appear in event payloads or persistent entries.
- **Rationale**: The ultimate goal is a web UI consuming diligent via codex-like protocol (harness-friendly design). The gap analysis (`research/temp/web-ui-readiness.md`) identified 8 gaps between current architecture and codex-rs's app-server pattern. Gaps 2-4 (event granularity, bidirectional approval, thread/session model) can be pre-closed in Phase 3 with minimal overhead if designed in from the start. Retrofitting these patterns after Phase 3 would require breaking the session format and refactoring the TUI↔core boundary — compounding cost across Phase 4 and 5.
- **What to adopt from codex-rs**:
  - Thread/session lifecycle semantics (create/resume/fork/rollback) — maps naturally to D040
  - Item grouping pattern (not the 50+ event types, just the structural `itemId` concept)
  - Transport-agnostic core design (core knows nothing about stdio/ws/http)
  - Bidirectional approval readiness (D028 `ctx.ask()` returns rich response, not just boolean)
- **What to intentionally diverge from**:
  - Event count: keep 15-20 AgentEvent types, not 50+ (D004 rationale still valid)
  - Concurrency model: TypeScript async iterators, not Rust mpsc channels
  - API versioning: single version (solo developer, no backward-compat burden)
  - Init handshake / capability negotiation: defer to protocol layer introduction
- **Expand ApprovalRequest/Response types** (preparing D028/D029 for Phase 4 + protocol):
  - `ApprovalRequest` gains `toolName: string` and `details?: Record<string, unknown>` for pattern matching
  - `approve()` return type changes from `Promise<boolean>` to `Promise<ApprovalResponse>`
  - `ApprovalResponse = "once" | "always" | "reject"` (D029)
  - Phase 3 implementation still auto-returns `"once"` — type change only, no behavior change
- **Impact on Phase 3 scope**: Adds SessionManager design (~2h), itemId field (~1h), expanded approval types (~30min), serialization test convention (~30min). Total: ~half day of incremental work that prevents weeks of refactoring in Phase 4+.
- **References**: D004, D028, D029, D040, D046, research/temp/web-ui-readiness.md, research/temp/debug-web-ui.md
- **Date**: 2026-02-25
