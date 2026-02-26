# Layer 7: TUI & Commands

## Problem Definition

The TUI & Commands layer solves the problem of providing an interactive terminal user interface for the coding agent, including:

1. **Terminal rendering**: Displaying agent output (markdown, code, diffs, tool results) in a terminal with proper ANSI styling, efficient redrawing, and support for streaming content.
2. **Input handling**: Capturing and interpreting keyboard input in raw mode, supporting modifier keys, paste events, and platform-specific keyboard protocols (e.g., Kitty).
3. **Command dispatch**: Parsing and executing built-in slash commands (`/model`, `/new`, `/compact`, etc.) that control agent state, session management, or TUI-level actions.
4. **Streaming visualization**: Rendering LLM output incrementally as tokens arrive, with smooth animation and newline-gated commit strategies.
5. **Overlay/modal system**: Displaying pickers, selectors, and approval popups on top of the main chat content.
6. **Progress indication**: Showing spinners, loading animations, or status indicators while the agent is working.
7. **Multi-mode support**: Supporting interactive (TUI), print (one-shot), and potentially RPC modes.

This layer sits between the user and the agent core. It does NOT handle skill discovery, frontmatter parsing, or system prompt injection (those belong to L8 Skills). It DOES handle the slash command registry and dispatch, since commands are imperative TUI actions that directly manipulate UI state or trigger core operations.

## codex-rs Analysis

### Architecture

codex-rs implements a full alternate-screen TUI using **ratatui** (Rust terminal framework) with a **crossterm** backend. The TUI crate (`codex-rs/tui/`) is the largest crate in the project with 60+ source files. It uses ratatui's immediate-mode rendering model: each frame, widgets render into a `Buffer`, and ratatui diffs against the previous frame to emit minimal ANSI sequences.

Key architectural decisions:
- **Alternate screen mode**: The TUI takes over the entire terminal with `EnterAlternateScreen`, providing full layout control at the cost of losing terminal scrollback.
- **Raw mode with keyboard enhancement**: Enables crossterm raw mode plus keyboard enhancement flags (disambiguate escape codes, report event types, report alternate keys) for proper modifier key handling.
- **Frame rate limiting**: Custom `FrameRequester` with `TARGET_FRAME_INTERVAL` prevents excessive redraws. A `COMMIT_ANIMATION_TICK` at the target frame interval controls streaming line-by-line animation speed.
- **In-process communication**: The TUI communicates directly with `codex-core` via Rust channels (`mpsc::channel` with capacity 32,768). No HTTP server sits between TUI and core.

### Key Types/Interfaces

**Rendering abstraction** (`render/renderable.rs`):
```rust
pub trait Renderable {
    fn render(&self, area: Rect, buf: &mut Buffer);
    fn desired_height(&self, width: u16) -> u16;
    fn cursor_pos(&self, _area: Rect) -> Option<(u16, u16)> { None }
}
```
This trait is implemented for primitives (`&str`, `String`, `Span`, `Line`, `Paragraph`, `Option<R>`, `Arc<R>`) and compound types. Layout primitives include:
- `ColumnRenderable` -- vertical stacking (children top-to-bottom)
- `RowRenderable` -- horizontal stacking (children left-to-right with fixed widths)
- `FlexRenderable` -- Flutter-inspired flex layout with proportional space allocation
- `InsetRenderable` -- padding/margin via `Insets`

**Event system** (`app_event.rs`):
```rust
pub(crate) enum AppEvent {
    CodexEvent(Event),          // Protocol events from core
    CodexOp(Op),                // Forward operations to agent
    NewSession,                 // Start new session
    ClearUi,                    // Clear terminal
    Exit(ExitMode),             // Exit with shutdown or immediate
    OpenResumePicker,           // Open session picker
    ForkCurrentSession,         // Fork session
    StartFileSearch(String),    // Async file search
    FileSearchResult { ... },   // File search results
    DiffResult(String),         // Git diff result
    InsertHistoryCell(...),     // Add to chat history
    StartCommitAnimation,       // Begin streaming animation
    // ... 40+ more variants for UI state changes
}
```
`AppEventSender` is a cloneable sender handle that widgets use to emit events without direct `App` access. This decouples widget logic from the main application loop.

