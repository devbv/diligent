# Phase 4b: Skills + Slash Commands

## Goal

The agent supports slash commands for user actions and a skill system for declarative instruction sets. Users type `/command` to control the agent, `/skill:name` to invoke skills, and the LLM can autonomously use skills when tasks match.

## Prerequisites

- Phase 4a artifact: Component-based TUI with overlay system, InputEditor, ChatView, OverlayStack, ConfirmDialog. All 404 tests passing.
- Existing system prompt assembly in `packages/cli/src/config.ts` (base prompt + knowledge + instructions).
- `.diligent/skills/` directory already created by `ensureDiligentDir()`.

## Artifact

**Demo 1 — Slash commands:**
```
diligent> /help

  Available commands:
    /help           Show available commands
    /model [name]   Switch model or show picker
    /new            Start new session
    /resume [id]    Resume session or show picker
    ...

diligent> /model
  ┌─ Model ──────────────────────┐
  │ ▸ claude-sonnet-4-20250514   │
  │   claude-opus-4-20250514     │
  │   gpt-4o                     │
  └──────────────────────────────┘

diligent> /status
  Session: abc123 · 47 entries · 12.3k tokens
  Model: claude-sonnet-4-20250514 (Anthropic)
  Config: diligent.jsonc, CLAUDE.md
```

**Demo 2 — Skills:**
```
diligent> /skills
  ┌─ Skills ─────────────────────────┐
  │ ▸ code-review  Review PR changes │
  │   refactor     Refactor patterns │
  │   test-plan    Generate tests    │
  └──────────────────────────────────┘

diligent> /skill:code-review
  [Skill loaded: code-review]
  [SKILL.md body injected into conversation]

diligent> review the latest changes
  [LLM autonomously discovers and loads relevant skill from metadata in system prompt]
```

**Demo 3 — Autocomplete:**
```
diligent> /mo[Tab]
  → /model
diligent> /skill:[Tab]
  → /skill:code-review  /skill:refactor  /skill:test-plan
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L7 (TUI) | +commands | Slash command registry (D051), command parser, autocomplete, model picker overlay, session picker overlay, skills picker overlay |
| L8 (Skills) | FULL | Skill discovery, frontmatter parsing, validation, system prompt injection, invocation (implicit + explicit) |
| L5 (Config) | +skills | `skills` section in config schema (paths, enabled, implicit invocation settings) |

**Not touched:** L0 (Provider), L1 (Agent Loop), L2 (Tool System), L3 (Core Tools), L4 (still auto-approve — deferred), L6 (Session — no schema changes), L9, L10.

## File Manifest

### packages/core/src/skills/

New module for skill discovery, parsing, and system prompt rendering.

| File | Action | Description |
|------|--------|------------|
| `types.ts` | CREATE | SkillMetadata, SkillLoadResult, SkillFrontmatter types |
| `discovery.ts` | CREATE | Multi-location skill scanning with deduplication |
| `frontmatter.ts` | CREATE | YAML frontmatter parser and validator |
| `render.ts` | CREATE | System prompt skills section renderer |
| `index.ts` | CREATE | Public exports |

### packages/cli/src/tui/commands/

New directory for slash command infrastructure.

| File | Action | Description |
|------|--------|------------|
| `types.ts` | CREATE | Command, CommandContext, CommandRegistry interfaces |
| `registry.ts` | CREATE | CommandRegistry builder with register/lookup |
| `parser.ts` | CREATE | Parse `/command args` from input text |
| `builtin/help.ts` | CREATE | /help command |
| `builtin/model.ts` | CREATE | /model command with picker overlay |
| `builtin/session.ts` | CREATE | /new, /resume, /status commands |
| `builtin/compact.ts` | CREATE | /compact command |
| `builtin/misc.ts` | CREATE | /clear, /exit, /version, /config, /cost, /bug commands |
| `builtin/reload.ts` | CREATE | /reload command |
| `builtin/skills.ts` | CREATE | /skills picker + /skill:name invocation |
| `builtin/index.ts` | CREATE | Register all built-in commands |
| `index.ts` | CREATE | Public exports |

### packages/cli/src/tui/components/

| File | Action | Description |
|------|--------|------------|
| `list-picker.ts` | CREATE | Generic list picker overlay (reused by model, session, skills pickers) |

### packages/cli/src/tui/

| File | Action | Description |
|------|--------|------------|
| `app.ts` | MODIFY | Wire command registry, intercept `/` in handleSubmit, pass CommandContext |
| `components/input-editor.ts` | MODIFY | Add Tab autocomplete for `/` prefix |

### packages/cli/src/

| File | Action | Description |
|------|--------|------------|
| `config.ts` | MODIFY | Load skills, inject into system prompt, add skills to AppConfig |

### packages/core/src/config/

| File | Action | Description |
|------|--------|------------|
| `schema.ts` | MODIFY | Add `skills` section to DiligentConfigSchema |
| `instructions.ts` | MODIFY | Add skills section parameter to buildSystemPromptWithKnowledge |

### packages/core/src/

| File | Action | Description |
|------|--------|------------|
| `index.ts` | MODIFY | Export skills module |

### Tests

| File | Action | Description |
|------|--------|------------|
| `packages/core/src/skills/__tests__/frontmatter.test.ts` | CREATE | Frontmatter parsing and validation |
| `packages/core/src/skills/__tests__/discovery.test.ts` | CREATE | Multi-location discovery, dedup, gitignore |
| `packages/core/src/skills/__tests__/render.test.ts` | CREATE | System prompt rendering |
| `packages/cli/src/tui/commands/__tests__/parser.test.ts` | CREATE | Command parsing |
| `packages/cli/src/tui/commands/__tests__/registry.test.ts` | CREATE | Registry lookup, duplicate detection |
| `packages/cli/src/tui/components/__tests__/list-picker.test.ts` | CREATE | List picker key handling and rendering |

## Implementation Tasks

### Task 1: Command Types & Registry

**Files:** `commands/types.ts`, `commands/registry.ts`
**Decisions:** D051

Define the command infrastructure types and the registry pattern.

```typescript
// commands/types.ts

