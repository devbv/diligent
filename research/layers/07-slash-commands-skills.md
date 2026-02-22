# Layer 7: Slash Commands & Skills

## Key Questions

1. How are commands defined and registered?
2. What's the parsing model for slash commands? (simple prefix match, argument parsing)
3. How do commands interact with the agent loop? (inject message, modify state, trigger action)
4. Are there "skills" vs "commands"? How do they differ?
5. Can users define custom commands/skills? How?
6. How are command completions/autocomplete handled?
7. Where are built-in commands defined? (inline, separate files, config-driven)
8. What abstractions were created?
9. How does this layer interface with TUI above and agent core below?
10. What are the trade-offs of each approach?

## codex-rs Analysis

### Slash Commands

**Definition**: `SlashCommand` is a Rust enum with 30+ variants, using `strum` derive macros for string serialization:

```rust
#[derive(EnumString, EnumIter, AsRefStr, IntoStaticStr)]
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    Model, Approvals, Permissions, Skills, Review, Rename,
    New, Resume, Fork, Init, Compact, Plan, Collab, Agent,
    Diff, Mention, Status, DebugConfig, Theme, Mcp, Apps,
    Logout, Quit, Exit, Feedback, Clear, Personality,
    // ... more
}
```

Key file: `codex-rs/tui/src/slash_command.rs`

**Properties per command**:
- `description()` — user-visible description for the popup
- `command()` — string name (from strum kebab-case)
- `supports_inline_args()` — whether `/command arg` syntax is supported
- `available_during_task()` — whether command can run while agent is streaming

**Parsing**: Enum ordering is presentation order in the popup. Commands are parsed via `strum::EnumString` (simple string match on the command name).

### Command Dispatch

Commands are handled directly in the TUI's `App` struct. When the user types a slash command, the TUI intercepts it before sending to the agent. Most commands trigger TUI-level actions:
- `/model` — opens model picker overlay
- `/new` — starts new session
- `/resume` — opens session picker
- `/compact` — sends `Op::Compact` to core
- `/review` — sends review text as user input to core
- `/skills` — opens skills picker

Some commands modify agent state via `Op` (protocol operation):
- `/compact` → `Op::Compact`
- `/review` → injects review prompt as user input

### Skills System

codex-rs has a dedicated `skills` crate and skills management in `core/src/skills/`:

**Skill definition**: SKILL.md files with YAML frontmatter:
```yaml
---
name: skill-name
description: What the skill does and when to use it
metadata:
  short-description: Short description
---
# Markdown body with instructions
```

**`SkillMetadata`** struct:
```rust
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub short_description: Option<String>,
    pub interface: Option<SkillInterface>,
    pub dependencies: Option<SkillDependencies>,
    pub policy: Option<SkillPolicy>,
    pub permissions: Option<Permissions>,
    pub path: PathBuf,
    pub scope: SkillScope,
}
```

**`SkillInterface`**: UI metadata (display_name, short_description, icons, brand_color, default_prompt)

**`SkillDependencies`**: Tool dependencies (MCP tools, commands)

**`SkillPolicy`**: `allow_implicit_invocation` — whether the LLM can use this skill without explicit user invocation

**Skill discovery** (`SkillsManager`):
- System skills: embedded in the binary (`include_dir!`), installed to `CODEX_HOME/skills/.system/` on startup
- User skills: discovered from config layer stack (global `~/.codex/skills/`, project `.codex/skills/`, `.agents/skills/`)
- Caching: per-cwd cache in `RwLock<HashMap<PathBuf, SkillLoadOutcome>>`
- Loading: parse SKILL.md frontmatter + optional `agents/openai.yaml` metadata file

**Skill loading**: Skills are loaded at config time and their metadata (name + description) is injected into the system prompt. The SKILL.md body is loaded only when the skill is invoked (progressive disclosure).

**Skills vs Commands**: Skills are content-driven (SKILL.md with instructions the LLM follows). Slash commands are TUI actions (open picker, modify settings, trigger agent operations). Skills can be invoked by the LLM implicitly or explicitly via the skills picker.

Key files: `codex-rs/skills/src/lib.rs`, `codex-rs/core/src/skills/model.rs`, `codex-rs/core/src/skills/loader.rs`, `codex-rs/core/src/skills/manager.rs`

### Autocomplete

Skills are matched using fuzzy matching (`fuzzy_match()`) against display name and skill name. The TUI provides autocomplete when the user starts typing a slash command.

### Trade-offs

**Pros:**
- Clean separation: enum-based commands with compile-time exhaustiveness checking
- Skills system is well-designed with progressive disclosure (metadata always loaded, body on demand)
- System skills embedded in binary (always available)
- `SkillPolicy` allows controlling implicit invocation
- `SkillDependencies` declares tool requirements

