# Phase 4a: TUI Component Framework

## Goal

The agent has a proper terminal UI framework — component-based rendering with line-level diffing, overlay/modal support, Kitty keyboard protocol, and smooth streaming visualization. This foundation enables Phase 4b (approval dialogs) and Phase 4c (slash commands, pickers, collaboration modes).

## Prerequisites

- Phase 3b artifact: SessionManager, JSONL persistence, compaction, knowledge, multi-provider. All existing TUI features working (markdown rendering, spinner, streaming, input handling).
- All Phase 3b tests passing (`bun test` — 323 tests).
- Existing TUI code in `packages/cli/src/tui/` (app.ts, terminal.ts, input.ts, markdown.ts, spinner.ts).

## Artifact

A Component-based TUI that renders inline (no alternate screen), supports keyboard-driven input with Kitty protocol, displays overlays on top of base content, and renders streaming markdown with newline-gated commits.

**Demo 1 — Component-based rendering:**
```
$ bunx diligent
diligent> explain what this project does

  This project is a coding agent built with Bun...
  [streaming markdown renders line-by-line as tokens arrive]
  [spinner shows during tool execution]

diligent> _  ← cursor blinks, IME works via CURSOR_MARKER
```

**Demo 2 — Overlay system:**
```
diligent> [Ctrl+C during tool execution]

  ┌─ Abort? ──────────────────────┐
  │ Cancel the current operation? │
  │                               │
  │  [Yes]    [No]                │
  └───────────────────────────────┘

[overlay composited on top of chat content]
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L7 (TUI) | Major rewrite | Component interface, TUI renderer with line-level diffing, overlay stack, StdinBuffer, Kitty protocol, InputEditor, MarkdownView, SpinnerComponent, ChatView — replaces current readline-based TUI |
| L1 (Agent Loop) | No change | — |
| L2 (Tool System) | No change | — |

**Not touched:** L0 (Provider), L1 (Agent Loop), L2 (Tool System), L3 (Core Tools), L4 (still auto-approve — Phase 4b), L5 (Config — no new config fields), L6 (Session — no change), L8, L9, L10.

## File Manifest

### packages/cli/src/tui/framework/

New directory for the component framework. Separates reusable TUI primitives from application-specific components.

| File | Action | Description |
|------|--------|------------|
| `types.ts` | CREATE | Component, Focusable, OverlayOptions, OverlayHandle interfaces |
| `terminal.ts` | CREATE | Enhanced Terminal class — synchronized output, Kitty protocol, cursor management. Replaces old `tui/terminal.ts` |
| `stdin-buffer.ts` | CREATE | StdinBuffer for splitting batched input sequences |
| `keys.ts` | CREATE | Key matching (matchesKey), key constants, Kitty protocol sequence parsing |
| `renderer.ts` | CREATE | TUI renderer — line-level differential rendering, overlay compositing |
| `container.ts` | CREATE | Container component — vertical stacking of children |
| `overlay.ts` | CREATE | Overlay stack management — show/hide/composite |

### packages/cli/src/tui/components/

Application-specific components built on the framework.

| File | Action | Description |
|------|--------|------------|
| `input-editor.ts` | CREATE | Text input with cursor, multi-line support, prompt display |
| `markdown-view.ts` | CREATE | Streaming markdown renderer as Component (rewrites markdown.ts) |
| `spinner.ts` | CREATE | Spinner as Component (rewrites spinner.ts) |
| `chat-view.ts` | CREATE | Main conversation view — message list, streaming output, tool execution display |
| `status-bar.ts` | CREATE | Bottom status bar — model name, token usage, session info |
| `confirm-dialog.ts` | CREATE | Simple yes/no dialog overlay (used for abort confirmation, foundation for Phase 4b approval dialog) |

### packages/cli/src/tui/

| File | Action | Description |
|------|--------|------------|
| `app.ts` | REWRITE | Migrate from raw readline loop to Component-based architecture using TUI renderer |
| `terminal.ts` | DELETE | Replaced by `framework/terminal.ts` |
| `input.ts` | DELETE | Replaced by `components/input-editor.ts` |
| `markdown.ts` | DELETE | Replaced by `components/markdown-view.ts` |
| `spinner.ts` | DELETE | Replaced by `components/spinner.ts` |
| `tools.ts` | No change | Tool array builder unchanged |
| `runner.ts` | No change | Non-interactive runner unchanged (Phase 4c) |

### packages/cli/src/

| File | Action | Description |
|------|--------|------------|
| `index.ts` | MODIFY | Update imports for new TUI structure |

### Tests

| File | Action | Description |
|------|--------|------------|
| `packages/cli/src/tui/framework/__tests__/stdin-buffer.test.ts` | CREATE | StdinBuffer splitting tests |
| `packages/cli/src/tui/framework/__tests__/keys.test.ts` | CREATE | Key matching and Kitty protocol parsing tests |
| `packages/cli/src/tui/framework/__tests__/renderer.test.ts` | CREATE | Line-level diffing logic tests |
| `packages/cli/src/tui/framework/__tests__/overlay.test.ts` | CREATE | Overlay compositing tests |
| `packages/cli/src/tui/components/__tests__/markdown-view.test.ts` | CREATE | Streaming markdown rendering tests |
| `packages/cli/src/tui/components/__tests__/input-editor.test.ts` | CREATE | Input component key handling tests |

## Implementation Tasks

### Task 1: Component Interface & Types

**Files:** `framework/types.ts`
**Decisions:** D045, D050

Define the core abstractions that all components implement and the overlay system types.

```typescript
// framework/types.ts