export interface Command {
  name: string;
  description: string;
  /** Handler receives parsed args and context */
  handler: (args: string | undefined, ctx: CommandContext) => Promise<void>;
  /** Whether this command can run while the agent is processing */
  availableDuringTask?: boolean;
  /** Whether this command accepts arguments */
  supportsArgs?: boolean;
  /** Aliases (e.g. /q → /exit) */
  aliases?: string[];
  /** Hidden from /help listing */
  hidden?: boolean;
}

export interface CommandContext {
  /** The App instance for TUI access */
  app: AppAccessor;
  /** Current config */
  config: AppConfig;
  /** Session manager (null if no .diligent/) */
  sessionManager: SessionManager | null;
  /** Loaded skills */
  skills: SkillMetadata[];
  /** Request a TUI re-render */
  requestRender: () => void;
  /** Display lines in the chat view */
  displayLines: (lines: string[]) => void;
  /** Display an error message */
  displayError: (message: string) => void;
  /** Show an overlay */
  showOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
  /** Inject a message and run the agent */
  runAgent: (text: string) => Promise<void>;
  /** Reload config and skills */
  reload: () => Promise<void>;
}

/**
 * Subset of App exposed to commands. Avoids tight coupling.
 */
export interface AppAccessor {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  stop: () => void;
}
```

```typescript
// commands/registry.ts

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private aliases = new Map<string, string>();

  register(command: Command): this {
    if (this.commands.has(command.name)) {
      throw new Error(`Duplicate command: /${command.name}`);
    }
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliases.set(alias, command.name);
    }
    return this;
  }

  /** Look up by name or alias */
  get(name: string): Command | undefined {
    const resolved = this.aliases.get(name) ?? name;
    return this.commands.get(resolved);
  }

  /** All registered commands (for /help, autocomplete) */
  list(): Command[] {
    return [...this.commands.values()];
  }

  /** Autocomplete candidates for a partial name */
  complete(partial: string): string[] {
    const all = [...this.commands.keys(), ...this.aliases.keys()];
    return all.filter(n => n.startsWith(partial)).sort();
  }
}
```

> Commands are registered at startup and stored in a flat Map for O(1) lookup (D051). The `CommandContext` provides a controlled surface area — commands don't hold a direct reference to App internals.

**Verify:** `bun run typecheck` passes. Registry tests: register, lookup by name, lookup by alias, duplicate detection, autocomplete.

---

### Task 2: Command Parser

**Files:** `commands/parser.ts`

Parse raw input text into command name + args, or determine it's a regular message.

```typescript
// commands/parser.ts

export interface ParsedCommand {
  name: string;        // without the leading /
  args?: string;       // everything after the command name, trimmed
  raw: string;         // original input
}

/**
 * Parse a slash command from input text.
 * Returns null if the text is not a command (doesn't start with /).
 *
 * Supports:
 *   /help           → { name: "help", args: undefined }
 *   /model gpt-4o   → { name: "model", args: "gpt-4o" }
 *   /skill:review   → { name: "skill:review", args: undefined }
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.indexOf(" ");

  if (spaceIdx === -1) {
    return { name: withoutSlash, args: undefined, raw: trimmed };
  }

  return {
    name: withoutSlash.slice(0, spaceIdx),
    args: withoutSlash.slice(spaceIdx + 1).trim() || undefined,
    raw: trimmed,
  };
}

/**
 * Check if text looks like a command (for autocomplete triggering).
 */