**Cons:**
- Commands are hardcoded in a single enum — adding a command requires code change
- Command dispatch is a large match block in the TUI
- No user-defined commands (only skills, which are different)
- Tight coupling between TUI and command handling

---

## pi-agent Analysis

### Slash Commands

**Definition**: Built-in commands defined as a simple array of `{ name, description }` objects:

```typescript
interface BuiltinSlashCommand {
    name: string;
    description: string;
}

const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
    { name: "settings", description: "Open settings menu" },
    { name: "model", description: "Select model (opens selector UI)" },
    { name: "export", description: "Export session to HTML file" },
    { name: "share", description: "Share session as a secret GitHub gist" },
    { name: "new", description: "Start a new session" },
    { name: "compact", description: "Manually compact the session context" },
    { name: "resume", description: "Resume a different session" },
    { name: "reload", description: "Reload extensions, skills, prompts, and themes" },
    { name: "quit", description: "Quit pi" },
    // ... 17 total
];
```

Key file: `pi-agent/packages/coding-agent/src/core/slash-commands.ts`

### Command Dispatch

Commands are dispatched in `InteractiveMode.onSubmit` via a chain of `if/else` string prefix matches:

```typescript
this.defaultEditor.onSubmit = async (text: string) => {
    text = text.trim();
    if (!text) return;

    if (text === "/settings") { this.showSettingsSelector(); return; }
    if (text === "/model" || text.startsWith("/model ")) {
        const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
        await this.handleModelCommand(searchTerm); return;
    }
    if (text === "/new") { await this.handleClearCommand(); return; }
    // ... 17+ more commands

    // If not a command, send as user message to agent
    await this.session.prompt(text);
};
```

This is the simplest possible dispatch: string comparison in order, first match wins.

### Argument Parsing

Minimal: most commands have no arguments. `/model <search>` supports an optional search term. `/compact <instructions>` supports optional custom instructions. `/export <format>` supports format argument. Parsing is just `text.startsWith("/command ") ? text.slice(N).trim() : undefined`.

### Command Interaction with Agent Loop

- **UI-only commands**: `/settings`, `/model`, `/fork`, `/tree`, `/hotkeys` — open overlays or display info
- **Session commands**: `/new`, `/resume` — create/switch sessions via SessionManager
- **Agent commands**: `/compact` — calls `session.compact()`. `/reload` — reloads resources
- **Passthrough**: Unknown text is sent to `session.prompt(text)` (to the LLM)
- **Bash shortcut**: `!command` executes bash directly, `!!command` excludes from context

### Skills

Skills are loaded from the filesystem using `SKILL.md` files:

```typescript
interface Skill {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    source: string;
    disableModelInvocation: boolean;
}
```

**Skill loading** (`loadSkills()`):
- Discovers SKILL.md files in `~/.pi/skills/`, project `.pi/skills/`, and path-based skill directories
- Parses YAML frontmatter for name and description
- Respects `.gitignore` patterns for directory traversal
- Validates name matches parent directory, length limits (64 chars name, 1024 chars description)

**Skill invocation**: Skills are registered as slash commands with `skill:` prefix:
```typescript
for (const skill of session.resourceLoader.getSkills().skills) {
    const commandName = `skill:${skill.name}`;
    this.skillCommands.set(commandName, skill.filePath);
    skillCommandList.push({ name: commandName, description: skill.description });
}
```

When invoked via `/skill:name`, the skill's SKILL.md body is read and injected as context.

### Extensions (pi-agent's extensibility mechanism)

pi-agent has a full **extension system** that goes beyond skills:

```typescript
// Extensions can:
// - Subscribe to agent lifecycle events
// - Register LLM-callable tools
// - Register commands, keyboard shortcuts, and CLI flags
// - Interact with the user via UI primitives
```

**Extension commands**: Extensions can register custom slash commands:
```typescript
const extensionCommands = extensionRunner.getRegisteredCommands(builtinCommandNames)
    .map(cmd => ({ name: cmd.name, description: cmd.description }));
```

**Extension UI context**: Extensions can show dialogs, overlay widgets, and access terminal input.

**Prompt templates**: Additional command-like entries from prompt template files that inject predefined prompts.

### Autocomplete

`CombinedAutocompleteProvider` merges multiple sources:
1. Built-in slash commands
2. Extension commands
3. Skill commands (`skill:name` prefix)
4. Prompt template commands
5. File path completions (using `fd` for fast directory traversal)

Fuzzy matching via custom `fuzzyFilter()` and `fuzzyMatch()` functions.

Key file: `pi-agent/packages/tui/src/autocomplete.ts`

### Trade-offs