/** Core component interface — pi-agent's proven pattern */
export interface Component {
  /** Render to ANSI-styled lines for the given terminal width */
  render(width: number): string[];
  /** Handle raw input data (optional — not all components are interactive) */
  handleInput?(data: string): void;
  /** Whether this component wants key release events (Kitty protocol) */
  wantsKeyRelease?: boolean;
  /** Clear cached rendering state, forcing full re-render */
  invalidate(): void;
}

/** Components that can receive hardware cursor focus */
export interface Focusable {
  focused: boolean;
}

/** Size value — absolute pixels or percentage of terminal dimension */
export type SizeValue = number | `${number}%`;

/** Overlay positioning options */
export interface OverlayOptions {
  width?: SizeValue;
  minWidth?: number;
  maxHeight?: SizeValue;
  anchor?: "center" | "bottom-center" | "top-left";
  offsetX?: number;
  offsetY?: number;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

/** Handle returned when showing an overlay */
export interface OverlayHandle {
  hide(): void;
  isHidden(): boolean;
  setHidden(hidden: boolean): void;
}

/** Zero-width cursor marker — components embed this where the hardware cursor should be */
export const CURSOR_MARKER = "\x1b[?25h\x1b[?8c";
```

> The `Component` interface uses `render(width): string[]` rather than a buffer abstraction because inline rendering (D045) works with lines, not a 2D grid. Each string in the array is one terminal line with ANSI escape codes for styling. This is pi-agent's proven pattern.

**Verify:** `bun run typecheck` passes. Types are importable from the framework directory.

---

### Task 2: Enhanced Terminal

**Files:** `framework/terminal.ts`
**Decisions:** D045, D048

Upgrade the terminal abstraction with synchronized output, Kitty protocol detection, and proper cursor management. The existing `tui/terminal.ts` (62 lines) is replaced.

```typescript
// framework/terminal.ts

export interface TerminalOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export class Terminal {
  private kittyEnabled = false;

  constructor(options?: TerminalOptions);

  /** Enter raw mode, detect Kitty protocol, register handlers */
  start(onInput: (data: string) => void, onResize: () => void): void;

  /** Restore terminal state, disable Kitty protocol */
  stop(): void;