export function isCommandPrefix(text: string): boolean {
  return text.startsWith("/") && !text.startsWith("//");
}
```

> Double-slash `//` is treated as regular text (escape hatch). The `skill:name` pattern uses `:` as part of the command name, not as a separator — this means `/skill:review args` maps to command name `skill:review` with args.

**Verify:** Parser tests: slash commands with and without args, skill:name pattern, double-slash escape, empty input, whitespace handling.

---

### Task 3: Skill Types & Frontmatter Parsing

**Files:** `packages/core/src/skills/types.ts`, `packages/core/src/skills/frontmatter.ts`
**Decisions:** D052

Define skill metadata types and the YAML frontmatter parser.

```typescript
// skills/types.ts

export interface SkillMetadata {
  /** Skill name — kebab-case, matches parent directory name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Absolute path to SKILL.md file */
  path: string;
  /** Directory containing the SKILL.md */
  baseDir: string;
  /** Where this skill was discovered */
  source: "global" | "project" | "agents" | "config";
  /** Whether the LLM can autonomously decide to use this skill */
  disableModelInvocation: boolean;
}

export interface SkillLoadResult {
  skills: SkillMetadata[];
  errors: SkillLoadError[];
}

export interface SkillLoadError {
  path: string;
  message: string;
}

// Frontmatter schema
export interface SkillFrontmatter {
  name: string;
  description: string;
  "disable-model-invocation"?: boolean;
}
```

```typescript
// skills/frontmatter.ts

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Parse SKILL.md content into frontmatter + body.
 * Returns null with error if parsing fails.
 */
export function parseFrontmatter(
  content: string,
  filePath: string,
): { frontmatter: SkillFrontmatter; body: string } | { error: string } {
  // Extract YAML between --- delimiters
  // Validate name: kebab-case, <= 64 chars
  // Validate description: non-empty, <= 1024 chars
  // Return parsed frontmatter + remaining body
}

/**
 * Validate that skill name matches its parent directory name.
 */
export function validateSkillName(name: string, dirName: string): string | null {
  if (name !== dirName) {
    return `Skill name "${name}" must match directory name "${dirName}"`;
  }
  return null;
}
```

YAML frontmatter format (D052):
```yaml
---
name: code-review
description: Review pull request changes for code quality and correctness
disable-model-invocation: false
---
```

Validation rules (from codex-rs and pi-agent analysis):
- Name: kebab-case (`[a-z0-9-]+`), max 64 chars, no leading/trailing hyphens, no consecutive hyphens
- Name must match parent directory name
- Description: required, max 1024 chars
- Body: everything after the closing `---`

> We use a minimal YAML parser for frontmatter only (just key-value pairs between `---` delimiters). No external YAML dependency needed — the frontmatter format is simple enough for regex + split parsing. If complex YAML is needed later, add `yaml` package.

**Verify:** Frontmatter tests: valid parsing, missing name, missing description, invalid name format, name/directory mismatch, description too long, no frontmatter, malformed YAML.

---

### Task 4: Skill Discovery

**Files:** `packages/core/src/skills/discovery.ts`
**Decisions:** D052

Scan multiple locations for SKILL.md files, validate, deduplicate.

```typescript
// skills/discovery.ts

export interface DiscoveryOptions {
  /** Project root (cwd) */
  cwd: string;
  /** Global config directory (default: ~/.config/diligent) */
  globalConfigDir?: string;
  /** Additional skill paths from config */
  additionalPaths?: string[];
}

/**
 * Discover skills from all configured locations.
 *
 * Discovery order (first-loaded wins for name collisions):
 * 1. Project: .diligent/skills/
 * 2. Agents: .agents/skills/ (cross-tool compat)
 * 3. Global: ~/.config/diligent/skills/
 * 4. Config paths: skills.paths[] from diligent.jsonc
 */
export async function discoverSkills(options: DiscoveryOptions): Promise<SkillLoadResult> {
  const skills: SkillMetadata[] = [];
  const errors: SkillLoadError[] = [];
  const seen = new Map<string, string>(); // name → first path

  // Scan each root in priority order
  for (const { dir, source } of getDiscoveryRoots(options)) {
    await scanSkillDirectory(dir, source, skills, errors, seen);
  }

  return { skills, errors };
}
```

Directory scanning rules:
- Look for `SKILL.md` in immediate subdirectories: `{root}/{skill-name}/SKILL.md`
- Also look for `*.md` files directly in root (flat skills without subdirectory)
- Skip hidden directories (`.`-prefixed), `node_modules`
- Deduplicate: first-loaded wins, collision logged as error
- Resolve symlinks, detect broken symlinks

