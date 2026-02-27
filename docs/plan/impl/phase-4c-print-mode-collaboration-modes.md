# Phase 4c: Print Mode + Collaboration Modes

## Goal

The agent supports stdin pipe input for scripting and CI pipelines, and operates in named
collaboration modes (`default`, `plan`, `execute`) that control which tools are available and
what system prompt context the LLM receives.

## Prerequisites

- Phase 4b artifact: Skills system, slash command registry, ListPicker overlay, 513 tests passing.
- `NonInteractiveRunner` exists in `packages/cli/src/tui/runner.ts`.
- `SessionManager.config.agentConfig` already accepts `() => AgentLoopConfig` factory (D087-prepared comment in `manager.ts`).
- `resolveAgentConfig()` calls the factory on each run (confirmed in `manager.ts:335`).

## Artifact

**Demo 1 — Print mode:**
```
$ echo "what files are in src/?" | diligent
[tool:bash] Running...
[tool:bash] Done (8 lines)
The src/ directory contains: index.ts, config.ts, ...

$ echo "summarize ARCHITECTURE.md" | diligent --mode plan
[tool:read_file] Running...
[tool:read_file] Done (120 lines)
The architecture has three layers: ...
```

**Demo 2 — Plan mode (TUI):**
```
diligent [plan]> explore the auth system and plan a refactor
  [Only read/glob/grep/ls tools available — no edit/write/bash]
  [System prompt: "You are in PLAN mode. Do not edit files. Output <proposed_plan>."]

  <proposed_plan>
  1. Extract AuthService interface
  2. Move session logic to SessionRepository
  ...
  </proposed_plan>
```

**Demo 3 — Mode switching:**
```
diligent> /mode plan
  Mode switched to plan
diligent [plan]> /mode
  ┌─ Mode ───────────────────────────────┐
  │ ▸ default   Full tool access         │
  │   plan      Read-only exploration    │
  │   execute   Autonomous execution     │
  └──────────────────────────────────────┘
diligent [plan]> /mode default
  Mode switched to default
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L7 (TUI) | +print+mode | Stdin pipe detection in `index.ts`, `--mode` CLI flag, `/mode` command, status bar mode chip |
| L1 (Agent Loop) | +mode | `mode?: ModeKind` in `AgentLoopConfig`, tool filtering for plan mode, mode system prompt injection |
| L5 (Config) | +mode | `mode?: ModeKind` in `DiligentConfigSchema` and `AppConfig` |
| L6 (Session) | +mode | `ModeChangeEntry` type, `appendModeChange()` on `SessionManager`, SESSION_VERSION bump |

**Not touched:** L0 (Provider), L2 (Tool System), L3 (Core Tools), L4 (still auto-approve — approval system deferred), L8 (Skills), L9, L10.

## File Manifest

### packages/core/src/agent/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | MODIFY | Add `ModeKind`, `MODE_PLAN_TOOLS`, `MODE_PROMPTS` constants, `mode?: ModeKind` to `AgentLoopConfig` |
| `loop.ts` | MODIFY | Filter tools for plan mode before building tool registry, prepend mode prompt to systemPrompt |

### packages/core/src/session/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | MODIFY | Add `ModeChangeEntry` type, add to `SessionEntry` union, bump `SESSION_VERSION` 2→3 |
| `manager.ts` | MODIFY | Add `appendModeChange(mode, changedBy)` public method |

### packages/core/src/config/

| File | Action | Description |
|------|--------|------------|
| `schema.ts` | MODIFY | Add `mode?: z.enum(["default", "plan", "execute"])` to `DiligentConfigSchema` |

### packages/core/src/

| File | Action | Description |
|------|--------|------------|
| `index.ts` | MODIFY | Export `ModeKind` type |

### packages/cli/src/

| File | Action | Description |
|------|--------|------------|
| `config.ts` | MODIFY | Add `mode: ModeKind` to `AppConfig`, read `config.diligent.mode ?? "default"` in `loadConfig` |
| `index.ts` | MODIFY | Add `--mode` CLI flag, stdin pipe detection (read stdin when not TTY and no `--prompt`) |

### packages/cli/src/tui/

| File | Action | Description |
|------|--------|------------|
| `runner.ts` | MODIFY | Pass `mode: this.config.mode` to `AgentLoopConfig` in both SessionManager and fallback loop |
| `app.ts` | MODIFY | Add `currentMode: ModeKind`, factory agentConfig, `setMode()` wired to SessionManager, pass mode to status bar |

### packages/cli/src/tui/components/

| File | Action | Description |
|------|--------|------------|
| `status-bar.ts` | MODIFY | Add `mode?: ModeKind` to `StatusBarInfo`, render `[plan]` / `[execute]` chip when mode ≠ "default" |

### packages/cli/src/tui/commands/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | MODIFY | Add `currentMode: ModeKind` and `setMode: (mode: ModeKind) => void` to `CommandContext` |
| `builtin/mode.ts` | CREATE | `/mode` command handler with ListPicker overlay |
| `builtin/index.ts` | MODIFY | Register mode command |

### Tests

| File | Action | Description |
|------|--------|------------|
| `packages/core/src/agent/__tests__/mode-filter.test.ts` | CREATE | Tool filtering by mode, mode prompt injection |
| `packages/cli/src/tui/commands/__tests__/mode.test.ts` | CREATE | Mode command: direct switch, picker shown, invalid mode error |

## Implementation Tasks

### Task 1: ModeKind type + AgentLoopConfig update

**Files:** `packages/core/src/agent/types.ts`, `packages/core/src/index.ts`
**Decisions:** D087

Define the `ModeKind` union, the read-only tool allowlist for plan mode, and mode system prompt
prefixes. Add `mode` to `AgentLoopConfig`.

```typescript
// agent/types.ts — additions

