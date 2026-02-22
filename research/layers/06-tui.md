# Layer 6: TUI (Terminal User Interface)

## Key Questions

1. How is terminal rendering done? (raw mode, alternate screen, ANSI codes, terminal library)
2. How is markdown rendered in-terminal? (syntax highlighting, code blocks, inline formatting)
3. How are spinners/progress indicators implemented?
4. What is the input handling model? (readline, custom input, key handling)
5. How does the TUI receive events from core? (callbacks, event bus, observer, direct)
6. Is there a client-server architecture between TUI and core?
7. How is the layout structured? (panels, panes, scrolling, resizing)
8. What are the key types/interfaces?
9. How does the TUI interface with layers above (user) and below (agent core)?
10. What are the trade-offs of each approach?

## codex-rs Analysis

### Architecture Overview

codex-rs uses **ratatui** (Rust TUI framework) with a **crossterm** backend for terminal rendering. The TUI is a dedicated crate (`codex-rs/tui/`) that is the largest crate in the project with 60+ source files. It uses a full alternate-screen, raw-mode terminal application pattern.

### Terminal Rendering

- **Library**: `ratatui` + `crossterm` backend
- **Mode**: Raw mode (`enable_raw_mode()`) + alternate screen (`EnterAlternateScreen`)
- **Features enabled**: Bracketed paste, keyboard enhancement flags (disambiguate escape codes, report event types, report alternate keys), focus change events
- **Frame scheduling**: Custom `FrameRequester` with `TARGET_FRAME_INTERVAL` (frame rate limiter) to avoid excessive redraws
- **Custom terminal**: `CustomTerminal<CrosstermBackend<Stdout>>` wrapping ratatui's Terminal with synchronized updates
- **Rendering model**: Immediate-mode rendering via ratatui's buffer-based approach: each frame, widgets render into a `Buffer`, and ratatui diffs against the previous frame to emit minimal ANSI sequences

Key file: `codex-rs/tui/src/tui.rs`

### Markdown Rendering

- **Library**: `pulldown_cmark` for Markdown parsing
- **Approach**: Converts Markdown AST to `ratatui::text::Text` (styled `Line`/`Span` structs)
- **`MarkdownStyles`** struct defines styles for h1-h6, code, emphasis, strong, strikethrough, links, blockquotes, list markers
- **Streaming**: `MarkdownStreamCollector` accumulates deltas, renders only fully completed logical lines (newline-gated). `commit_complete_lines()` returns newly completed lines since last commit. `finalize_and_drain()` emits remaining lines at end of stream.
- **Width awareness**: `render_markdown_text_with_width()` accepts optional width for adaptive line wrapping

Key files: `codex-rs/tui/src/markdown_render.rs`, `codex-rs/tui/src/markdown_stream.rs`, `codex-rs/tui/src/markdown.rs`

### Syntax Highlighting

- **Library**: `syntect` + `two_face` for grammar/theme bundles
- **Scope**: ~250 language grammars, 32 bundled color themes (swappable at runtime via `/theme` command)
- **Safety**: Rejects inputs >512 KB or >10,000 lines to prevent pathological CPU/memory usage
- **Global singletons**: `SYNTAX_SET` (grammar DB), `THEME` (active color theme behind `RwLock`)

Key file: `codex-rs/tui/src/render/highlight.rs`

### Spinners/Progress

- **Shimmer effect**: `shimmer_spans()` creates a sweeping gradient animation across text using per-character color blending. Uses `elapsed_since_start()` for time-based animation with 2-second sweep period.
- **True color support**: Detects 16-million-color support and falls back to bold/dim modifiers on 256-color terminals
- **Animation ticking**: `COMMIT_ANIMATION_TICK` at the target frame interval; streaming content is committed one line per tick for a smooth "typing" effect

Key file: `codex-rs/tui/src/shimmer.rs`

### Input Handling

- **Library**: crossterm event stream
- **Raw mode**: Full raw mode with keyboard enhancement flags for modifier disambiguation
- **Event types**: `TuiEvent` wraps crossterm events (key, mouse, resize, paste, focus)
- **Event broker**: `EventBroker` + `TuiEventStream` distribute terminal events
- **Key dispatching**: Top-level `App` processes key events via `crossterm::event::KeyEvent`
- **Job control**: Unix-specific `SuspendContext` for Ctrl+Z handling