Discovery roots computed from options:
```typescript
function getDiscoveryRoots(options: DiscoveryOptions): Array<{ dir: string; source: SkillMetadata["source"] }> {
  const roots: Array<{ dir: string; source: SkillMetadata["source"] }> = [];

  // 1. Project local
  roots.push({ dir: join(options.cwd, ".diligent", "skills"), source: "project" });

  // 2. Cross-tool compatibility
  roots.push({ dir: join(options.cwd, ".agents", "skills"), source: "agents" });

  // 3. Global
  const globalDir = options.globalConfigDir ?? join(homedir(), ".config", "diligent");
  roots.push({ dir: join(globalDir, "skills"), source: "global" });

  // 4. Additional config paths
  for (const p of options.additionalPaths ?? []) {
    roots.push({ dir: p, source: "config" });
  }

  return roots;
}
```

**Verify:** Discovery tests with temp directories: finds skills in each location, priority order, dedup (first wins), skips hidden dirs, handles missing directories gracefully, validates frontmatter.

---

### Task 5: System Prompt Skill Injection

**Files:** `packages/core/src/skills/render.ts`, `packages/core/src/config/instructions.ts` (MODIFY)
**Decisions:** D052, D053

Render skill metadata into a system prompt section. Only metadata — body loaded on demand (progressive disclosure).

```typescript
// skills/render.ts

/**
 * Render the skills section for the system prompt.
 * Only includes skills where disableModelInvocation is false.
 * Returns empty string if no skills are available.
 */
export function renderSkillsSection(skills: SkillMetadata[]): string {
  const implicitSkills = skills.filter(s => !s.disableModelInvocation);
  if (implicitSkills.length === 0) return "";

  const lines = [
    "## Available Skills",
    "",
    "Skills are local instruction sets you can use when a task matches their description.",
    "",
    "### Skills",
    "",
  ];

  for (const skill of implicitSkills) {
    lines.push(`- **${skill.name}**: ${skill.description} (file: ${skill.path})`);
  }

  lines.push("");
  lines.push("### How to use skills");
  lines.push("");
  lines.push("1. When a user's task matches a skill description, or the user mentions a skill by name, use it.");
  lines.push("2. To use a skill, read its SKILL.md file with the read tool to get the full instructions.");
  lines.push("3. Follow the instructions in the skill file. Resolve relative paths against the skill's directory.");
  lines.push("4. Read only what you need — don't bulk-load entire directories referenced by the skill.");
  lines.push("5. If a skill's instructions conflict with the user's request, follow the user's request.");

  return lines.join("\n");
}
```

Modify `buildSystemPromptWithKnowledge` to accept an optional skills section:

```typescript
// instructions.ts (modified signature)
export function buildSystemPromptWithKnowledge(
  basePrompt: string,
  instructions: DiscoveredInstruction[],
  knowledgeSection: string,
  additionalInstructions?: string[],
  skillsSection?: string,           // NEW
): string {
  const parts = [basePrompt];

  if (knowledgeSection) {
    parts.push(knowledgeSection);
  }

  if (skillsSection) {              // NEW
    parts.push(skillsSection);
  }

  for (const inst of instructions) {
    parts.push(`\nInstructions from: ${inst.path}\n${inst.content}`);
  }

  // ... rest unchanged
}
```

> Skills section goes after knowledge but before CLAUDE.md instructions. This means project-specific instructions can override skill behavior, which is correct — local context trumps generic skills. The comprehensive "How to use skills" instructions follow the codex-rs pattern (D052 research).

**Verify:** Render tests: empty skills list, single skill, multiple skills, disableModelInvocation filtering. Integration test: verify skills section appears in system prompt at correct position.

---

### Task 6: Config Schema Update & Skill Loading

**Files:** `packages/core/src/config/schema.ts` (MODIFY), `packages/cli/src/config.ts` (MODIFY)

Add skills config and wire discovery into loadConfig.

```typescript
// schema.ts — add to DiligentConfigSchema
skills: z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
}).optional(),
```

```typescript
// config.ts — add skill loading

import { discoverSkills, renderSkillsSection, type SkillMetadata } from "@diligent/core";

export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: string;
  streamFunction: StreamFunction;
  diligent: DiligentConfig;
  sources: string[];
  agentLoopFn?: AgentLoopFn;
  skills: SkillMetadata[];          // NEW
}

export async function loadConfig(cwd: string = process.cwd(), paths?: DiligentPaths): Promise<AppConfig> {
  // ... existing config and knowledge loading ...

  // Load skills
  let skills: SkillMetadata[] = [];
  let skillsSection = "";
  const skillsEnabled = config.skills?.enabled ?? true;
  if (skillsEnabled) {
    const result = await discoverSkills({
      cwd,
      additionalPaths: config.skills?.paths,
    });
    skills = result.skills;
    skillsSection = renderSkillsSection(skills);
    // Log discovery errors (non-fatal)
    for (const err of result.errors) {
      console.error(`Skill load error: ${err.path}: ${err.message}`);
    }
  }

  // Build system prompt with knowledge AND skills
  const systemPrompt = buildSystemPromptWithKnowledge(
    [basePrompt, ...contextLines].join("\n"),
    instructions,
    knowledgeSection,
    config.instructions,
    skillsSection,                   // NEW parameter
  );

  return { apiKey, model, systemPrompt, streamFunction, diligent: config, sources, skills };
}
```