**Slash command enum** (`slash_command.rs`):
```rust
#[derive(EnumString, EnumIter, AsRefStr, IntoStaticStr)]
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    Model, Approvals, Permissions, Skills, Review, Rename,
    New, Resume, Fork, Init, Compact, Plan, Collab, Agent,
    Diff, Mention, Status, DebugConfig, Theme, Mcp, Apps,
    Logout, Quit, Exit, Feedback, Clear, Personality,
    // ... 35+ variants total
}
```
Each variant has properties: `description()`, `command()` (kebab-case name), `supports_inline_args()`, `available_during_task()`, and `is_visible()`. The enum ordering is the presentation order in the popup. Dispatch is via match in the `App` struct's event handler.

### Implementation Details

**Markdown streaming** (`markdown_stream.rs`):
The `MarkdownStreamCollector` is a newline-gated accumulator:
1. `push_delta(delta)` appends text to an internal buffer
2. `commit_complete_lines()` re-renders the full buffer via `pulldown_cmark`, returns only newly completed logical lines since last commit (lines after `\n`). Incomplete trailing lines are not emitted.
3. `finalize_and_drain()` emits all remaining lines at stream end
4. The commit animation tick drains one line per tick for a smooth "typing" effect

**Syntax highlighting**: Uses `syntect` + `two_face` for ~250 language grammars, 32 bundled color themes. Safety limits reject inputs >512 KB or >10,000 lines. Global `SYNTAX_SET` and `THEME` behind `RwLock`.

**Spinner/animation** (`shimmer.rs`): Creates a sweeping gradient animation across text using per-character color blending, not traditional character-based spinners. Uses true color when available, falls back to bold/dim modifiers on 256-color terminals.

**Command dispatch**: Commands are handled in the `App` struct's main event loop. When the user types a slash command, the TUI intercepts it before sending to the agent. Most commands trigger TUI-level actions (open picker, modify settings), while some forward operations to core (`/compact` -> `Op::Compact`, `/review` -> injects prompt as user input).

### Layer Boundaries

- **Above (User)**: User interacts via keyboard input in the terminal. TUI renders visual output.
- **Below (Agent Core)**: Direct in-process communication via `ThreadManager` from `codex-core`. Events flow through bounded/unbounded channels. `AppEvent::CodexOp(Op)` forwards operations; `AppEvent::CodexEvent(Event)` receives protocol events.
- **Separate app-server**: A separate `app-server` crate exposes the core via HTTP/WebSocket for IDE extensions, but the TUI does NOT use it.

---

## pi-agent Analysis

### Architecture

pi-agent implements a custom inline TUI framework (`packages/tui/`) written from scratch in TypeScript. It renders inline in the normal terminal flow using raw ANSI escape codes and line-level differential rendering. The TUI package is a reusable component library; the actual agent UI is built in `packages/coding-agent/src/modes/interactive/`.

Key architectural decisions:
- **Inline rendering (no alternate screen)**: Content scrolls naturally in the terminal, preserving scrollback history. This is the opposite of codex-rs's approach.
- **Custom ANSI framework**: No external TUI library. Uses raw ANSI escape codes for cursor positioning, line clearing, and styling.
- **Differential rendering**: The `TUI` class tracks `previousLines[]` and on each render only updates lines that changed. Uses synchronized output (`\x1b[?2026h`/`\x1b[?2026l`) to prevent flicker.
- **Component model**: Components return `string[]` (ANSI-styled lines), not a buffer abstraction. Simple and lightweight.
- **Kitty keyboard protocol**: Queries and enables Kitty keyboard protocol for better key disambiguation. Falls back to legacy escape sequences.

### Key Types/Interfaces

**Component interface** (`tui.ts`):
```typescript
interface Component {
    render(width: number): string[];    // Returns ANSI-styled lines
    handleInput?(data: string): void;   // Optional keyboard handler
    wantsKeyRelease?: boolean;          // Opt-in to key release events
    invalidate(): void;                 // Clear cached rendering state
}

interface Focusable {
    focused: boolean;  // Hardware cursor positioning via CURSOR_MARKER
}
```