export type ModeKind = "default" | "plan" | "execute";

/**
 * Tools available in plan mode (read-only exploration only).
 * Bash, write, edit, glob (write side-effects), add_knowledge are excluded.
 */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "ls",
]);

/**
 * System prompt prefixes injected per mode.
 * Empty string for "default" — no prefix added, current behavior preserved.
 */
export const MODE_SYSTEM_PROMPT_PREFIXES: Record<ModeKind, string> = {
  default: "",
  plan: [
    "You are operating in PLAN MODE.",
    "You may ONLY read files, search code, and explore the codebase.",
    "You must NOT create, edit, delete, or write any files.",
    "Do not run bash commands.",
    "Focus on understanding the codebase and producing a plan.",
    "When ready, output your plan inside a <proposed_plan> block.",
    "",
  ].join("\n"),
  execute: [
    "You are operating in EXECUTE MODE.",
    "Work autonomously toward the goal. Make reasonable assumptions rather than asking questions.",
    "Report significant progress milestones as you work.",
    "Complete the full task before stopping.",
    "",
  ].join("\n"),
};

// In AgentLoopConfig — add:
export interface AgentLoopConfig {
  model: Model;
  systemPrompt: string;
  tools: Tool[];
  streamFunction: StreamFunction;
  signal?: AbortSignal;
  maxTurns?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  mode?: ModeKind;   // NEW — defaults to "default"
}
```

Export `ModeKind` from `packages/core/src/index.ts`.

**Verify:** `bun run typecheck` passes. Existing tests unaffected (mode defaults to undefined = "default").

---

### Task 2: Tool filtering + mode prompt injection in agent loop

**Files:** `packages/core/src/agent/loop.ts`
**Decisions:** D087

Two changes to `runLoop()`:

1. **Tool filtering**: Before building the `registry` Map, filter tools based on mode.
2. **System prompt injection**: Prepend the mode prompt prefix to `config.systemPrompt`.

```typescript
// loop.ts — inside runLoop(), before registry construction

const activeMode = config.mode ?? "default";

// D087: Filter tools for plan mode (read-only exploration)
const activeTools =
  activeMode === "plan"
    ? config.tools.filter(t => PLAN_MODE_ALLOWED_TOOLS.has(t.name))
    : config.tools;

const registry = new Map(activeTools.map((t) => [t.name, t]));

// D087: Prepend mode system prompt prefix
const effectiveSystemPrompt =
  activeMode === "default"
    ? config.systemPrompt
    : `${MODE_SYSTEM_PROMPT_PREFIXES[activeMode]}${config.systemPrompt}`;