**Verify:** `bun run typecheck` passes. Config test: skills loaded and injected into system prompt. Schema test: skills section validates correctly.

---

### Task 7: ListPicker Component

**Files:** `packages/cli/src/tui/components/list-picker.ts`

Generic overlay list picker reused by /model, /resume, /skills commands.

```typescript
// components/list-picker.ts

export interface ListPickerItem {
  label: string;
  description?: string;
  value: string;
}

export interface ListPickerOptions {
  title: string;
  items: ListPickerItem[];
  /** Index of initially selected item */
  selectedIndex?: number;
}

export class ListPicker implements Component {
  private selectedIndex: number;

  constructor(
    private options: ListPickerOptions,
    private onResult: (value: string | null) => void,
  );

  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}
```

Key handling:
- Up/Down — navigate items
- Enter — select current item → `onResult(item.value)`
- Escape / Ctrl+C — cancel → `onResult(null)`
- Type characters — filter items by label (optional, stretch)

Rendering: bordered box with highlighted current item, scroll if items exceed maxHeight.

```
┌─ Title ─────────────────────┐
│ ▸ item-one    Description   │
│   item-two    Description   │
│   item-three  Description   │
└─────────────────────────────┘
```

**Verify:** ListPicker tests: render, arrow navigation, enter selection, escape cancel, scroll with many items.

---

### Task 8: Built-in Commands (Essential)

**Files:** `commands/builtin/help.ts`, `commands/builtin/misc.ts`, `commands/builtin/session.ts`, `commands/builtin/compact.ts`, `commands/builtin/model.ts`
**Decisions:** D051

Implement the ~15 built-in commands.