**Container** -- vertical stacking of children:
```typescript
class Container implements Component {
    children: Component[] = [];
    addChild(component: Component): void;
    removeChild(component: Component): void;
    render(width: number): string[];  // Concatenates children's lines
}
```

**TUI** -- extends Container, manages the full rendering pipeline:
```typescript
class TUI extends Container {
    terminal: Terminal;
    private previousLines: string[] = [];
    private focusedComponent: Component | null = null;
    private overlayStack: { component, options, preFocus, hidden }[] = [];

    start(): void;
    stop(): void;
    setFocus(component: Component | null): void;
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    hideOverlay(): void;
    requestRender(force?: boolean): void;
}
```

**Overlay system** -- rich positioning options:
```typescript
interface OverlayOptions {
    width?: SizeValue;           // Absolute or percentage
    minWidth?: number;
    maxHeight?: SizeValue;
    anchor?: OverlayAnchor;      // 'center', 'top-left', etc.
    offsetX?: number;
    offsetY?: number;
    row?: SizeValue;             // Absolute or percentage positioning
    col?: SizeValue;
    margin?: OverlayMargin | number;
    visible?: (w, h) => boolean; // Dynamic visibility
}

interface OverlayHandle {
    hide(): void;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
}
```

**Terminal interface** (`terminal.ts`):
```typescript
interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    moveBy(lines: number): void;
    hideCursor() / showCursor(): void;
    clearLine() / clearFromCursor() / clearScreen(): void;
}
```

**Slash commands** (`slash-commands.ts`):
```typescript
interface BuiltinSlashCommand {
    name: string;
    description: string;
}

const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
    { name: "settings", description: "Open settings menu" },
    { name: "model", description: "Select model" },
    { name: "export", description: "Export session to HTML file" },
    // ... 18 total built-in commands
];
```

### Implementation Details

**Rendering pipeline**:
1. `requestRender()` schedules a render via `process.nextTick()` (coalesces multiple requests)
2. `doRender()` calls `this.render(width)` to get new lines from all children
3. Composites overlays into rendered lines using `compositeOverlays()`
4. Extracts hardware cursor position from `CURSOR_MARKER` sequences
5. Applies line resets (`\x1b[0m\x1b]8;;\x07`) to each line
6. Computes diff against `previousLines[]`: finds first/last changed line
7. Emits only changed lines wrapped in synchronized output to prevent flicker
8. Width change triggers full re-render (line wrapping changes)
9. Content shrink can optionally trigger clear (configurable via `setClearOnShrink`)

**Overlay compositing**:
Overlays are composited by splice-replacing characters at specific row/column positions in the base content. `compositeLineAt()` does a single-pass extraction of before/after segments, then inserts the overlay content with proper ANSI reset handling. A final verification ensures no line exceeds terminal width (crashes the TUI if this invariant is violated).

**Input handling**:
- `StdinBuffer` splits batched input into individual sequences
- `matchesKey(data, keyId)` pattern-based key matching supports both Kitty protocol and legacy escape sequences
- Global input listeners can intercept/transform input before the focused component
- Key release events are filtered by default unless component opts in via `wantsKeyRelease`

**Command dispatch** (`interactive-mode.ts`):
Commands are dispatched via an if/else chain in `InteractiveMode.onSubmit()`:
```typescript
this.defaultEditor.onSubmit = async (text: string) => {
    if (text === "/settings") { this.showSettingsSelector(); return; }
    if (text === "/model" || text.startsWith("/model ")) { ... }
    if (text === "/new") { await this.handleClearCommand(); return; }
    if (text === "/compact" || text.startsWith("/compact ")) { ... }
    // ... 18+ more commands
    // Handle skill commands
    // Handle bash shortcut (!)
    // Normal message: session.prompt(text)
};
```
Argument parsing is minimal: `text.startsWith("/command ") ? text.slice(N).trim() : undefined`.

**Autocomplete** (`autocomplete.ts`):
`CombinedAutocompleteProvider` merges multiple sources: built-in slash commands, extension commands, skill commands (`skill:name`), prompt templates, and file paths (via `fd` for fast directory traversal). Fuzzy matching via custom `fuzzyFilter()` and `fuzzyMatch()`.