```

Replace references to `config.tools` with `activeTools` and `config.systemPrompt` with
`effectiveSystemPrompt` in `streamAssistantResponse()` call.

> The mode prompt prefix is prepended rather than appended so it appears at the top of the
> system prompt as a high-priority instruction. CLAUDE.md and project instructions follow,
> which can narrow but not contradict the mode constraints.

**Verify:** New tests in `mode-filter.test.ts`:
- Plan mode: `write_file`, `bash`, `edit_file` tools are absent from registry
- Plan mode: `read_file`, `glob`, `grep`, `ls` remain present
- Execute mode: all tools present
- Mode prompt prefix appears in context passed to stream function

---

### Task 3: ModeChangeEntry + SessionManager.appendModeChange()

**Files:** `packages/core/src/session/types.ts`, `packages/core/src/session/manager.ts`
**Decisions:** D087, D086 (serialization contract)

Add `ModeChangeEntry` to the session JSONL format. Bump `SESSION_VERSION` from 2 to 3.

```typescript
// session/types.ts

export const SESSION_VERSION = 3;   // bumped from 2

export interface ModeChangeEntry {
  type: "mode_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  mode: ModeKind;
  /** Who triggered the change */
  changedBy: "cli" | "command" | "config";
}

// Update union:
export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | SessionInfoEntry
  | CompactionEntry
  | ModeChangeEntry;   // NEW
```

Add method to `SessionManager`:

```typescript
// session/manager.ts

appendModeChange(mode: ModeKind, changedBy: ModeChangeEntry["changedBy"] = "command"): void {
  const entry: ModeChangeEntry = {
    type: "mode_change",
    id: generateEntryId(),
    parentId: this.leafId,
    timestamp: new Date().toISOString(),
    mode,
    changedBy,
  };
  this.entries.push(entry);
  this.byId.set(entry.id, entry);
  this.leafId = entry.id;
  this.writeQueue = this.writeQueue.then(() => this.writer.write(entry)).catch(() => {});
}
```

Import `ModeKind` from `../agent/types` in `session/manager.ts`.

> `SESSION_VERSION` bump signals that session files may contain `mode_change` entries.
> The `context-builder.ts` already ignores unknown entry types (only processes `message` and
> `compaction`), so no migration is needed for reading old sessions.

**Verify:** `SESSION_VERSION === 3`. `ModeChangeEntry` round-trips through `JSON.parse(JSON.stringify())` (D086 serialization contract). Existing session read tests continue to pass.

---

### Task 4: Config schema + AppConfig mode field

**Files:** `packages/core/src/config/schema.ts`, `packages/cli/src/config.ts`
**Decisions:** D087

Add `mode` to the config schema and to `AppConfig`.

```typescript
// schema.ts — add to DiligentConfigSchema
mode: z.enum(["default", "plan", "execute"]).optional(),
```

```typescript
// config.ts

import type { ModeKind } from "@diligent/core";

export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: string;
  streamFunction: StreamFunction;
  diligent: DiligentConfig;
  sources: string[];
  agentLoopFn?: AgentLoopFn;
  skills: SkillMetadata[];
  mode: ModeKind;   // NEW — always set, defaults to "default"
}

// In loadConfig():
return {
  // ... existing fields ...
  mode: (config.mode ?? "default") as ModeKind,
};
```

**Verify:** Schema validation tests: `mode: "plan"` valid, `mode: "invalid"` rejected. `loadConfig()` returns `mode: "default"` when not configured.

---

### Task 5: Print mode — stdin pipe detection

**Files:** `packages/cli/src/index.ts`
**Decisions:** D054

Detect when stdin is piped (non-TTY) and read the prompt from stdin automatically.

```typescript
// index.ts — add before the interactive App.start() call

// D054: Print mode — detect stdin pipe
const isStdinPiped = !process.stdin.isTTY;

if (isStdinPiped && values.prompt === undefined) {
  const prompt = await readStdin();
  if (!prompt) {
    console.error("Error: stdin was empty");
    process.exit(1);
  }
  const runner = new NonInteractiveRunner(config, paths, { resume: values.continue });
  const exitCode = await runner.run(prompt);
  process.exit(exitCode);
}

// Also add --mode flag parsing:
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    continue: { type: "boolean", short: "c" },
    list:     { type: "boolean", short: "l" },
    prompt:   { type: "string",  short: "p" },
    mode:     { type: "string",  short: "m" },  // NEW
  },
});

