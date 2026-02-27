# Project Status

## Current Phase

**Phase 4c DONE** — Print Mode + Collaboration Modes.

Phase 4 is split into three sub-phases:
- **Phase 4a**: TUI Component Framework + Overlay System (DONE)
- **Phase 4b**: Skills + Slash Commands (DONE)
- **Phase 4c**: Print Mode + Collaboration Modes (DONE) — 575 tests passing

**Phase 4c delivered:**
- Print mode: stdin pipe detection (`echo "..." | diligent`)
- `--mode` CLI flag with validation
- Collaboration modes: `ModeKind` ("default" | "plan" | "execute"), tool filtering in agent loop, mode system prompt injection
- `/mode` command + ListPicker overlay, status bar `[plan]`/`[execute]` chip
- `ModeChangeEntry` in session JSONL, SESSION_VERSION bumped 2 → 3
- 62 new tests across mode-filter, status-bar-mode, mode-command, session-mode, config-schema

**Deferred from 4c:**
- Bash allowlist/denylist for plan mode (D087a)
- `request_user_input` tool in plan mode
- Per-mode model override
- L4 (approval system) integration

Deferred to a future phase (post-Phase 4):
- **Approval System** (L4 FULL, wired to TUI overlays, D027-D031)

## Phases Complete

| Phase | Completed | Key Artifacts |
|---|---|---|
| Phase 0: Skeleton | 2026-02-24 | Monorepo scaffolding, core type definitions (AgentEvent, Tool, EventStream, Provider interfaces) |
| Phase 1: Minimal Agent | 2026-02-24 | Agent loop (180 lines), EventStream (86 lines), Anthropic provider, bash tool, readline TUI, E2E test package |
| Phase 2: Functional Coding Agent | 2026-02-25 | All 7 core tools, full 15 AgentEvent types, retry with exponential backoff, markdown rendering, spinner, auto-truncation (D025), ~2,300 lines of production code |
| Phase 3a: Config & Session Persistence | 2026-02-25 | D086 protocol readiness (itemId, SerializableError, ApprovalResponse), .diligent/ directory convention, JSONC config (3-layer hierarchy, Zod schema, env overrides), CLAUDE.md discovery (findUp + .git boundary), JSONL session persistence (DeferredWriter, tree structure), context builder (tree→linear), SessionManager mediator, EventStream.subscribe() observer, CLI --continue/--list flags, 254 tests |
| Phase 3b: Compaction, Knowledge & Multi-Provider | 2026-02-25 | Compaction system (token estimation, LLM summarization, file operation tracking, proactive + reactive triggers), Knowledge store (JSONL, ranked injection, add_knowledge tool, 30-day time decay), OpenAI Responses API provider, model registry with alias resolution, provider selection by model prefix, 18 AgentEvent types, SESSION_VERSION 2, 323 tests |
| Phase 4a: TUI Component Framework | 2026-02-26 | Component interface (render/handleInput/invalidate), TUI renderer with line-level diffing + synchronized output, overlay stack with compositing, StdinBuffer for input splitting, Kitty keyboard protocol, InputEditor with cursor/history/Ctrl shortcuts, MarkdownView with newline-gated streaming, SpinnerComponent, StatusBar, ChatView (AgentEvent handler), ConfirmDialog overlay, Container layout, app.ts rewritten to component-based architecture, 404 tests |
| Phase 4b: Skills + Slash Commands | 2026-02-27 | Skill system (L8): SKILL.md frontmatter parsing, multi-location discovery (.diligent/skills, .agents/skills, ~/.config/diligent/skills, config paths), first-loaded-wins dedup, progressive disclosure (metadata in system prompt, body on demand), extractBody. Command system (L7): CommandRegistry with register/lookup/alias/complete, parseCommand with /command args and /skill:name patterns, double-slash escape. 15 built-in commands (/help, /model, /new, /resume, /status, /compact, /clear, /exit, /version, /config, /cost, /bug, /reload, /skills, /skill:*). ListPicker overlay component with type-to-filter and scrolling. InputEditor Tab autocomplete for commands. App integration: command dispatch in handleSubmit, CommandContext, reloadConfig. Config schema gains skills section, system prompt gains skillsSection parameter. 513 tests |
| Phase 4c: Print Mode + Collaboration Modes | 2026-02-27 | Print mode: stdin pipe detection (echo "..." \| diligent). --mode CLI flag. ModeKind type ("default"\|"plan"\|"execute") + PLAN_MODE_ALLOWED_TOOLS + MODE_SYSTEM_PROMPT_PREFIXES in agent/types.ts. Tool filtering for plan mode in loop.ts. Mode system prompt prefix injection. ModeChangeEntry session entry type, SESSION_VERSION 2→3, appendModeChange() on SessionManager. mode field in DiligentConfigSchema + AppConfig. /mode command (direct switch + ListPicker overlay). Status bar [plan]/[execute] chip. App factory agentConfig + setMode() wired to SessionManager. 575 tests |

## Backlog

4 pending items. See `BACKLOG.md` for full details.

- **P1**: Per-tool output limits (core loop quality)
- **P2**: Context budget for compaction, background async piggyback (future capabilities)
- **P3**: Debug-viewer type sync (opportunistic)