**Loader/spinner** (`loader.ts`):
Braille spinner animation (`["⠋", "⠙", "⠹", ...]`) updating every 80ms via `setInterval`. `setMessage()` updates text; triggers `ui.requestRender()`.

### Layer Boundaries

- **Above (User)**: User interacts via keyboard in the terminal. Output scrolls inline.
- **Below (Agent Core)**: Direct in-process calls. `InteractiveMode` holds a reference to `AgentSession` and calls methods directly (`prompt()`, `steer()`, `followUp()`, `abort()`). Events flow via callback subscription (`session.subscribe()`).
- **RPC mode**: Separate `rpc-mode.ts` provides JSON-RPC over stdin/stdout for external integrations.

---

## opencode Analysis

### Architecture

opencode implements a radically different TUI architecture using a **Solid.js web application** rendered in the terminal via an **opentui** framework (a web-to-terminal renderer). The backend runs as an HTTP server (Hono framework) in a Bun Worker thread.

Key architectural decisions:
- **Web-based rendering**: The TUI is a Solid.js SPA with router-based pages, CSS themes, and web components. The `opentui` library renders web content to the terminal.
- **Client-server architecture**: Full HTTP separation between TUI (main thread) and backend (Worker thread). Communication via HTTP REST + SSE (Server-Sent Events).
- **SDK client**: `@opencode-ai/sdk/v2` provides typed API for the frontend.

### Key Types/Interfaces

**Command system** (`command.tsx`):
```typescript
interface CommandOption {
    id: string;
    title: string;
    description?: string;
    category?: string;
    keybind?: KeybindConfig;     // Keyboard shortcut string
    slash?: string;              // Slash command name
    suggested?: boolean;
    disabled?: boolean;
    onSelect?: (source?: "palette" | "keybind" | "slash") => void;
}

type CommandRegistration = {
    key?: string;
    options: Accessor<CommandOption[]>;  // Solid.js accessor
}
```

**Keybind system**:
```typescript
interface Keybind {
    key: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    alt: boolean;
}
```
Keybinds are parsed from string configs (e.g., `"mod+shift+p"`, `"ctrl+n"`). `mod` maps to Meta on Mac, Ctrl otherwise. Signature-based matching uses `key:modifierMask` for O(1) lookup.

**Command palette**: `CommandProvider` manages a reactive store of registrations. Commands can be invoked via:
1. **Command palette** (Cmd+Shift+P) -- fuzzy search all commands
2. **Keybind** -- direct keyboard shortcut
3. **Slash** -- `/command` in the input field

**Backend command model** (`command/index.ts`):
```typescript
namespace Command {
    const Info = z.object({
        name: z.string(),
        description: z.string().optional(),
        agent: z.string().optional(),     // Which agent handles this
        model: z.string().optional(),     // Override model
        source: z.enum(["command", "mcp", "skill"]).optional(),
        template: z.promise(z.string()).or(z.string()),
        subtask: z.boolean().optional(),  // Run as subtask
        hints: z.array(z.string()),       // Template variables ($1, $2, $ARGUMENTS)
    })
}
```
This is the unified backend command model -- all "commands" are template-based prompt generators. Built-in commands (`init`, `review`), user-defined commands (from config), MCP prompts, and skills all map to this same interface.

**Spinner** (`spinner.ts`):
A Knight Rider-style scanner animation with gradient trail colors. Uses `opentui-spinner` for terminal rendering. Supports bidirectional movement, hold frames, alpha-based fading, and configurable color trails. Significantly more sophisticated than pi-agent's braille spinner.

### Implementation Details

**Rendering pipeline**:
opencode uses `opentui` (a framework that renders Solid.js components to the terminal). The rendering pipeline is:
1. Solid.js reactive system detects state changes
2. Components re-render via Solid.js's fine-grained reactivity
3. `opentui` converts the component tree to terminal output (ANSI sequences)
4. Terminal output is written via the terminal abstraction

**TUI entry point** (`tui/thread.ts`):
The TUI spawns a Worker thread for the backend HTTP server, creates an SDK client, and renders the Solid.js app. Events from the backend arrive via SSE.