// After loadConfig(), apply CLI mode override:
if (values.mode) {
  const valid: ModeKind[] = ["default", "plan", "execute"];
  if (!valid.includes(values.mode as ModeKind)) {
    console.error(`Error: invalid mode "${values.mode}". Valid modes: ${valid.join(", ")}`);
    process.exit(1);
  }
  config.mode = values.mode as ModeKind;
}
```

```typescript
// index.ts — helper (add at bottom)
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
```

**Verify:** Manual test: `echo "hello" | bun run packages/cli/src/index.ts` runs NonInteractiveRunner. `bun run packages/cli/src/index.ts --mode plan --prompt "list files"` uses plan mode.

---

### Task 6: NonInteractiveRunner mode pass-through

**Files:** `packages/cli/src/tui/runner.ts`

Pass `config.mode` from `AppConfig` through to `AgentLoopConfig` in both code paths.

```typescript
// runner.ts — in SessionManager construction (lines ~30-44):
agentConfig: {
  model: this.config.model,
  systemPrompt: this.config.systemPrompt,
  tools,
  streamFunction: this.config.streamFunction,
  mode: this.config.mode,   // NEW
},

// And in the fallback agentLoop call (lines ~73-80):
const loop = loopFn(this.messages, {
  model: this.config.model,
  systemPrompt: this.config.systemPrompt,
  tools,
  streamFunction: this.config.streamFunction,
  mode: this.config.mode,   // NEW
});
```

**Verify:** `bun run typecheck` passes.

---

### Task 7: /mode command

**Files:** `packages/cli/src/tui/commands/builtin/mode.ts`, `packages/cli/src/tui/commands/types.ts`
**Decisions:** D087

Add `currentMode` and `setMode` to `CommandContext`, then implement the `/mode` command.

```typescript
// commands/types.ts — add to CommandContext:
/** Current collaboration mode */
currentMode: ModeKind;
/** Switch to a new collaboration mode. Persists to session if SessionManager available. */
setMode: (mode: ModeKind) => void;
```

```typescript
// commands/builtin/mode.ts

import type { ModeKind } from "@diligent/core";
import type { Command } from "../types";
import { ListPicker } from "../../components/list-picker";

const MODE_DESCRIPTIONS: Record<ModeKind, string> = {
  default: "Full tool access, prefer execution",
  plan:    "Read-only exploration and planning",
  execute: "Autonomous execution, assumptions-first",
};

export const modeCommand: Command = {
  name: "mode",
  description: "Switch collaboration mode",
  supportsArgs: true,
  handler: async (args, ctx) => {
    const valid: ModeKind[] = ["default", "plan", "execute"];

    if (args) {
      if (!valid.includes(args as ModeKind)) {
        ctx.displayError(`Unknown mode: "${args}". Valid modes: ${valid.join(", ")}`);
        return;
      }
      ctx.setMode(args as ModeKind);
      ctx.displayLines([`  Mode switched to \x1b[1m${args}\x1b[0m`]);
      return;
    }

    // No args: show picker
    const items = valid.map(m => ({
      label: m,
      description: MODE_DESCRIPTIONS[m],
      value: m,
    }));

    return new Promise<void>((resolve) => {
      const picker = new ListPicker(
        { title: "Mode", items, selectedIndex: valid.indexOf(ctx.currentMode) },
        (value) => {
          handle.hide();
          ctx.requestRender();
          if (value) {
            ctx.setMode(value as ModeKind);
            ctx.displayLines([`  Mode switched to \x1b[1m${value}\x1b[0m`]);
          }
          resolve();
        },
      );
      const handle = ctx.showOverlay(picker, { anchor: "center" });
      ctx.requestRender();
    });
  },
};
```

Register in `builtin/index.ts`:
```typescript
import { modeCommand } from "./mode";
// Add to registerBuiltinCommands:
registry.register(modeCommand);
```

**Verify:** Mode command tests: `/mode plan` calls `setMode("plan")`. `/mode invalid` shows error. No args shows picker (mock overlay verified).

---

### Task 8: Status bar mode indicator

**Files:** `packages/cli/src/tui/components/status-bar.ts`

Add mode chip to the left section of the status bar. Only shown when mode is not `"default"`.

```typescript
// status-bar.ts

export interface StatusBarInfo {
  model?: string;
  tokensUsed?: number;
  contextWindow?: number;
  sessionId?: string;
  status?: "idle" | "busy" | "retry";
  cwd?: string;
  mode?: ModeKind;   // NEW
}