### Event Reception from Core

- **Channel-based**: `mpsc::channel` with capacity 32,768 for thread events
- **`AppEvent` enum**: Internal message bus between UI components and the `App` loop
  - `CodexEvent(Event)` — wraps protocol events from core
  - `CodexOp(Op)` — forwards operations to the agent
  - `StartFileSearch`, `FileSearchResult` — async file search
  - `Exit`, `FatalExitRequest`, `NewSession`, `ClearUi`, etc.
- **`AppEventSender`**: Cloneable sender handle that widgets use to emit events without direct `App` access
- **Core connection**: `ThreadManager` from `codex-core` manages Codex sessions; events flow via bounded/unbounded channels

### Client-Server Architecture

codex-rs has a separate `app-server` crate that exposes the core via HTTP/WebSocket for external clients (IDE extensions, etc.). The TUI itself does NOT use this server — it communicates directly with `codex-core` via in-process Rust channels. However, the `app-server` exists as an alternative frontend and shares the same `app-server-protocol` types.

### Layout Structure

- **Alternate screen**: Full-screen ratatui application
- **Main layout**: Chat area (scrollable history) + bottom pane (input/status)
- **Renderable trait**: `trait Renderable { fn render(&self, area: Rect, buf: &mut Buffer); fn desired_height(&self, width: u16) -> u16; }` — custom rendering abstraction over ratatui
- **History cells**: Each message/event is a `HistoryCell` (scrollable list of rendered items)
- **Overlays**: Pager overlay, file search, model picker, approval popups
- **Bottom pane**: Chat composer (input), approval requests, status line, key hints
- **Streaming visualization**: `StreamController` manages newline-gated streaming with commit animation (one line per tick)

### Trade-offs