**Command dispatch**:
Unlike codex-rs and pi-agent where commands are TUI-local actions, opencode's commands are sent to the backend as messages. The backend processes the template, substitutes variables, and creates agent messages. This means there's no separate concept of "UI-only commands" -- everything goes through the same template-based pipeline.

However, the `CommandOption` system on the frontend handles keybinds and UI actions (opening dialogs, toggling settings) that never touch the backend.

### Layer Boundaries

- **Above (User)**: Web-like UI rendered in the terminal. Command palette for discovery.
- **Below (Backend)**: Full HTTP client-server. SDK client wraps REST calls. SSE for real-time events. Backend runs in a Bun Worker thread.
- **Server reuse**: The same HTTP server can serve web browsers, IDE extensions, or CLI clients.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Language** | Rust (tokio) | TypeScript (Node) | TypeScript (Bun) |
| **TUI Library** | ratatui + crossterm | Custom ANSI framework | opentui (Solid.js) |
| **Screen Mode** | Alternate screen | Inline (no alt screen) | Web-based in terminal |
| **Rendering Model** | Buffer-based diffing | Line-level string diffing | Solid.js reactivity |
| **Component Interface** | `Renderable` trait | `Component` interface | Solid.js components |
| **Layout System** | Column/Row/Flex/Inset | Top-to-bottom Container | CSS/web layout |
| **Overlay System** | Pager overlay, popups | Overlay stack with anchors | Web dialogs/modals |
| **Markdown Parser** | pulldown_cmark | marked | MarkedProvider (web) |
| **Syntax Highlighting** | syntect (~250 langs) | Pluggable theme function | Web Code component |
| **Streaming** | Newline-gated + tick animation | Incremental markdown render | Reactive updates |
| **Spinner** | Shimmer gradient animation | Braille (80ms interval) | Knight Rider scanner |
| **Input Model** | crossterm KeyEvent | Custom matchesKey + StdinBuffer | Web keyboard events |
| **Kitty Protocol** | Yes (crossterm flags) | Yes (custom detection) | N/A (web) |
| **Raw Mode** | Yes (crossterm) | Yes (process.stdin) | N/A |
| **Core Communication** | In-process channels | In-process direct calls | HTTP (Worker thread) |
| **Command Definition** | Rust enum (35+ variants) | Array of 18 objects | CommandOption + Info |
| **Command Dispatch** | Enum match in App | if/else in onSubmit | Template substitution |
| **Command Arguments** | `supports_inline_args()` | Manual string splitting | Template vars ($1, $2) |
| **Command Palette** | No (slash only) | No (slash only) | Yes (Cmd+Shift+P) |
| **Command Sources** | Built-in enum only | Built-in + extensions | Built-in + config + MCP + skills |
| **Keybind System** | crossterm key events | matchesKey + KeyId | Signature-based O(1) |
| **Autocomplete** | Fuzzy on skill names | CombinedProvider (5 sources) | Command palette hints |
| **Complexity** | Very high (60+ files) | High (custom framework) | Very high (web stack) |
| **Terminal Compat** | Wide (crossterm) | Wide (raw ANSI + Kitty) | Depends on opentui |

## Synthesis

### Common Patterns

1. **Immediate rendering + diffing**: All three projects minimize terminal output by comparing current and previous frames. codex-rs uses ratatui's buffer diff, pi-agent uses line-level string comparison, opencode uses Solid.js reactivity.

2. **Raw mode input**: Both codex-rs and pi-agent use raw terminal mode for immediate key-by-key input. Both support Kitty keyboard protocol for modifier disambiguation.

3. **Component-based architecture**: All three use component-based rendering. codex-rs's `Renderable` trait, pi-agent's `Component` interface, and opencode's Solid.js components all encapsulate rendering logic.

4. **Overlay/modal system**: All three support overlay rendering for pickers, selectors, and confirmation dialogs. pi-agent's system is most flexible with anchor-based positioning and visibility callbacks.

5. **Slash commands as TUI actions**: In codex-rs and pi-agent, slash commands are primarily TUI-level actions (open pickers, modify settings, trigger operations). opencode unifies commands as template-based prompts, blurring the line between UI actions and agent prompts.