// In render(), add to leftParts:
if (this.info.mode && this.info.mode !== "default") {
  leftParts.push(`[${this.info.mode}]`);
}
```

The mode chip appears as the first item in the left section, before the model name.

**Verify:** StatusBar render test: `mode: "plan"` produces `[plan]` in output. `mode: "default"` produces no chip. `mode: undefined` produces no chip.

---

### Task 9: App integration

**Files:** `packages/cli/src/tui/app.ts`

Wire the mode system into `App`:

1. Add `currentMode: ModeKind` field, initialized from `config.mode`.
2. Switch `SessionManager` construction to use the factory pattern for `agentConfig`.
3. Implement `setMode()` which updates `currentMode`, calls `sessionManager.appendModeChange()`, updates the status bar.
4. Expose `currentMode` and `setMode` in `buildCommandContext()`.

```typescript
// app.ts

import type { ModeKind } from "@diligent/core";

export class App {
  // ... existing fields ...
  private currentMode: ModeKind;

  constructor(config: AppConfig, paths?: DiligentPaths, options?: AppOptions) {
    // ... existing setup ...
    this.currentMode = config.mode;
  }

  async start(): Promise<void> {
    // ... existing code ...

    // Update status bar with mode
    this.statusBar.update({ model: this.config.model.id, status: "idle", cwd: process.cwd(), mode: this.currentMode });

    // Use factory pattern for agentConfig (D087: per-run config)
    if (this.paths) {
      const cwd = process.cwd();
      this.sessionManager = new SessionManager({
        cwd,
        paths: this.paths,
        agentConfig: () => ({                        // FACTORY — was plain object
          model: this.config.model,
          systemPrompt: this.config.systemPrompt,
          tools: buildTools(cwd, this.paths),
          streamFunction: this.config.streamFunction,
          mode: this.currentMode,                    // reads current mode at call time
        }),
        compaction: { ... },
        knowledgePath: this.paths.knowledge,
      });
      // ... resume logic unchanged ...
    }
  }

  private setMode(mode: ModeKind): void {
    this.currentMode = mode;
    this.sessionManager?.appendModeChange(mode, "command");
    this.statusBar.update({ mode });
    this.renderer.requestRender();
  }