**Pros:**
- Full alternate-screen TUI with rich rendering (syntax highlighting, shimmer animations, diff rendering)
- Immediate-mode rendering with minimal diff updates (ratatui's buffer diffing)
- Sophisticated streaming visualization with smooth line-by-line animation
- Extensive keyboard handling with modifier key support
- Rich widget library (markdown, code blocks, diffs, file search, pickers)

**Cons:**
- Very complex: 60+ source files in the TUI crate alone
- Rust-specific libraries (ratatui, crossterm, syntect) — no direct TS equivalent
- Tight coupling between rendering and business logic in some areas
- Alternate-screen mode means no scrollback history in the terminal

---

## pi-agent Analysis

### Architecture Overview

pi-agent has a **custom TUI framework** (`packages/tui/`) written from scratch in TypeScript. It does NOT use alternate screen — it renders inline in the normal terminal flow using ANSI escape codes and differential rendering. The TUI package is a reusable component library; the actual agent UI is built in `packages/coding-agent/src/modes/interactive/`.

### Terminal Rendering

- **Library**: Custom implementation using raw ANSI escape codes
- **Mode**: Raw mode (`process.stdin.setRawMode(true)`) but NO alternate screen — renders inline
- **Differential rendering**: `TUI` class extends `Container`, tracks `previousLines[]`, and on each render only updates lines that changed
- **Cursor management**: Manual cursor positioning via ANSI `moveBy()`, `hideCursor()`, `showCursor()`
- **Bracketed paste**: Enabled via `\x1b[?2004h`
- **Kitty protocol**: Queries and enables Kitty keyboard protocol for better key disambiguation
- **StdinBuffer**: Splits batched input into individual sequences for correct key matching

Key files: `pi-agent/packages/tui/src/tui.ts`, `pi-agent/packages/tui/src/terminal.ts`

### Terminal Interface

```typescript
interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
}
```

### Component Model

```typescript
interface Component {
    render(width: number): string[];  // Returns ANSI-styled lines
    handleInput?(data: string): void;
    wantsKeyRelease?: boolean;
    invalidate(): void;
}

interface Focusable {
    focused: boolean;
}
```

Components return `string[]` (ANSI-styled lines), not a buffer abstraction. The TUI does line-level diffing.

### Markdown Rendering

- **Library**: `marked` (Markdown parser)
- **Approach**: Parses tokens from `marked`, applies ANSI styling via theme functions
- **`MarkdownTheme`**: Configurable styling for headings, links, code, codeBlock, quote, bold, italic, etc.
- **Syntax highlighting**: `highlightCode` function in theme (pluggable — the coding-agent provides highlighting)
- **Caching**: `cachedText/cachedWidth/cachedLines` for avoiding redundant re-renders
- **Width-aware**: Content width adjusted for padding

Key file: `pi-agent/packages/tui/src/components/markdown.ts`

### Spinners/Progress

- **`Loader` component**: Braille spinner animation (`["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]`) updating every 80ms via `setInterval`
- **`CancellableLoader`**: Loader with cancel/abort support
- **`BorderedLoader`**: Loader wrapped in a visual border (defined in coding-agent)
- **Message update**: `setMessage()` updates the loader text; triggers `ui.requestRender()`

Key file: `pi-agent/packages/tui/src/components/loader.ts`

### Input Handling

- **Custom editor component**: Full-featured input editor with multi-line support, undo/redo, kill-ring
- **`Editor` component**: Handles text input, cursor movement, selection, clipboard, history
- **Key matching**: `matchesKey(data, keyId)` — pattern-based key matching supporting Kitty protocol and legacy escape sequences
- **`StdinBuffer`**: Batched input splitting with timeout-based sequence parsing
- **Autocomplete**: `CombinedAutocompleteProvider` combines slash commands + file paths with fuzzy matching

Key files: `pi-agent/packages/tui/src/components/editor.ts`, `pi-agent/packages/tui/src/keys.ts`, `pi-agent/packages/tui/src/autocomplete.ts`

### Event Reception from Core

- **Direct callbacks**: `AgentSession` emits events via an `EventBus` pattern. `InteractiveMode` subscribes to session events and updates UI components directly.
- **Event types**: `AgentSessionEvent` includes `message_start`, `message_update`, `message_end`, `tool_execution_start/update/end`, `agent_start/end`, `turn_start/end`, `auto_retry_start/end`, `status_change`
- **No server**: TUI calls `AgentSession` methods directly (in-process)

### Client-Server Architecture

**No server between TUI and core.** The `InteractiveMode` class directly holds a reference to `AgentSession` and calls its methods (`prompt()`, `steer()`, `followUp()`, `abort()`). Events flow via in-process callbacks.

However, pi-agent does have an **RPC mode** (`rpc-mode.ts`) for external integrations, using JSON-RPC over stdin/stdout. This is separate from the TUI.

### Layout Structure

- **Inline rendering**: No alternate screen — content scrolls naturally in the terminal
- **Container model**: `TUI` extends `Container` which holds `Component[]` children rendered top-to-bottom
- **Overlay system**: Modal overlays rendered on top of base content with configurable positioning (`OverlayAnchor`, `OverlayMargin`, `OverlayOptions`)
- **Components used by coding-agent**: `AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `BashExecutionComponent`, `FooterComponent`, `Editor`, `Loader`, `Markdown`, `SelectList`, `SettingsList`, `Spacer`, `Text`
- **Focus management**: `setFocus(component)` — one focused component at a time, receives keyboard input
- **Hardware cursor**: Optional hardware cursor positioning via `CURSOR_MARKER` (APC sequence) for IME support

### Trade-offs

**Pros:**
- Inline rendering preserves terminal scrollback (can scroll up to see history)
- Lightweight custom framework with no native dependencies
- Clean component model (`Component` interface + `Container` composition)
- Differential rendering minimizes terminal output
- Overlay system for modals/pickers without alternate screen

**Cons:**
- Custom TUI framework is substantial effort to build and maintain
- ANSI-based rendering is less sophisticated than buffer-based (ratatui)
- No built-in layout engine (just top-to-bottom stacking)
- Inline rendering can have visual artifacts on resize

---

## opencode Analysis

### Architecture Overview

opencode has a **client-server architecture** where the TUI is a **Solid.js web application** rendered in a terminal via a **Bun Worker thread**. The backend runs an HTTP server (Hono framework) that exposes the agent's functionality via REST/SSE/WebSocket APIs. The TUI communicates with the backend entirely over HTTP.

### Terminal Rendering

- **Framework**: Solid.js (reactive web framework) with custom terminal rendering
- **Backend**: Hono HTTP server in a Worker thread
- **TUI entry**: `packages/opencode/src/cli/cmd/tui/` — spawns a worker thread for the backend, creates SDK client for communication
- **Web-based rendering**: The TUI is actually the `packages/app/` Solid.js application, adapted for terminal display
- **CLI UI utilities**: `packages/opencode/src/cli/ui.ts` provides ANSI styling constants and print helpers for non-TUI CLI output

### Component Architecture

opencode's TUI is built as a web application using Solid.js:
- **Router**: `@solidjs/router` with pages for Home, Session, DirectoryLayout
- **Providers**: Nested context providers for Commands, Permissions, Terminals, Settings, Models, Layout, etc.
- **Components**: `packages/ui/` provides reusable UI components (Button, Card, Dialog, Code, Diff, Markdown, etc.)
- **Themes**: CSS-based theming via `ThemeProvider`

### Markdown Rendering

- **Library**: `@opencode-ai/ui` package provides `Markdown` and `Code` components
- **`MarkedProvider`**: Provides markdown rendering context
- **Web-based**: Uses standard web rendering (HTML/CSS) rather than ANSI codes
- **Code highlighting**: Dedicated `Code` component with syntax highlighting

### Spinners/Progress

- Not observed in the terminal-specific code — uses web-based loading indicators through the Solid.js UI components

### Input Handling

- **Command palette**: `CommandProvider` / `useCommand` context provides keybinding management
- **`Keybind` interface**: `{ key, ctrl, meta, shift, alt }` — platform-aware (Mac detection)
- **`CommandOption`**: `{ id, title, description, keybind, slash, onSelect }` — commands with optional slash prefix
- **Signature-based matching**: Key events mapped to signatures (`key:modifierMask`) for O(1) lookup

### Event Reception from Core

- **SSE (Server-Sent Events)**: The TUI subscribes to backend events via SSE endpoint
- **SDK client**: `createOpencodeClient()` from `@opencode-ai/sdk/v2` provides typed API access
- **Bus-based backend events**: `Bus.publish()` emits events (MessageV2.Event.Updated, PartDelta, etc.)
- **Worker thread forwarding**: `GlobalBus.on("event", ...)` in the worker thread forwards events via RPC to the TUI process

### Client-Server Architecture

**Full client-server split with HTTP:**
- **Server**: Hono HTTP server with REST routes (`/session/*`, `/message/*`, `/config/*`, `/provider/*`, etc.) + SSE for real-time events + WebSocket support
- **Client**: SDK client that wraps HTTP calls with typed interfaces
- **Worker thread**: Backend runs in a Bun Worker thread, TUI runs in the main thread
- **Event streaming**: SSE endpoint publishes all Bus events to connected clients
- **Authentication**: Optional basic auth for server access

Routes: `TuiRoutes`, `SessionRoutes`, `ProjectRoutes`, `PtyRoutes`, `McpRoutes`, `FileRoutes`, `ConfigRoutes`, `ProviderRoutes`, `PermissionRoutes`, `QuestionRoutes`, `ExperimentalRoutes`

### Layout Structure

- **Web-based layout**: Standard web layout via Solid.js with router-based pages
- **Pages**: Home (session list), Session (chat interface), DirectoryLayout
- **Terminal embedding**: The web app is rendered in the terminal, likely via a terminal-compatible renderer (xterm.js or similar approach via Bun's built-in capabilities)
- **Layout context**: `LayoutProvider` manages scroll state, pane sizes

### Trade-offs

**Pros:**
- Client-server architecture enables multiple frontends (TUI, web, desktop, IDE extension)
- Web-based rendering allows rich UI (CSS theming, complex layouts, diff views)
- SDK client provides typed API for any consumer
- SSE/WebSocket for real-time updates
- Solid.js reactivity for efficient updates

**Cons:**
- Most complex architecture: HTTP server + Worker thread + SDK client + Solid.js app
- Heavy dependency chain (Hono, Solid.js, @solidjs/router, numerous UI packages)
- Latency overhead of HTTP between TUI and core (even if in-process via Worker)
- Harder to understand and debug compared to direct function calls
- Not a traditional terminal TUI — users on minimal terminals may have issues

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Language/Runtime** | Rust (tokio) | TypeScript (Node) | TypeScript (Bun) |
| **TUI Library** | ratatui + crossterm | Custom ANSI framework | Solid.js web app |
| **Screen Mode** | Alternate screen (full-screen) | Inline (no alternate screen) | Web-based (in terminal) |
| **Rendering Model** | Buffer-based diffing (ratatui) | Line-level differential rendering | Solid.js reactivity + virtual DOM |
| **Markdown Parser** | pulldown_cmark | marked | Web-based (MarkedProvider) |
| **Syntax Highlighting** | syntect + two_face (~250 languages) | Pluggable via theme function | Web-based Code component |
| **Spinner/Progress** | Shimmer gradient animation | Braille spinner (80ms interval) | Web-based loading |
| **Input Model** | crossterm KeyEvent | Custom key matching + StdinBuffer | Command palette + keybinds |
| **Core Communication** | In-process channels (mpsc) | In-process direct calls | HTTP (Hono server in Worker) |
| **Server Architecture** | Separate app-server (for IDE) | No server (RPC mode separate) | Full HTTP server between TUI and core |
| **Layout Model** | Full-screen with areas/rects | Top-to-bottom containers + overlays | Web layout (router, CSS) |
| **Raw Mode** | Yes (crossterm) | Yes (process.stdin) | N/A (web rendering) |
| **Alternate Screen** | Yes | No (inline) | N/A |
| **Component Abstraction** | `Renderable` trait | `Component` interface | Solid.js components |
| **Event Dispatch** | `AppEvent` enum via channels | Direct callbacks on AgentSession | SSE subscription via SDK |
| **Scrolling** | Custom scroll in alternate screen | Natural terminal scrollback | Web-based scroll |
| **Overlay/Popups** | Pager overlay, picker popups | Overlay stack with positioning | Dialog/modal web components |
| **Theme System** | syntect themes (32 bundled) | MarkdownTheme + custom themes | CSS themes via ThemeProvider |
| **Complexity** | Very high (60+ files, Rust crate) | High (custom framework ~15 files) | Very high (web stack + server) |
| **Terminal Compatibility** | Wide (crossterm handles platforms) | Wide (raw ANSI + Kitty) | Depends on terminal web rendering |

## Open Questions

1. **Alternate screen vs inline**: codex-rs uses alternate screen (clean, full control) vs pi-agent uses inline rendering (preserves scrollback). Which model is better for a coding agent? Inline preserves context history, alternate screen allows richer layouts.

2. **TUI framework choice**: codex-rs uses ratatui (Rust), pi-agent built custom (TS). For a Bun/TS project, options include: (a) custom ANSI framework like pi-agent, (b) Ink (React for terminals), (c) raw ANSI escape codes, (d) web-based like opencode.

3. **Client-server between TUI and core (D011)**: opencode's HTTP server enables multi-frontend but adds complexity and latency. codex-rs has a separate app-server for IDE extensions but the TUI uses direct calls. pi-agent uses direct calls only. Should the TUI communicate with core directly or through a server?

4. **Markdown rendering approach**: codex-rs renders to ratatui Spans, pi-agent to ANSI strings, opencode to web DOM. For a TS TUI, rendering markdown to ANSI-styled strings (pi-agent approach) is the most natural.

5. **Streaming visualization**: codex-rs has sophisticated newline-gated streaming with line-by-line commit animation. pi-agent uses simpler incremental markdown rendering. What level of streaming visualization sophistication is appropriate?

6. **Component model**: pi-agent's `Component` interface (`render(width): string[]` + `handleInput(data)` + `invalidate()`) is simple and effective. Is this sufficient or do we need a more structured approach (ratatui-style buffer rendering)?

7. **Syntax highlighting library for TS**: codex-rs uses syntect (Rust). pi-agent delegates to theme. For a TS project, options include Shiki, Prism.js, highlight.js, or tree-sitter-highlight.

8. **LSP integration in TUI (D026)**: codex-rs does not show LSP diagnostics in TUI. opencode has LSP integration. Should LSP feedback be displayed in the TUI, and how?

9. **Overlay/popup system**: Both codex-rs and pi-agent support overlays for pickers and modals. Pi-agent's overlay system with anchor-based positioning is more flexible. What overlay needs does a coding agent have?

10. **Multi-mode support**: pi-agent supports Interactive (TUI), Print (one-shot), and RPC modes. codex-rs is TUI-only. opencode has TUI and CLI Run. Which modes should diligent support from the start?