6. **In-process over HTTP**: codex-rs and pi-agent prefer in-process communication between TUI and core (direct function calls or channels). opencode uses HTTP but acknowledges this adds latency and complexity.

7. **Newline-gated streaming**: codex-rs's `MarkdownStreamCollector` waits for newline characters before committing rendered lines, preventing partial/flickering renders during streaming. This is a critical pattern for smooth streaming visualization.

### Key Differences

1. **Alternate screen vs inline**: codex-rs uses alternate screen (full control, rich layout, but no scrollback). pi-agent uses inline (preserves scrollback, simpler, but less layout control). This is a fundamental UX trade-off.

2. **Command dispatch model**:
   - codex-rs: Compile-time-safe enum match with exhaustiveness checking
   - pi-agent: Runtime if/else chain (simple, flexible, but error-prone)
   - opencode: Template substitution (unified, but no UI-only commands)
   - A **registry pattern with handler functions** (D051) is the middle ground.

3. **TUI framework choice**: codex-rs uses an established framework (ratatui). pi-agent built a custom framework from scratch. opencode uses a web framework. For a TS project, the pi-agent approach (custom ANSI framework) is most appropriate -- Ink (React for terminals) is an alternative but adds React dependency overhead.

4. **Command extensibility**: codex-rs has no user-defined commands (only skills). pi-agent allows extension-registered commands. opencode supports config-defined commands. A registry pattern naturally supports all sources.

5. **Streaming visualization sophistication**: codex-rs has the most sophisticated streaming (newline-gated + line-per-tick animation). pi-agent uses simpler incremental rendering. The newline-gated approach is clearly superior for avoiding flickering partial renders.

### Best Practices Identified

1. **pi-agent's Component interface** is the ideal abstraction for a TS inline TUI: `render(width): string[]` + `handleInput(data)` + `invalidate()`. Simple, testable, no external dependencies.

2. **Synchronized output** (`\x1b[?2026h`/`\x1b[?2026l`) wrapping all terminal writes prevents flicker during multi-line updates. Both pi-agent and codex-rs use this.

3. **Newline-gated streaming** from codex-rs prevents partial line flickering. Buffer text, commit only complete lines, finalize at stream end.

4. **Overlay compositing** by line-level splicing (pi-agent) works well for inline TUIs without alternate screen. The anchor/margin/visibility system provides flexible positioning.

5. **StdinBuffer** for splitting batched input sequences is essential for correct key matching in raw mode.

6. **Command registry pattern** (D051) with handler functions: Each command has `{ name, description, handler, supportsArgs, availableDuringTask }`. Registration from multiple sources (built-in, user config, extensions).

7. **Hardware cursor positioning** via zero-width marker sequences (pi-agent's `CURSOR_MARKER`) enables proper IME support in inline rendering.

## Open Questions

1. **Inline vs alternate screen**: D045 chose inline mode with pi-agent's Component interface. Cycle 2 confirms this is the right choice -- inline preserves scrollback and is simpler to implement. But the overlay system needs to handle the absence of full-screen layout.

2. **Streaming commit strategy**: Should we adopt codex-rs's line-per-tick animation (smooth but complex) or pi-agent's simpler incremental rendering? The newline-gating (D047) is essential; the tick animation is a polish feature.

3. **Command registry design**: D051 chose a registry pattern. What should the handler signature look like? Should handlers be sync or async? How should command state (available during task, inline args) be declared?

4. **Multi-mode architecture**: D054 chose Interactive + Print modes. How does the TUI layer expose its rendering pipeline for non-interactive modes? Print mode needs the same markdown rendering but without the TUI event loop.

5. **Syntax highlighting library**: For TS, options include Shiki (VS Code's highlighter, WASM-based, heavy), highlight.js (lightweight, many languages), or tree-sitter-highlight (accurate but native). pi-agent delegates to a pluggable theme function.

6. **Terminal capability detection**: Both codex-rs and pi-agent detect Kitty protocol support and true color capabilities. What's the minimum capability set we should require vs. gracefully degrade?

7. **Width tracking invariant**: pi-agent crashes the TUI if any rendered line exceeds terminal width (a defensive measure). Is this the right approach, or should we silently truncate?