  private buildCommandContext(): CommandContext {
    return {
      // ... existing fields ...
      currentMode: this.currentMode,
      setMode: (mode) => this.setMode(mode),
    };
  }
}
```

> Switching from a plain `agentConfig` object to a factory (`() => AgentLoopConfig`) is the
> change prepared in Phase 3 (D087 comment in `manager.ts`). It ensures that each call to
> `sessionManager.run()` picks up the current `this.currentMode` without having to reconstruct
> the SessionManager.

**Verify:** Integration test: switch mode via `/mode plan`, submit message, verify `agentLoop` was called with `mode: "plan"` (spy on loopFn). Status bar shows `[plan]` chip.

## Migration Notes

| Previous | New | What Changes |
|----------|-----|-------------|
| `AgentLoopConfig` has no `mode` field | `mode?: ModeKind` added | All existing callers unaffected — `undefined` = "default" behavior |
| `SessionEntry` union has 4 members | 5 members (+ `ModeChangeEntry`) | `context-builder.ts` already skips unknown types — no migration needed for reading old sessions |
| `SESSION_VERSION = 2` | `SESSION_VERSION = 3` | New sessions get version 3; old sessions read fine (no entry removal) |
| `AppConfig` has no `mode` field | `mode: ModeKind` always present | All callers that construct `AppConfig` must add `mode` field |
| `SessionManager` constructed with plain `agentConfig` object | Factory `() => AgentLoopConfig` | Factory is already supported by `resolveAgentConfig()` — no change to SessionManager internals |
| `CommandContext` has no mode fields | `currentMode`, `setMode` added | All existing command handlers receive these new fields (no breaking change) |

## Acceptance Criteria

1. `bun install` — resolves all dependencies (no new deps expected)
2. `bun test` — all existing 513 tests pass + new tests pass
3. `bun run typecheck` — no type errors, no `any` escape hatches in new code
4. `echo "list files in src/" | diligent` — runs NonInteractiveRunner, outputs to stdout, exits
5. `diligent --prompt "hello" --mode plan` — runs with plan mode, only read tools available
6. `diligent --mode invalid` — exits with error message listing valid modes
7. In TUI: `/mode plan` switches mode, status bar shows `[plan]` chip
8. In TUI: `/mode` (no args) shows ListPicker overlay with 3 options
9. In TUI: submit message in plan mode — `write_file`, `bash`, `edit_file` tools NOT offered to LLM
10. In TUI: submit message in plan mode — mode prompt prefix appears in system prompt
11. `ModeChangeEntry` written to session JSONL when `/mode` command switches mode
12. `SESSION_VERSION` in new session files is 3
13. Old session files (version 2) load without error

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | `PLAN_MODE_ALLOWED_TOOLS` filters correctly in loop | `mode-filter.test.ts`: mock tools, assert plan mode removes bash/write/edit |
| Unit | Mode prompt prefix prepended to systemPrompt | Assert `effectiveSystemPrompt` starts with plan prefix |
| Unit | `ModeChangeEntry` JSON round-trip | `JSON.parse(JSON.stringify(entry))` equals original |
| Unit | Config schema: valid/invalid mode values | Zod validation tests |
| Unit | Status bar renders `[plan]` chip, nothing for "default" | Snapshot test |
| Unit | `/mode plan` command calls `setMode("plan")` | Mock `CommandContext.setMode`, assert called |
| Unit | `/mode invalid` command calls `displayError` | Mock context, assert error |
| Integration | stdin pipe detection: `NonInteractiveRunner` invoked | Mock `process.stdin.isTTY = false`, provide stdin |
| Integration | `App.setMode()` updates currentMode + SessionManager | Mock SessionManager, verify `appendModeChange` called |
| Manual | `echo "list files" \| diligent` completes and exits | Verify output to stdout |
| Manual | `/mode plan` → submit message → only read tools used | Observe tool calls in TUI |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Factory agentConfig breaks tools reconstruction on each run | `buildTools()` called per-run instead of once | Move `tools` construction outside the factory; rebuild only on reload |
| Plan mode too restrictive for some LLM exploration patterns | LLM frustrated without bash | Document that plan mode is intentionally read-only; users can switch back with `/mode default` |
| SESSION_VERSION bump breaks existing tests that assert version | Test failures | Search for `SESSION_VERSION` in tests and update to 3 |
| Stdin read hangs if stdin is a TTY (edge case) | Never returns | Guard with `!process.stdin.isTTY` check before reading; already in the condition |
| Mode not persisted in NonInteractiveRunner sessions (no ModeChangeEntry) | Minor inconsistency | ModeChangeEntry written at session start if mode ≠ "default" (add to runner.ts if desired — stretch goal) |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D054 | Print mode — Interactive + Print modes | Task 5 (stdin pipe detection), `index.ts` |
| D087 | Collaboration modes — codex-rs style modal agent behavior | Tasks 1-4, 7-9 (all mode-related work) |
| D086 | Codex protocol alignment — SessionManager factory pattern, serialization contract | Task 3 (ModeChangeEntry roundtrip), Task 9 (factory agentConfig) |
| D051 | Slash commands — Registry pattern | Task 7 (/mode command registration) |
| D050 | Overlay system | Task 7 (/mode picker using ListPicker) |

## What Phase 4c Does NOT Include

- **No bash allowlist/denylist patterns for plan mode** — Bash is simply unavailable in plan mode. Regex-based safe-bash patterns (D087a) deferred post-Phase 4c.
- **No `request_user_input` tool** — Plan mode does not add a special user-input tool. Deferred (D087 noted as divergence).
- **No per-mode model override** — Config `mode` setting does not allow per-mode model selection. Deferred.
- **No approval system integration** — Plan mode enforces read-only via tool filtering, not via L4 deny rules. L4 remains auto-approve.
- **No mode in execute mode beyond default behavior** — Execute mode currently only injects a "work autonomously" system prompt prefix. Deeper execute-mode behavior (update_plan tool, milestone reporting) deferred.
- **No mode persistence on resume** — When a session is resumed with `--continue`, the mode defaults to `config.mode` (from config file or CLI flag), not the last-used mode from the session. Reading `ModeChangeEntry` from session on resume is deferred.
- **No ModeChangeEntry at session start** — Only explicit `/mode` switches or `--mode` flags during a run produce entries. Initial mode from config is not recorded.