  /** Write to stdout (raw) */
  write(data: string): void;

  /** Write wrapped in synchronized output sequences to prevent flicker */
  writeSynchronized(data: string): void;

  /** Terminal dimensions */
  get columns(): number;
  get rows(): number;

  /** Cursor control */
  hideCursor(): void;
  showCursor(): void;
  moveCursorTo(row: number, col: number): void;

  /** Line operations */
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;

  /** Move cursor up/down by N lines */
  moveBy(lines: number): void;

  /** Whether Kitty keyboard protocol is active */
  get isKittyEnabled(): boolean;
}
```

Kitty protocol detection: Send `\x1b[?u` query on start, parse response to determine support. Enable with `\x1b[>1u` (disambiguate escape codes). Disable on stop with `\x1b[<u`.

Synchronized output: Wrap writes in `\x1b[?2026h` (begin) / `\x1b[?2026l` (end) to prevent flicker during multi-line updates. Both codex-rs and pi-agent use this.

**Verify:** Manual test — start terminal in raw mode, type characters, verify they echo. Ctrl+C works. Terminal restores cleanly on stop.

---

### Task 3: StdinBuffer & Key Matching

**Files:** `framework/stdin-buffer.ts`, `framework/keys.ts`
**Decisions:** D048

StdinBuffer splits batched input into individual sequences. Key matching supports both Kitty protocol and legacy escape sequences.

```typescript
// framework/stdin-buffer.ts

/** Splits batched raw input into individual key sequences */
export class StdinBuffer {
  /** Split a raw input chunk into individual sequences */
  split(data: string): string[];
}

// framework/keys.ts

/** Named key identifiers */
export type KeyId =
  | "enter" | "escape" | "tab" | "backspace" | "delete"
  | "up" | "down" | "left" | "right"
  | "home" | "end" | "pageup" | "pagedown"
  | "ctrl+c" | "ctrl+d" | "ctrl+l" | "ctrl+z"
  | "ctrl+a" | "ctrl+e" | "ctrl+k" | "ctrl+u"
  | "ctrl+w" | "ctrl+backspace"
  | string; // Allow arbitrary key IDs

/** Check if raw input data matches a named key */
export function matchesKey(data: string, keyId: KeyId): boolean;

/** Parse a Kitty protocol escape sequence into structured key info */
export function parseKittyKey(data: string): {
  key: string;
  modifiers: number;
  isRelease: boolean;
} | null;
```

StdinBuffer logic: Walk through the input string, identifying complete escape sequences (`\x1b[...` terminated by a letter) and single characters. Split at sequence boundaries. Handle edge cases: bracketed paste markers, Kitty protocol sequences.

Key matching: For each `KeyId`, maintain a list of matching byte sequences (legacy escape codes) and Kitty protocol key codes. `matchesKey()` checks both formats.

**Verify:**
```typescript
// stdin-buffer.test.ts
test("splits single characters", () => {
  const buf = new StdinBuffer();
  expect(buf.split("abc")).toEqual(["a", "b", "c"]);
});

test("splits escape sequences", () => {
  const buf = new StdinBuffer();
  expect(buf.split("\x1b[A\x1b[B")).toEqual(["\x1b[A", "\x1b[B"]);
});

test("splits mixed input", () => {
  const buf = new StdinBuffer();
  expect(buf.split("a\x1b[Ab")).toEqual(["a", "\x1b[A", "b"]);
});

// keys.test.ts
test("matches ctrl+c", () => {
  expect(matchesKey("\x03", "ctrl+c")).toBe(true);
});

test("matches arrow up (legacy)", () => {
  expect(matchesKey("\x1b[A", "up")).toBe(true);
});
```

---

### Task 4: TUI Renderer (Line-Level Diffing)

**Files:** `framework/renderer.ts`, `framework/container.ts`
**Decisions:** D045

The TUI renderer is the rendering engine: it takes a root Component, renders it, diffs against the previous frame, and emits only changed lines via synchronized output. The Container is the simplest layout component — vertical stacking.

```typescript
// framework/container.ts

export class Container implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void;
  removeChild(component: Component): void;
  insertBefore(component: Component, before: Component): void;

  render(width: number): string[] {
    // Concatenate all children's render output
    return this.children.flatMap(child => child.render(width));
  }

  handleInput(data: string): void {
    // Delegate to focused child (if any)
  }

  invalidate(): void {
    this.children.forEach(c => c.invalidate());
  }
}

// framework/renderer.ts

export class TUIRenderer {
  private terminal: Terminal;
  private root: Component;
  private previousLines: string[] = [];
  private renderScheduled = false;
  private focusedComponent: (Component & Focusable) | null = null;

  constructor(terminal: Terminal, root: Component);

  /** Schedule a render on next tick (coalesces multiple requests) */
  requestRender(force?: boolean): void;

  /** Set which component receives hardware cursor focus */
  setFocus(component: (Component & Focusable) | null): void;

  /** Perform a render: render root, diff, emit changes */
  private doRender(): void;

  /** Start the render loop (call after terminal.start) */
  start(): void;

  /** Stop rendering, clear state */
  stop(): void;
}
```

Rendering pipeline (doRender):
1. Call `root.render(terminal.columns)` → get `newLines: string[]`
2. Composite overlays into `newLines` (Task 6)
3. Find first and last changed line by comparing `newLines` vs `previousLines`
4. For changed region: move cursor up to first changed line, clear and rewrite each line
5. Extract CURSOR_MARKER position from rendered lines for hardware cursor placement
6. Wrap all writes in `terminal.writeSynchronized()`
7. Store `previousLines = newLines`

Content growth: When new lines exceed previous count, terminal scrolls naturally (inline mode). When content shrinks, clear excess lines.

```typescript
// renderer.test.ts
test("only emits changed lines", () => {
  const writes: string[] = [];
  const mockTerminal = { /* mock that captures writes */ };
  // First render: all lines emitted
  // Second render with one line changed: only that line emitted
});
```

**Verify:** `bun test` for renderer tests. Manual test — render a component, update one line, verify only that line is redrawn (observable via write count).

---

### Task 5: InputEditor Component

**Files:** `components/input-editor.ts`
**Decisions:** D048

Interactive text input component with cursor positioning, prompt display, and IME support via CURSOR_MARKER. Replaces `tui/input.ts`.

```typescript
// components/input-editor.ts

export interface InputEditorOptions {
  prompt?: string;          // e.g. "diligent> "
  multiline?: boolean;      // Support Shift+Enter for newlines
  onSubmit?: (text: string) => void;
  onCancel?: () => void;    // Ctrl+C handler
  onExit?: () => void;      // Ctrl+D handler
}

export class InputEditor implements Component, Focusable {
  focused = false;
  private text = "";
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;

  constructor(private options: InputEditorOptions);

  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;

  /** Clear input text */
  clear(): void;

  /** Set input text programmatically */
  setText(text: string): void;

  /** Get current text */
  getText(): string;
}
```

Key bindings handled:
- Enter → submit (call onSubmit)
- Ctrl+C → cancel current input (call onCancel)
- Ctrl+D → exit (call onExit if input empty)
- Ctrl+A / Home → move to start
- Ctrl+E / End → move to end
- Ctrl+K → delete to end of line
- Ctrl+U → delete to start of line
- Ctrl+W → delete word backward
- Up/Down → history navigation
- Left/Right → cursor movement
- Backspace/Delete → character deletion
- Regular characters → insert at cursor

Render output: A single line showing `prompt + text` with CURSOR_MARKER embedded at cursor position. Multi-line mode wraps at terminal width.

**Verify:** Unit tests for key handling (insert, delete, cursor movement, history). Integration test — render InputEditor, simulate key sequences, verify rendered output.

---

### Task 6: Overlay System

**Files:** `framework/overlay.ts`, update `framework/renderer.ts`
**Decisions:** D050

Overlay stack for modal UI elements. Overlays render on top of base content with configurable positioning. The renderer composites overlays during doRender.

```typescript
// framework/overlay.ts

interface OverlayEntry {
  component: Component;
  options: OverlayOptions;
  handle: OverlayHandle;
  hidden: boolean;
}

export class OverlayStack {
  private entries: OverlayEntry[] = [];

  /** Show an overlay, returns handle for hide/show */
  show(component: Component, options?: OverlayOptions): OverlayHandle;

  /** Hide and remove the topmost overlay */
  hideTop(): void;

  /** Get all visible overlays for compositing */
  getVisible(): ReadonlyArray<{ component: Component; options: OverlayOptions }>;

  /** Whether any overlay is visible (affects input routing) */
  hasVisible(): boolean;

  /** Clear all overlays */
  clear(): void;
}
```

Compositing algorithm (in renderer.ts):
1. Render base content → `baseLines: string[]`
2. For each visible overlay:
   a. Resolve position from anchor + offset + margin relative to terminal dimensions
   b. Render overlay component → `overlayLines: string[]`
   c. For each overlay line, splice into `baseLines` at the computed row/column
   d. Handle ANSI reset at splice boundaries to prevent style bleeding
3. Return composited lines

When overlays are visible, input is routed to the topmost overlay's component instead of the base content.

```typescript
// overlay.test.ts
test("composites overlay at center", () => {
  const stack = new OverlayStack();
  const dialog = { render: () => ["┌──┐", "│hi│", "└──┘"], invalidate: () => {} };
  stack.show(dialog, { anchor: "center" });
  // Verify compositing against base content
});

test("input routes to topmost overlay", () => {
  // With overlay visible, handleInput goes to overlay
});
```

**Verify:** Unit tests for overlay compositing. Visual test — show overlay on top of chat content, verify it renders correctly and hides on dismiss.

---

### Task 7: MarkdownView Component

**Files:** `components/markdown-view.ts`
**Decisions:** D047

Streaming markdown renderer as a Component. Implements newline-gated commit strategy: buffer incoming tokens, render only complete lines, finalize remaining at stream end. Replaces `tui/markdown.ts`.

```typescript
// components/markdown-view.ts

export class MarkdownView implements Component {
  private buffer = "";
  private committedLines: string[] = [];
  private finalized = false;

  constructor(private requestRender: () => void);

  /** Push a text delta (streaming token) */
  pushDelta(delta: string): void;

  /** Finalize — render all remaining buffered content */
  finalize(): void;

  /** Reset for a new message */
  reset(): void;

  render(width: number): string[];
  invalidate(): void;
}
```

Newline-gated streaming (D047, codex-rs pattern):
1. `pushDelta(delta)` appends to internal buffer
2. Find last newline in buffer. Everything up to (and including) last newline is "complete"
3. Render complete portion through `marked` → ANSI styled lines
4. Store as `committedLines`, keep remainder in buffer
5. Call `requestRender()` to trigger TUI update
6. `finalize()` renders any remaining buffer content and marks stream as done

> Newline gating prevents partial-line flickering during streaming. Only complete lines are rendered. The trailing partial line is held until the next newline arrives or the stream ends (D047).

```typescript
// markdown-view.test.ts
test("commits only complete lines during streaming", () => {
  const mv = new MarkdownView(() => {});
  mv.pushDelta("Hello ");
  expect(mv.render(80)).toEqual([]); // No newline yet — nothing committed
  mv.pushDelta("world\n");
  expect(mv.render(80)).toHaveLength(1); // Now committed
});

test("finalize renders remaining content", () => {
  const mv = new MarkdownView(() => {});
  mv.pushDelta("trailing text");
  mv.finalize();
  expect(mv.render(80).length).toBeGreaterThan(0);
});
```

**Verify:** Unit tests for newline-gated streaming. Manual test — start agent, ask a question, observe smooth line-by-line rendering without flicker.

---

### Task 8: Spinner Component

**Files:** `components/spinner.ts`
**Decisions:** D049

Braille spinner as a Component. Replaces `tui/spinner.ts`. Self-animating via interval timer.

```typescript
// components/spinner.ts

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL = 80; // ms

export class SpinnerComponent implements Component {
  private frameIndex = 0;
  private message = "";
  private active = false;
  private timer: Timer | null = null;

  constructor(private requestRender: () => void);

  /** Start the spinner with a message */
  start(message: string): void;

  /** Update the spinner message */
  setMessage(message: string): void;

  /** Stop the spinner */
  stop(): void;

  render(width: number): string[];
  invalidate(): void;
}
```

When active, renders a single line: `⠋ {message}` with the frame cycling every 80ms. The timer calls `requestRender()` each tick to trigger a re-render. When stopped, `render()` returns `[]`.

**Verify:** Unit test — start spinner, verify render output contains braille character and message. Manual test — spinner animates smoothly during tool execution.

---

### Task 9: StatusBar Component

**Files:** `components/status-bar.ts`

Bottom status bar showing contextual information. Minimal for Phase 4a — expanded in later phases.

```typescript
// components/status-bar.ts

export interface StatusBarInfo {
  model?: string;
  tokensUsed?: number;
  contextWindow?: number;
  sessionId?: string;
  status?: "idle" | "busy" | "retry";
}

export class StatusBar implements Component {
  private info: StatusBarInfo = {};

  update(info: Partial<StatusBarInfo>): void;

  render(width: number): string[];
  invalidate(): void;
}
```

Renders a single line with dim styling: `model · tokens/context · session-id · status`. Truncates to fit terminal width.

**Verify:** Unit test — render StatusBar with various info combinations, verify output fits width.

---

### Task 10: ChatView Component

**Files:** `components/chat-view.ts`

The main conversation view that displays the message history, streaming output, and tool execution results. Composes MarkdownView and SpinnerComponent internally.

```typescript
// components/chat-view.ts

export interface ChatViewOptions {
  requestRender: () => void;
}

export class ChatView implements Component {
  private lines: string[] = [];
  private activeMarkdown: MarkdownView | null = null;
  private activeSpinner: SpinnerComponent | null = null;

  constructor(private options: ChatViewOptions);

  /** Handle agent events to update the view */
  handleEvent(event: AgentEvent): void;

  /** Add a user message to the display */
  addUserMessage(text: string): void;

  render(width: number): string[];
  invalidate(): void;
}
```

Event handling mapping:
- `message_start` → create new MarkdownView, begin streaming
- `message_delta` → push delta to active MarkdownView
- `message_end` → finalize MarkdownView, commit lines
- `tool_start` → start SpinnerComponent with tool name + args summary
- `tool_update` → update spinner message with partial result
- `tool_end` → stop spinner, display tool result (collapsed by default)
- `status_change` → update internal status
- `usage` → emit usage info (consumed by StatusBar via app)
- `compaction_start/end` → display compaction summary
- `error` → display error in red styling

**Verify:** Unit test — feed AgentEvent sequence, verify rendered lines. Integration test with mock agent loop.

---

### Task 11: ConfirmDialog Component

**Files:** `components/confirm-dialog.ts`

Simple yes/no dialog rendered as an overlay. Foundation for Phase 4b's approval dialog.

```typescript
// components/confirm-dialog.ts

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;  // default: "Yes"
  cancelLabel?: string;   // default: "No"
}

export class ConfirmDialog implements Component {
  private selectedIndex = 0; // 0 = confirm, 1 = cancel

  constructor(
    private options: ConfirmDialogOptions,
    private onResult: (confirmed: boolean) => void,
  );

  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}
```

Renders a box with border characters:
```
┌─ Title ─────────────────┐
│ Message text here       │
│                         │
│  [▸ Yes]    [ No]       │
└─────────────────────────┘
```

Arrow keys / Tab switch between options. Enter confirms selection.

**Verify:** Unit test — render dialog, simulate key input, verify onResult callback fires correctly.

---

### Task 12: App Migration

**Files:** `tui/app.ts` (rewrite), `index.ts` (update imports)
**Decisions:** D045, D046, D050

Wire everything together. The new `app.ts` creates the component tree, connects to SessionManager, and runs the TUI event loop.

```typescript
// tui/app.ts (new structure)

export class App {
  private terminal: Terminal;
  private renderer: TUIRenderer;
  private overlayStack: OverlayStack;
  private root: Container;

  // Components
  private chatView: ChatView;
  private inputEditor: InputEditor;
  private statusBar: StatusBar;

  constructor(private sessionManager: SessionManager, private config: DiligentConfig);

  /** Start the TUI */
  async start(): Promise<void> {
    // 1. Create terminal and renderer
    // 2. Build component tree: Container → [ChatView, InputEditor, StatusBar]
    // 3. Wire input events
    // 4. Wire agent events → ChatView.handleEvent
    // 5. Start render loop
  }

  /** Handle user input submission */
  private async handleSubmit(text: string): Promise<void>;

  /** Handle agent event stream */
  private handleAgentEvent(event: AgentEvent): void;

  /** Show a confirmation dialog overlay */
  async confirm(options: ConfirmDialogOptions): Promise<boolean>;

  /** Stop the TUI */
  stop(): void;
}
```

Component tree structure:
```
Container (root)
  ├── ChatView          — conversation history + streaming
  ├── InputEditor       — user input with cursor
  └── StatusBar         — model, tokens, status
OverlayStack
  └── (dialogs rendered on top when active)
```

Input routing:
- When no overlay: input → InputEditor
- When overlay visible: input → topmost overlay component
- Ctrl+C during agent execution → show ConfirmDialog via overlay

Agent event flow:
- SessionManager.run() → EventStream
- App subscribes via for-await loop
- Each AgentEvent → ChatView.handleEvent() + StatusBar.update()

**Verify:** Full manual integration test — start agent, have a conversation, observe:
1. Streaming markdown renders smoothly line-by-line
2. Spinner shows during tool execution
3. Input editor accepts text with cursor movement
4. Status bar shows model and token usage
5. Ctrl+C shows confirmation dialog overlay
6. Terminal restores cleanly on exit

---

## Migration Notes

The following components from Phase 1-3 are replaced:

| Old | New | What Changes |
|-----|-----|-------------|
| `tui/terminal.ts` (62 lines) | `framework/terminal.ts` | Adds synchronized output, Kitty protocol, cursor management |
| `tui/input.ts` (48 lines, InputBuffer) | `components/input-editor.ts` | Full Component with cursor, history, multi-line, IME support |
| `tui/markdown.ts` (112 lines) | `components/markdown-view.ts` | Component interface, newline-gated streaming (D047) |
| `tui/spinner.ts` (47 lines) | `components/spinner.ts` | Component interface, self-animating |
| `tui/app.ts` (298 lines) | `tui/app.ts` (rewrite) | From raw readline loop to Component-based architecture |

**Not migrated (preserved as-is):**
- `tui/tools.ts` — tool array builder, no changes needed
- `tui/runner.ts` — non-interactive runner, deferred to Phase 4c
- `packages/core/` — entire core package unchanged

## Acceptance Criteria

1. `bun install` — resolves all dependencies (no new external deps expected)
2. `bun test` — all existing 323 tests pass + new TUI framework tests pass
3. `bun run typecheck` — no type errors in new code, no `any` escape hatches
4. Agent conversation works end-to-end with new TUI (same functionality as before migration)
5. Markdown renders line-by-line during streaming without flickering partial lines
6. Spinner animates during tool execution with 80ms frame interval
7. Input editor supports cursor movement, history, Ctrl shortcuts
8. Overlay system renders dialog on top of base content
9. Ctrl+C during agent execution shows confirmation dialog
10. Terminal restores cleanly on exit (raw mode disabled, cursor visible)
11. Kitty keyboard protocol detected and enabled on supporting terminals

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | StdinBuffer splitting (single chars, escape seqs, mixed, bracketed paste) | `bun test` with byte sequence fixtures |
| Unit | Key matching (legacy sequences, Kitty protocol, modifiers) | `bun test` with known escape codes |
| Unit | Renderer line-level diffing (no change, partial change, growth, shrink) | `bun test` with mock Terminal capturing writes |
| Unit | Overlay compositing (center, bottom-center, margins, ANSI boundary) | `bun test` with known base content and overlay content |
| Unit | MarkdownView newline gating (partial, complete, finalize) | `bun test` feeding delta strings |
| Unit | InputEditor key handling (insert, delete, cursor, history, Ctrl shortcuts) | `bun test` simulating handleInput calls |
| Unit | ConfirmDialog (render, key navigation, result callback) | `bun test` simulating key input |
| Integration | Full App lifecycle (start, handle events, render, stop) | `bun test` with mock SessionManager and captured Terminal output |
| E2E | Full conversation with new TUI | Manual test — ask agent to list files, verify streaming + tool execution display |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Overlay compositing breaks ANSI styles at splice boundaries | Garbled colors/styles in overlays | Test with various base content styles. Use explicit ANSI reset at splice points |
| Kitty protocol detection fails on some terminals | No Kitty features, fall back to legacy | Graceful fallback — detect timeout means no Kitty. All key matching supports both protocols |
| Line-level diffing performance on large output | Slow rendering for long conversations | Only diff the visible region (last N lines). Scroll offset optimization if needed |
| Newline-gated markdown may delay rendering of last partial line | User sees no output until first newline | Short timeout (100ms) to force-render trailing content even without newline |
| App migration breaks existing functionality | Agent unusable until fixed | Run existing E2E tests after each task. Incremental migration — keep old app.ts working until Task 12 |
| Terminal state not restored on crash | User left with broken terminal | Use process.on("exit") and process.on("SIGINT") to force cleanup. `stty sane` fallback |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D045 | Inline mode with custom ANSI framework, Component interface | Task 1 (types), Task 4 (renderer), all components |
| D046 | No server between TUI and core | Task 12 (direct SessionManager calls) |
| D047 | Newline-gated streaming with marked | Task 7 (MarkdownView) |
| D048 | Raw mode with Kitty protocol, StdinBuffer | Task 2 (terminal), Task 3 (stdin-buffer, keys) |
| D049 | Braille spinner | Task 8 (SpinnerComponent) |
| D050 | Overlay stack system | Task 1 (types), Task 6 (overlay), Task 11 (confirm dialog) |
| D054 | Interactive + Print modes | Print mode deferred to Phase 4c |

## What Phase 4a Does NOT Include

- **No approval system** — Phase 4b. ctx.ask() remains auto-approve. The ConfirmDialog is a foundation component, not wired to approvals.
- **No slash commands** — Phase 4c. The InputEditor handles text input only, not `/command` parsing or dispatch.
- **No command registry** — Phase 4c (D051).
- **No Print mode changes** — Phase 4c. `runner.ts` untouched.
- **No collaboration modes** — Phase 4c (D087).
- **No permission config** — Phase 4b. Config schema unchanged.
- **No syntax highlighting** — Deferred. Markdown code blocks render with background styling only, not language-specific highlighting.
- **No command palette** — Post-MVP (D055).
- **No custom themes** — Post-MVP.
- **No autocomplete** — Phase 4c (when slash commands exist).
- **No bracketed paste mode** — Can be added later as a refinement within the Kitty/raw mode infrastructure.