**Help command:**
```typescript
// builtin/help.ts
export const helpCommand: Command = {
  name: "help",
  description: "Show available commands",
  handler: async (args, ctx) => {
    const commands = ctx.registry.list().filter(c => !c.hidden);
    const lines = [
      "\x1b[1m  Commands:\x1b[0m",
      "",
      ...commands.map(c => {
        const name = `/${c.name}`.padEnd(18);
        return `  \x1b[36m${name}\x1b[0m ${c.description}`;
      }),
      "",
    ];
    ctx.displayLines(lines);
  },
};
```

**Full command list:**

| Command | Args | During Task | Description |
|---------|------|-------------|-------------|
| `/help` | — | Yes | Show available commands |
| `/model` | `[name]` | No | Switch model or show model picker |
| `/new` | — | No | Start a new session |
| `/resume` | `[id]` | No | Resume session (picker if no id) |
| `/status` | — | Yes | Session info, tokens, model, config |
| `/compact` | — | No | Trigger manual compaction |
| `/clear` | — | Yes | Clear chat display |
| `/exit` | — | Yes | Exit diligent |
| `/version` | — | Yes | Show version |
| `/config` | — | Yes | Show config sources |
| `/cost` | — | Yes | Show token usage summary |
| `/bug` | — | Yes | Show feedback link |
| `/reload` | — | No | Reload config and skills |
| `/skills` | — | No | Show skills picker |
| `/skill:*` | — | No | Invoke a specific skill |

> `/model` and `/resume` use the ListPicker overlay from Task 7. `/skill:*` is handled as a pattern match in the command dispatch logic — any command starting with `skill:` is routed to the skill invocation handler.

**Model command detail:**
```typescript
// builtin/model.ts
export const modelCommand: Command = {
  name: "model",
  description: "Switch model or show picker",
  supportsArgs: true,
  handler: async (args, ctx) => {
    if (args) {
      // Direct switch: /model gpt-4o
      try {
        const model = resolveModel(args);
        ctx.switchModel(model);
        ctx.displayLines([`  Model switched to \x1b[1m${model.id}\x1b[0m`]);
      } catch {
        ctx.displayError(`Unknown model: ${args}`);
      }
      return;
    }
    // No args: show picker
    // Use ListPicker with KNOWN_MODELS
  },
};
```

**Session commands detail:**
```typescript
// /new — clear session and start fresh
// /resume — list sessions in picker or resume by id
// /status — display session entry count, token estimate, model, config sources
```

**Compact command:** Calls `sessionManager.run()` with a special flag, or directly invokes compaction (exposed via new SessionManager method).

```typescript
// Add to SessionManager:
async compact(): Promise<{ tokensBefore: number; tokensAfter: number; summary: string } | null>
```

**Verify:** Each command has a handler test that verifies output via mock CommandContext.

---

### Task 9: Skill Invocation

**Files:** `commands/builtin/skills.ts`
**Decisions:** D053

Handle `/skill:name` explicit invocation and `/skills` picker.

```typescript
// commands/builtin/skills.ts

/**
 * /skill:name — Invoke a skill by name.
 * Reads the SKILL.md body on demand (progressive disclosure).
 * Injects the body as a system message prefix to the next agent turn.
 */
export function createSkillInvokeCommand(skillName: string, skill: SkillMetadata): Command {
  return {
    name: `skill:${skillName}`,
    description: skill.description,
    hidden: true, // Don't clutter /help — shown via /skills
    handler: async (args, ctx) => {
      // 1. Read SKILL.md body from disk
      const content = await Bun.file(skill.path).text();
      const body = extractBody(content); // Strip frontmatter

      // 2. Display loading indicator
      ctx.displayLines([`  \x1b[2mSkill loaded: ${skill.name}\x1b[0m`]);

      // 3. Inject as user message with skill prefix and run agent
      const message = `[Using skill: ${skill.name}]\n\n${body}`;
      if (args) {
        await ctx.runAgent(`${message}\n\n${args}`);
      } else {
        await ctx.runAgent(message);
      }
    },
  };
}

/**
 * /skills — Show skills picker overlay.
 */
export const skillsPickerCommand: Command = {
  name: "skills",
  description: "Browse and invoke skills",
  handler: async (args, ctx) => {
    if (ctx.skills.length === 0) {
      ctx.displayLines(["  \x1b[2mNo skills found.\x1b[0m", "  Add skills to .diligent/skills/ or ~/.config/diligent/skills/"]);
      return;
    }

    const items: ListPickerItem[] = ctx.skills.map(s => ({
      label: s.name,
      description: s.description,
      value: s.name,
    }));

    // Show picker overlay
    return new Promise<void>((resolve) => {
      const picker = new ListPicker({ title: "Skills", items }, async (value) => {
        handle.hide();
        ctx.requestRender();
        if (value) {
          // Invoke the selected skill
          const skill = ctx.skills.find(s => s.name === value);
          if (skill) {
            const cmd = createSkillInvokeCommand(skill.name, skill);
            await cmd.handler(undefined, ctx);
          }
        }
        resolve();
      });
      const handle = ctx.showOverlay(picker, { anchor: "center" });
      ctx.requestRender();
    });
  },
};
```

Dynamic `/skill:*` registration:
```typescript
// In command registration (builtin/index.ts):
export function registerBuiltinCommands(
  registry: CommandRegistry,
  skills: SkillMetadata[],
): void {
  // ... register static commands ...

  // Register dynamic skill commands
  for (const skill of skills) {
    registry.register(createSkillInvokeCommand(skill.name, skill));
  }

  registry.register(skillsPickerCommand);
}
```

> Skill body is injected as a user message with a `[Using skill: name]` prefix. This follows pi-agent's pattern — the skill content becomes part of the conversation context. The LLM then follows the skill instructions for subsequent interactions. Progressive disclosure (D052): only metadata in system prompt, body read on explicit invocation.

**Verify:** Skill invoke test: mock skill file, verify body read and injected. Skills picker test: verify overlay shows, selection invokes correct skill.

---

### Task 10: App Integration & Command Dispatch

**Files:** `packages/cli/src/tui/app.ts` (MODIFY)

Wire the command registry into the App. Intercept `/` in handleSubmit. Build CommandContext.

```typescript
// app.ts changes

import { CommandRegistry } from "./commands/registry";
import { parseCommand, isCommandPrefix } from "./commands/parser";
import { registerBuiltinCommands } from "./commands/builtin/index";
import type { CommandContext } from "./commands/types";

export class App {
  // ... existing fields ...
  private commandRegistry: CommandRegistry;
  private skills: SkillMetadata[] = [];

  constructor(config: AppConfig, paths?: DiligentPaths, options?: AppOptions) {
    // ... existing setup ...

    // Initialize command registry
    this.skills = config.skills ?? [];
    this.commandRegistry = new CommandRegistry();
    registerBuiltinCommands(this.commandRegistry, this.skills);
  }

  private async handleSubmit(text: string): Promise<void> {
    // Check for slash command
    const parsed = parseCommand(text);
    if (parsed) {
      await this.handleCommand(parsed.name, parsed.args);
      return;
    }

    // ... existing message handling (unchanged) ...
  }

  private async handleCommand(name: string, args: string | undefined): Promise<void> {
    const command = this.commandRegistry.get(name);
    if (!command) {
      this.chatView.addLines([`  \x1b[31mUnknown command: /${name}\x1b[0m`, "  Type /help for available commands."]);
      this.renderer.requestRender();
      return;
    }

    if (this.isProcessing && !command.availableDuringTask) {
      this.chatView.addLines(["  \x1b[33mCommand not available while agent is running.\x1b[0m"]);
      this.renderer.requestRender();
      return;
    }

    const ctx = this.buildCommandContext();
    try {
      await command.handler(args, ctx);
    } catch (err) {
      this.chatView.addLines([`  \x1b[31mCommand error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`]);
    }
    this.renderer.requestRender();
  }

  private buildCommandContext(): CommandContext {
    return {
      app: { confirm: (o) => this.confirm(o), stop: () => this.stop() },
      config: this.config,
      sessionManager: this.sessionManager,
      skills: this.skills,
      registry: this.commandRegistry,
      requestRender: () => this.renderer.requestRender(),
      displayLines: (lines) => {
        this.chatView.addLines(lines);
        this.renderer.requestRender();
      },
      displayError: (msg) => {
        this.chatView.addLines([`  \x1b[31m${msg}\x1b[0m`]);
        this.renderer.requestRender();
      },
      showOverlay: (c, o) => this.overlayStack.show(c, o),
      runAgent: (text) => this.handleSubmit(text),
      reload: () => this.reloadConfig(),
    };
  }

  private async reloadConfig(): Promise<void> {
    // Re-run loadConfig, update this.config, re-discover skills,
    // re-register skill commands
  }
}
```

**Verify:** Integration test: type `/help`, verify command output appears. Type `/unknown`, verify error. Type regular text, verify agent runs normally.

---

### Task 11: InputEditor Autocomplete

**Files:** `packages/cli/src/tui/components/input-editor.ts` (MODIFY)

Add Tab completion for slash commands.

```typescript
// input-editor.ts additions

export interface InputEditorOptions {
  // ... existing ...
  /** Autocomplete provider for slash commands */
  onComplete?: (partial: string) => string[];
}

// In handleInput:
if (matchesKey(data, "tab")) {
  if (isCommandPrefix(this.text) && this.options.onComplete) {
    const candidates = this.options.onComplete(this.text.slice(1));
    if (candidates.length === 1) {
      // Single match: complete it
      this.text = `/${candidates[0]} `;
      this.cursorPos = this.text.length;
    } else if (candidates.length > 1) {
      // Multiple matches: complete common prefix
      const common = commonPrefix(candidates);
      if (common.length > this.text.length - 1) {
        this.text = `/${common}`;
        this.cursorPos = this.text.length;
      }
      // Optionally display candidates (stretch)
    }
    this.requestRender();
  }
  return true;
}
```

Wire in app.ts:
```typescript
this.inputEditor = new InputEditor(
  {
    onSubmit: (text) => this.handleSubmit(text),
    onCancel: () => this.handleCancel(),
    onExit: () => this.shutdown(),
    onComplete: (partial) => this.commandRegistry.complete(partial),
  },
  requestRender,
);
```

**Verify:** Autocomplete tests: Tab with `/he` → `/help `. Tab with `/sk` → `/skill:` or `/skills`. Tab with no match → no change.

---

### Task 12: Core Exports & Wiring

**Files:** `packages/core/src/skills/index.ts`, `packages/core/src/index.ts` (MODIFY)

Export the skills module from core.

```typescript
// skills/index.ts
export type { SkillMetadata, SkillLoadResult, SkillLoadError, SkillFrontmatter } from "./types";
export { discoverSkills } from "./discovery";
export { parseFrontmatter, validateSkillName } from "./frontmatter";
export { renderSkillsSection } from "./render";

// core/src/index.ts — add:
export type { SkillMetadata, SkillLoadResult, SkillLoadError } from "./skills/index";
export { discoverSkills, renderSkillsSection } from "./skills/index";
```

**Verify:** `bun run typecheck` passes. `bun test` — all tests pass. Core exports importable from `@diligent/core`.

---

## Migration Notes

| Previous | New | What Changes |
|----------|-----|-------------|
| `handleSubmit` sends all text to agent | `handleSubmit` intercepts `/` prefix | Commands dispatched before reaching agent loop |
| No skills in system prompt | Skills metadata injected | `buildSystemPromptWithKnowledge` gains `skillsSection` parameter |
| `AppConfig` has no skills | `AppConfig.skills: SkillMetadata[]` | Skills loaded in `loadConfig()` |
| `InputEditor` has no autocomplete | Tab completion for `/` prefix | New `onComplete` callback |
| Welcome banner shows basic tip | Could show skill count and /help hint | Minor banner update |

## Acceptance Criteria

1. `bun install` — resolves all dependencies (no new external deps expected; YAML parsing done manually)
2. `bun test` — all existing 404 tests pass + new tests pass
3. `bun run typecheck` — no type errors, no `any` escape hatches
4. `/help` lists all available commands
5. `/model` shows model picker overlay, selection switches model
6. `/new` starts a new session, `/resume` picks from existing sessions
7. `/compact` triggers compaction and displays result
8. `/status`, `/config`, `/version`, `/cost` display correct info
9. `/clear` clears chat view
10. `/exit` exits cleanly
11. `/reload` re-discovers skills and reloads config
12. Skills discovered from `.diligent/skills/`, `~/.config/diligent/skills/`, `.agents/skills/`
13. Skill metadata injected into system prompt (implicit invocation works)
14. `/skill:name` reads SKILL.md body and injects into conversation
15. `/skills` shows picker overlay, selection invokes the skill
16. Tab autocomplete works for command names and skill names
17. Unknown `/command` shows helpful error message
18. Double-slash `//text` is treated as regular message (escape hatch)
19. Commands with `availableDuringTask: false` are blocked during agent execution

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Frontmatter parsing (valid, invalid, edge cases) | `bun test` with fixture strings |
| Unit | Skill name validation (kebab-case, length, directory match) | `bun test` |
| Unit | Command parser (slash, args, skill:name, double-slash, empty) | `bun test` |
| Unit | CommandRegistry (register, lookup, alias, duplicate, complete) | `bun test` |
| Unit | Skills prompt rendering (filter, format, empty) | `bun test` |
| Unit | ListPicker (render, navigate, select, cancel) | `bun test` |
| Unit | InputEditor Tab completion (single match, multi, no match) | `bun test` |
| Integration | Skill discovery across temp directories | `bun test` with temp filesystem fixtures |
| Integration | loadConfig with skills injected into system prompt | `bun test` with temp config + skills |
| Integration | Command dispatch in App (mock SessionManager) | `bun test` with mock terminal |
| E2E | Full conversation: create skill, reload, verify LLM can discover it | Manual test |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| YAML frontmatter parser edge cases | Malformed skills crash on load | Wrap parsing in try/catch, push to errors array, continue scanning |
| Skill body injection bloats context | LLM context fills up with skill content | Progressive disclosure (D052) — only inject body on explicit invocation. Metadata ~100 tokens per skill |
| Command dispatch conflicts with regular messages | User can't send messages starting with / | Double-slash escape `//`. Only exact `/word` triggers command |
| ListPicker overlay blocks during agent execution | User can't interact | Only show picker when not processing (`availableDuringTask: false`) |
| Autocomplete performance with many skills | Slow Tab response | Linear scan is fine for <1000 commands. Cache sorted names |
| Skill name collisions across locations | User confusion about which skill loaded | First-loaded wins (project > agents > global > config). Error logged for collisions |
| `/model` switch doesn't rebuild system prompt | Stale prompt after model switch | Rebuild system prompt on model switch, update AppConfig |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D051 | Slash commands — Registry pattern with handler functions | Task 1 (types/registry), Task 8 (built-in commands), Task 10 (app integration) |
| D052 | Skills — SKILL.md with frontmatter, progressive disclosure | Task 3 (types/frontmatter), Task 4 (discovery), Task 5 (prompt rendering) |
| D053 | Skill invocation — Implicit (LLM-driven) with explicit fallback | Task 5 (system prompt), Task 9 (skill invoke/picker) |
| D045 | Inline mode with Component interface | Task 7 (ListPicker component) |
| D050 | Overlay system for modals and pickers | Task 7 (ListPicker), Task 9 (skills picker) |

## What Phase 4b Does NOT Include

- **No approval system** — Deferred to future phase. `ctx.approve()` remains auto-approve.
- **No collaboration modes** — Phase 4c (D087). No `/mode` command.
- **No print mode** — Phase 4c (D054). `runner.ts` untouched.
- **No remote skill discovery** — Deferred post-MVP (D055). No URL-based skill fetching.
- **No skill dependencies** — Deferred (D075). No `SkillDependencies` validation.
- **No skill enable/disable** — Skills are either present (loaded) or absent (removed from disk). No config toggle per-skill.
- **No skill permissions** — Deferred. Skills don't have their own permission rules.
- **No $mention syntax** — Deferred. Only `/skill:name` explicit invocation, not `$skill-name` in text.
- **No command palette** — Deferred post-MVP (D055). Only slash commands, no Cmd+Shift+P overlay.
- **No syntax highlighting** — Deferred. Skill bodies and command output use basic ANSI styling.
- **No companion metadata file** — Deferred. No `agents/openai.yaml` alongside SKILL.md (codex-rs pattern). Frontmatter only.