**Pros:**
- Simple and easy to understand
- Extension system allows third-party commands without code changes
- Combined autocomplete from multiple sources
- Skill invocation via slash commands (unified interface)
- Prompt templates as a lightweight command mechanism

**Cons:**
- Command dispatch is a long if/else chain (no command registry)
- Built-in commands hardcoded in two places (definition array + dispatch logic)
- No structured argument parsing (just string splitting)
- Skills require `skill:` prefix (not as seamless as codex-rs's implicit invocation)
- Extension system is complex (tools, events, UI primitives, commands all in one)

---

## opencode Analysis

### Slash Commands (as "Commands")

opencode treats slash commands as **template-based message generators**. A `Command` is essentially a named prompt template:

```typescript
namespace Command {
    const Info = z.object({
        name: z.string(),
        description: z.string().optional(),
        agent: z.string().optional(),      // which agent handles this
        model: z.string().optional(),       // override model
        source: z.enum(["command", "mcp", "skill"]).optional(),
        template: z.promise(z.string()).or(z.string()),  // prompt template
        subtask: z.boolean().optional(),    // run as subtask
        hints: z.array(z.string()),         // template variables ($1, $2, $ARGUMENTS)
    })
}
```

Key file: `opencode/packages/opencode/src/command/index.ts`

### Command Registration

Commands are registered from multiple sources:

1. **Built-in commands** (2 defaults):
   - `init` — creates/updates AGENTS.md (`source: "command"`)
   - `review` — reviews changes (`source: "command"`, `subtask: true`)

2. **User-defined commands** (from config):
   ```typescript
   for (const [name, command] of Object.entries(cfg.command ?? {})) {
       result[name] = { name, agent, model, description, source: "command",
           get template() { return command.template },
           subtask: command.subtask, hints: hints(command.template) };
   }
   ```

3. **MCP prompts** (dynamic):
   ```typescript
   for (const [name, prompt] of Object.entries(await MCP.prompts())) {
       result[name] = { name, source: "mcp", description: prompt.description,
           get template() { return MCP.getPrompt(...) } };
   }
   ```

4. **Skills** (filesystem):
   ```typescript
   for (const skill of await Skill.all()) {
       if (result[skill.name]) continue;  // don't override existing
       result[skill.name] = { name, description, source: "skill",
           get template() { return skill.content } };
   }
   ```

### Command Execution

When a command is invoked (e.g., `/review unstaged`):
1. Template is loaded (may be async for MCP prompts)
2. Template variables (`$1`, `$2`, `$ARGUMENTS`) are substituted with user arguments
3. The resulting prompt is sent to the agent
4. If `subtask: true`, runs as a sub-agent task
5. If `agent` is specified, uses that agent's configuration

### Template System

Templates use positional variables:
- `$1`, `$2`, etc. — positional arguments
- `$ARGUMENTS` — all remaining arguments

```typescript
function hints(template: string): string[] {
    const numbered = template.match(/\$\d+/g);  // Find $1, $2, etc.
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS");
    return result;
}
```

### Skills

Skills follow the same `SKILL.md` format as codex-rs:

```typescript
namespace Skill {
    const Info = z.object({
        name: z.string(),
        description: z.string(),
        location: z.string(),
        content: z.string(),
    })
}
```

**Skill discovery** (`Skill.state()`):
1. External directories: `.claude/skills/`, `.agents/skills/` (global + project-level)
2. opencode directories: `.opencode/skill/`, `.opencode/skills/`
3. Config-specified paths: `config.skills.paths[]`
4. Remote discovery: `Discovery.pull(url)` downloads skills from a remote index.json

**Skill format**: SKILL.md with YAML frontmatter (`name`, `description`), parsed by `ConfigMarkdown.parse()`.

**Unification**: Skills are automatically registered as commands (same namespace). A skill IS a command whose template is the SKILL.md body.

Key files: `opencode/packages/opencode/src/skill/skill.ts`, `opencode/packages/opencode/src/skill/discovery.ts`

### Client-Side Command Handling

On the UI side (Solid.js app), commands use a separate `CommandOption` system:

```typescript
interface CommandOption {
    id: string;
    title: string;
    description?: string;
    category?: string;
    keybind?: KeybindConfig;
    slash?: string;          // slash command name
    suggested?: boolean;
    disabled?: boolean;
    onSelect?: (source?: "palette" | "keybind" | "slash") => void;
}
```

This supports three invocation modes:
1. **Command palette** (Cmd+Shift+P) — fuzzy search all commands
2. **Keybind** — direct keyboard shortcut
3. **Slash** — `/command` in the input

### Autocomplete

Commands provide `hints` (template variables) for autocomplete. The UI can show expected arguments based on the template structure.

### Command Events

```typescript
Command.Event = {
    Executed: BusEvent.define("command.executed", z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
    })),
}
```

### Trade-offs

**Pros:**
- Unified command model: built-in, user-defined, MCP, and skills all in one namespace
- Template-based: commands are just prompt templates with variable substitution
- User-definable: config-driven command registration (no code changes needed)
- Remote skill discovery: can pull skills from a URL
- `subtask` flag for running commands as sub-agent tasks
- `agent` and `model` overrides per command

**Cons:**
- Commands are always prompt templates — no support for UI-only commands (model picker, settings, etc.)
- Template variable system is very simple ($1, $2, $ARGUMENTS — no named parameters)
- No command validation or structured argument parsing
- Skills and commands share namespace — potential naming collisions
- Remote skill discovery has security implications

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Command Definition** | Rust enum with strum macros (30+ variants) | Array of `{ name, description }` (17 builtins) | Zod-validated objects from multiple sources |
| **Command Location** | Single file (`slash_command.rs`) | Two files (definition + dispatch) | Config + MCP + skills + builtins |
| **Dispatch Model** | Enum match in App | if/else chain in InteractiveMode.onSubmit | Template substitution + agent prompt |
| **Argument Parsing** | `supports_inline_args()` flag, manual extraction | Manual string splitting | Template variables ($1, $2, $ARGUMENTS) |
| **User-Defined Commands** | No (only user skills) | Via extensions | Via config `command` section |
| **Skill Format** | SKILL.md + agents/openai.yaml | SKILL.md with frontmatter | SKILL.md with frontmatter |
| **Skill Discovery** | Config layer stack + embedded system skills | File scanning (~/.pi/skills/, project) | External dirs + opencode dirs + config paths + remote |
| **Skill Invocation** | Implicit (LLM chooses) or explicit (picker) | `/skill:name` slash command | Unified as command (same as `/review`) |
| **Progressive Disclosure** | Metadata always loaded, body on demand | Full content loaded | Full content as template |
| **Skill Dependencies** | `SkillDependencies` (tool requirements) | None | None |
| **Skill Policy** | `allow_implicit_invocation` | `disable-model-invocation` | None |
| **Extension System** | Hooks crate (limited) | Full extension system (tools, commands, UI, events) | Plugin system (separate) |
| **Autocomplete** | Fuzzy match on skill name/display name | Combined provider (commands + files + extensions) | Command palette + hints |
| **Command Palette** | No (slash prefix only) | No (slash prefix only) | Yes (Cmd+Shift+P) |
| **Remote Skills** | No | No | Yes (Discovery.pull(url)) |
| **Command as Subtask** | No | No | Yes (`subtask: true`) |
| **Agent Override** | No | No | Yes (`agent` field) |
| **Model Override** | No | No | Yes (`model` field) |
| **Built-in Count** | ~30 slash commands | 17 built-in + extensions + skills | 2 built-in + config + MCP + skills |
| **Complexity** | Medium (enum + skills system) | Low-Medium (simple dispatch + extensions) | Medium (unified but template-only) |

## Open Questions

1. **Skills vs commands distinction**: codex-rs separates skills (LLM-facing, content-driven) from commands (TUI actions). opencode unifies them as template-based commands. pi-agent has both plus extensions. Should diligent keep these separate or unify them?

2. **Command dispatch model**: codex-rs uses enum matching (compile-time safe), pi-agent uses if/else (simple), opencode uses template substitution (flexible). A registry pattern with handler functions would be a middle ground.

3. **User-defined commands**: opencode's config-driven command registration is powerful. Should diligent support user-defined commands from the start?

4. **Skill format**: All three projects use SKILL.md with YAML frontmatter. This appears to be a de facto standard. Should diligent adopt the same format for cross-compatibility?

5. **Implicit vs explicit skill invocation**: codex-rs supports LLM-driven implicit invocation (controlled by `allow_implicit_invocation`). pi-agent requires explicit `/skill:name`. Which approach is better for usability?

6. **Skill dependencies**: codex-rs's `SkillDependencies` declares required tools (MCP servers, etc.). This enables validation before skill execution. Worth adopting?

7. **Remote skill discovery**: opencode can pull skills from a URL. This enables shared skill repositories. Security considerations need resolution.

8. **Extension system scope**: pi-agent's extension system is very broad (tools, commands, UI, events). Should diligent have a plugin/extension system, and what should its scope be?

9. **Command palette**: opencode's Cmd+Shift+P command palette is a different UX pattern from slash commands. Both can coexist. Should diligent support both interaction patterns?

10. **D044 resolution**: D044 deferred "Markdown-based agent/command definitions (.md with frontmatter)" to L7. All three projects use SKILL.md with frontmatter — this pattern is confirmed.
