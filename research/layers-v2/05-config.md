# Layer 5: Config

## Problem Definition

The Config layer provides the **configuration system** for the coding agent: schema definition, validation, multi-layer hierarchy with merge logic, project instruction discovery, and runtime config editing. It sits below most other layers, providing settings that influence behavior across the entire application. The config layer must:

1. Define a configuration schema with validation (what settings are available and their types)
2. Support a multi-layer hierarchy with clear precedence (global, project, CLI overrides)
3. Implement merge logic across config layers (deep merge with special handling for arrays)
4. Discover and load project instruction files (AGENTS.md, CLAUDE.md) via directory traversal
5. Inject discovered instructions into the system prompt
6. Support runtime config editing while preserving file formatting
7. Provide typed, validated access to configuration values throughout the application

### Key Questions

1. What configuration format is used? (JSON, JSONC, TOML?)
2. How many config layers exist and what is their precedence?
3. How is schema validation performed?
4. How does deep merge work for nested objects and arrays?
5. How are project instruction files discovered and loaded?
6. How is instruction content injected into the system prompt?
7. How is config editing implemented (preserving comments, formatting)?
8. How does config interact with the permission system?
9. Is there enterprise/managed config support?
10. How are template substitutions handled (env vars, file references)?

### Layer Scope

- Config file format and parsing (JSONC, JSON, TOML)
- Schema definition and validation (Zod, serde)
- Config hierarchy (global -> project -> CLI overrides)
- Deep merge logic with array handling
- Project instruction file discovery (findUp)
- Instruction content loading and injection
- Runtime config editing (read-modify-write)
- Template substitution (env vars, file references)
- Config path conventions and directory structure
- Enterprise/managed config layer

### Boundary: What Is NOT in This Layer

- Permission rule evaluation (L4: Approval)
- System prompt construction (L1: Agent Loop uses config, but prompt building is L1's job)
- MCP server configuration (L9: MCP reads config from this layer)
- TUI settings rendering (L7: TUI)

---

## codex-rs Analysis

### Architecture

codex-rs uses **TOML** format with a multi-crate configuration system:

```
core/src/
  config_loader.rs        - ConfigLayerStack, ConfigLayerEntry, layer loading
  exec_policy.rs          - Rule loading from config directories (see L4)

utils/
  cli/config_override.rs  - CLI argument overrides (ConfigOverrides)
  cli/lib.rs             - CLI config parsing
  home-dir/              - Home directory resolution

protocol/src/
  protocol.rs            - AskForApproval, SandboxPolicy, other config types
```

### Key Types/Interfaces

**ConfigLayerStack** -- multi-layer config with provenance tracking:
```rust
struct ConfigLayerStack {
    layers: Vec<ConfigLayerEntry>,
    requirements: ConfigRequirements,
    requirements_toml: ConfigRequirementsToml,
}
```

**ConfigLayerEntry** -- individual config layer with source tracking:
```rust
struct ConfigLayerEntry {
    source: ConfigLayerSource,  // User | Project | Managed | ...
    value: TomlValue,
    disabled: Option<String>,   // if set, layer is untrusted
}

enum ConfigLayerSource {
    User { file: AbsolutePathBuf },
    Project { dot_codex_folder: AbsolutePathBuf },
    // ... other variants
}
```

**Config** -- fully resolved application config:
```rust
struct Config {
    config_layer_stack: ConfigLayerStack,
    startup_warnings: Vec<String>,
    model: Option<String>,
    review_model: Option<String>,
    model_context_window: Option<i64>,
    model_auto_compact_token_limit: Option<i64>,
    model_provider_id: String,
    model_provider: ModelProviderInfo,
    personality: Option<Personality>,
    permissions: Permissions,
    enforce_residency: Constrained<Option<ResidencyRequirement>>,
    // ... many more fields
}
```

**Constrained<T>** -- enterprise constraint wrapper:
```rust
struct Constrained<T> {
    value: T,
    // Metadata about constraints from managed/enterprise config
}
```
Allows admins to set minimum/maximum/locked values that users cannot override.

### Implementation Details

**Config Hierarchy** (5 layers, lowest to highest precedence):
1. Managed (cloud/enterprise requirements via `CloudRequirementsLoader`)
2. Cloud-pushed requirements
3. Global config (`~/.codex/config.toml`)
4. Project config (`.codex/` directory in project root)
5. CLI argument overrides (`ConfigOverrides`)

**Config Loading Flow**:
1. Parse TOML from multiple sources
2. Load via `load_config_layers_state()` with `ConfigLayerStackOrdering`
3. Apply `ConfigOverrides` from CLI
4. Merge layers with provenance tracking
5. Apply `Constrained<T>` wrappers from cloud/managed requirements
6. Resolve final `Config` struct
7. Emit `startup_warnings` for conflicts or issues

**Project Instructions**:
- `AGENTS.md` / project doc files discovered in project root
- `PROJECT_DOC_MAX_BYTES = 32 KiB` -- large files silently truncated
- `DEFAULT_PROJECT_DOC_FILENAME` and `LOCAL_PROJECT_DOC_FILENAME` for standard discovery
- User instructions embedded in config (`user_instructions` field)

**Rule Files**: Config directories can contain `rules/` subdirectories with `*.rules` files for exec policy. These are loaded as part of the config layer stack and passed to the ExecPolicyManager.

**Hot Reload**: Some config components use `ArcSwap` for lock-free reads. `ConfigService` provides runtime config management. The ExecPolicyManager uses `ArcSwap<Policy>` for hot-reloading rule changes.

**Config Editing**: `ConfigEdit` and `ConfigEditsBuilder` support programmatic config file modifications.

**Untrusted Layers**: Project config layers can be marked as "disabled" (untrusted). Disabled layers have their rules files ignored by the ExecPolicyManager, preventing untrusted projects from injecting permissive security rules.

### Layer Boundaries

- **Above (all layers)**: All layers read from the resolved `Config` struct
- **Below (filesystem)**: Reads TOML files from `~/.codex/config.toml` and `.codex/` directories
- **Lateral (L4)**: Provides `AskForApproval` policy, `SandboxPolicy`, and rule file directories to the approval system

---

## pi-agent Analysis

### Architecture

pi-agent has the **simplest** config system of the three projects:

```
packages/coding-agent/src/
  config.ts               - Path conventions, APP_NAME, directory functions
  core/settings-manager.ts - SettingsManager class, deep merge, file locking
```

### Key Types/Interfaces

**Settings** interface -- flat structure with optional fields:
```typescript
interface Settings {
    lastChangelogVersion?: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    transport?: TransportSetting;
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    theme?: string;
    compaction?: CompactionSettings;
    branchSummary?: BranchSummarySettings;
    retry?: RetrySettings;
    hideThinkingBlock?: boolean;
    shellPath?: string;
    quietStartup?: boolean;
    shellCommandPrefix?: string;
    packages?: PackageSource[];
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
    terminal?: TerminalSettings;
    images?: ImageSettings;
    enabledModels?: string[];
    thinkingBudgets?: ThinkingBudgetsSettings;
    markdown?: MarkdownSettings;
    // ... more UI/behavior settings
}
```

**Nested Config Types**:
```typescript
interface CompactionSettings { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number }
interface RetrySettings { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number }
interface TerminalSettings { showImages?: boolean; clearOnShrink?: boolean }
```

**SettingsStorage** -- interface for config persistence:
```typescript
interface SettingsStorage {
    withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}
```

**SettingsManager** class:
```typescript
class SettingsManager {
    private storage: SettingsStorage;
    private globalSettings: Settings;
    private projectSettings: Settings;
    private settings: Settings;  // merged result
    private modifiedFields: Set<keyof Settings>;
    private modifiedProjectFields: Set<keyof Settings>;
}
```

### Implementation Details

**Config Hierarchy** (2 layers):
1. Global settings (`~/.pi/agent/settings.json`)
2. Project settings (`<cwd>/.pi/settings.json`)

Project overrides global via `deepMergeSettings()`.

**Deep Merge Logic** (`deepMergeSettings()`):
```typescript
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
    for (const key of Object.keys(overrides)) {
        if (typeof overrideValue === "object" && !Array.isArray(overrideValue)
            && typeof baseValue === "object" && !Array.isArray(baseValue)) {
            result[key] = { ...baseValue, ...overrideValue };  // recursive merge
        } else {
            result[key] = overrideValue;  // primitives/arrays: override wins
        }
    }
}
```
Arrays are NOT merged (replaced entirely). Nested objects merge recursively.

**File Locking**: Uses `proper-lockfile` for concurrent access safety:
```typescript
class FileSettingsStorage {
    withLock(scope, fn) {
        release = lockfile.lockSync(path, { realpath: false });
        // read -> transform -> write
    }
}
```

**Modified Fields Tracking**: The SettingsManager tracks which fields have been modified per scope. When writing back, only changed fields are written, not the entire settings object.

**In-Memory Testing**: `InMemorySettingsStorage` avoids filesystem operations for tests.

**Path Configuration** (centralized in `config.ts`):
- `APP_NAME` / `CONFIG_DIR_NAME` from `package.json` piConfig field
- `getAgentDir()`: `~/.pi/agent/` (env override: `PI_CODING_AGENT_DIR`)
- `getSettingsPath()`: `~/.pi/agent/settings.json`
- `getSessionsDir()`: `~/.pi/agent/sessions/`
- `getBinDir()`: `~/.pi/agent/bin/`
- `getToolsDir()`: `~/.pi/agent/tools/`
- `getPromptsDir()`: `~/.pi/agent/prompts/`

**No Validation**: Settings are plain JSON parsed directly. No schema validation (unlike opencode's Zod). Invalid values cause runtime errors.

**No Project Instructions Discovery**: pi-agent does not discover AGENTS.md or CLAUDE.md files. System prompts are configured programmatically, not via file discovery.

### Layer Boundaries

- **Above (all layers)**: Layers read from the merged `Settings` object
- **Below (filesystem)**: Reads JSON files with file locking
- **No lateral connections**: Config does not feed into permission or instruction systems

---

## opencode Analysis

### Architecture

opencode has the **most sophisticated** config system with JSONC format, Zod validation, 7+ layers, template substitution, and markdown-based agent/command definitions:

```
packages/opencode/src/
  config/config.ts        - Config namespace: schema, loading, merge, editing
  config/markdown.ts      - ConfigMarkdown: .md files with YAML frontmatter
  session/instruction.ts  - InstructionPrompt: AGENTS.md/CLAUDE.md discovery
  flag/flag.ts           - Environment variable flags
  global.ts              - Global path conventions
```

### Key Types/Interfaces

**Config.Info** -- top-level schema (Zod-validated):
```typescript
const Info = z.object({
    $schema: z.string().optional(),
    theme: z.string().optional(),
    keybinds: Keybinds.optional(),
    logLevel: Log.Level.optional(),
    tui: TUI.optional(),
    server: Server.optional(),
    command: z.record(z.string(), Command).optional(),
    skills: Skills.optional(),
    plugin: z.string().array().optional(),
    snapshot: z.boolean().optional(),
    share: z.enum(["manual", "auto", "disabled"]).optional(),
    model: ModelId.optional(),
    small_model: ModelId.optional(),
    default_agent: z.string().optional(),
    username: z.string().optional(),
    agent: z.object({
        plan: Agent.optional(),
        build: Agent.optional(),
        general: Agent.optional(),
        explore: Agent.optional(),
        title: Agent.optional(),
        summary: Agent.optional(),
        compaction: Agent.optional(),
    }).catchall(Agent).optional(),
    provider: z.record(z.string(), Provider).optional(),
    mcp: z.record(z.string(), Mcp).optional(),
    formatter: z.union([z.literal(false), z.record(...)]).optional(),
    lsp: z.union([z.literal(false), z.record(...)]).optional(),
    instructions: z.array(z.string()).optional(),
    permission: Permission.optional(),
    compaction: z.object({
        auto: z.boolean().optional(),
        prune: z.boolean().optional(),
        reserved: z.number().int().min(0).optional(),
    }).optional(),
    experimental: z.object({
        disable_paste_summary: z.boolean().optional(),
        batch_tool: z.boolean().optional(),
        openTelemetry: z.boolean().optional(),
        primary_tools: z.array(z.string()).optional(),
        continue_loop_on_deny: z.boolean().optional(),
        mcp_timeout: z.number().optional(),
    }).optional(),
}).strict()
```

**Config.Permission** -- per-tool permission rules:
```typescript
const Permission = z.preprocess(
    permissionPreprocess,  // preserve key order
    z.object({
        read: PermissionRule.optional(),
        edit: PermissionRule.optional(),
        bash: PermissionRule.optional(),
        doom_loop: PermissionAction.optional(),
        // ... more tools
    }).catchall(PermissionRule).or(PermissionAction)
).transform(permissionTransform)

// PermissionRule supports both flat and nested forms:
type PermissionRule = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">
```

**Config.Agent** -- agent definitions:
```typescript
const Agent = z.object({
    model: ModelId.optional(),
    variant: z.string().optional(),
    temperature: z.number().optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),  // deprecated
    description: z.string().optional(),
    mode: z.enum(["subagent", "primary", "all"]).optional(),
    steps: z.number().int().positive().optional(),
    permission: Permission.optional(),
    color: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.enum([...])]).optional(),
}).catchall(z.any())
```

### Implementation Details

**Config Hierarchy** (7+ layers, lowest to highest precedence):
1. Remote `.well-known/opencode` (organization defaults, fetched via HTTP)
2. Global config (`~/.config/opencode/opencode.json{,c}`)
3. Custom config (`OPENCODE_CONFIG` environment variable)
4. Project config (`opencode.json{,c}` in project root, via `findUp`)
5. `.opencode` directories (agents, commands, plugins, config)
6. Inline config (`OPENCODE_CONFIG_CONTENT` environment variable)
7. Managed config directory (enterprise: `/Library/Application Support/opencode` on macOS, `/etc/opencode` on Linux)

**Custom Merge Logic**:
```typescript
function merge(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source);
    if (target.plugin && source.plugin) {
        merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]));
    }
    if (target.instructions && source.instructions) {
        merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]));
    }
    return merged;
}
```
`plugin` and `instructions` arrays are **concatenated** (deduplicated) across layers, not replaced. All other values follow standard deep merge (later layers win).

**Template Substitution**:
```typescript
// Environment variable substitution
text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] || "")

// File content substitution
text = text.replace(/\{file:([^}]+)\}/g, async (match, filePath) => {
    const content = await Bun.file(resolvedPath).text()
    return JSON.stringify(content).slice(1, -1)  // escape for JSON
})
```

**JSONC Parsing and Editing**:
- Parsing: `jsonc-parser` library with `parseJsonc()` (allows comments, trailing commas)
- Validation: `Info.safeParse(data)` via Zod
- Editing: `patchJsonc()` function uses `jsonc-parser`'s `modify()` + `applyEdits()` to preserve comments and formatting

**Project Instruction Discovery** (`InstructionPrompt`):
```typescript
const FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

// System paths:
// 1. findUp from Instance.directory to Instance.worktree for FILES
// 2. Global files: ~/.config/opencode/AGENTS.md, ~/.claude/CLAUDE.md
// 3. Config instructions (file paths or URLs)

async function system() {
    const paths = await systemPaths()
    const files = Array.from(paths).map(async (p) => {
        const content = await Filesystem.readText(p)
        return content ? "Instructions from: " + p + "\n" + content : ""
    })
    // Also fetch URL-based instructions with 5s timeout
    return Promise.all([...files, ...fetches]).filter(Boolean)
}
```

**Contextual Instruction Resolution** (`resolve()`): When a tool reads a file, the system checks parent directories for instruction files (AGENTS.md, etc.) and loads any that haven't been seen yet. This provides contextual instructions as the agent navigates the codebase.

**Markdown-Based Config** (`ConfigMarkdown`): Agents, commands, and modes can be defined as `.md` files with YAML frontmatter in `.opencode/agents/`, `.opencode/commands/`, `.opencode/modes/` directories:
```markdown
---
model: anthropic/claude-sonnet-4-20250514
mode: subagent
description: Research and exploration
---

You are a research agent. Focus on reading and understanding code.
```

**Managed Config Directory** -- enterprise/admin-controlled (highest priority):
```typescript
function getManagedConfigDir(): string {
    switch (process.platform) {
        case "darwin": return "/Library/Application Support/opencode"
        case "win32": return path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
        default: return "/etc/opencode"
    }
}
```

**Plugin Deduplication**: Plugins from multiple sources are deduplicated by canonical name, with higher-priority sources winning.

**Auto-Schema Injection**: If a config file lacks `$schema`, opencode automatically adds `"$schema": "https://opencode.ai/config.json"` on first load.

**Legacy Migration**: Supports migration from deprecated `mode` field to `agent` field, `tools` to `permission`, `autoshare` to `share`, and legacy TOML `config` file to JSON.

### Layer Boundaries

- **Above (all layers)**: `Config.get()` (async) or `Config.current` (sync after load) provides the resolved config
- **Below (filesystem)**: Reads JSONC/JSON files, `.md` files with frontmatter, URLs
- **Lateral (L4)**: Provides `Config.Permission` to the approval system
- **Lateral (L1)**: `InstructionPrompt.system()` provides instruction content for system prompt construction
- **Lateral (L6)**: Session creation uses config for default agent, permissions, etc.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Format** | TOML | JSON | JSONC (JSON with Comments) |
| **Validation** | Serde deserialization (compile-time types) | None (plain JSON parse) | Zod schemas (runtime validation with error messages) |
| **Layers** | 5 (managed -> cloud -> global -> project -> CLI) | 2 (global -> project) | 7+ (remote -> global -> custom -> project -> .opencode -> inline -> managed) |
| **Enterprise/Managed** | Cloud requirements + `Constrained<T>` wrapper | None | Managed config dir (highest priority, admin-controlled) |
| **Merge Strategy** | Layer stack with provenance tracking | Deep merge (objects recursive, arrays replaced) | Deep merge + array concatenation for plugins/instructions |
| **Array Handling** | Standard TOML merge | Override (replace) | Concatenate + deduplicate for plugins/instructions |
| **Project Instructions** | AGENTS.md with 32 KiB truncation | None | AGENTS.md/CLAUDE.md/CONTEXT.md discovery via findUp + URL-based |
| **Instruction Injection** | Embedded in base_instructions | N/A (programmatic prompts) | `InstructionPrompt.system()` -> system messages |
| **Contextual Instructions** | Not observed | N/A | `InstructionPrompt.resolve()` loads from parent directories |
| **File Locking** | Not observed | `proper-lockfile` for concurrent access | Not observed |
| **Hot Reload** | `ArcSwap` for some components | No (read at startup) | Instance-scoped state (reload per instance) |
| **Config Editing** | `ConfigEditsBuilder` for programmatic edits | Direct JSON write-back (modified fields only) | `jsonc-parser` modify + applyEdits (preserves comments) |
| **Template Substitution** | Not observed | Not observed | `{env:VAR}`, `{file:path}` patterns |
| **MD-Based Config** | Not observed | Not observed | `.md` files with YAML frontmatter for agents/commands |
| **Remote Config** | Cloud requirements loader | Not observed | `.well-known/opencode` via HTTP fetch |
| **Constrained Values** | `Constrained<T>` for enterprise | N/A | Managed dir overrides everything |
| **Path Conventions** | `~/.codex/config.toml`, `.codex/` | `~/.pi/agent/settings.json`, `<cwd>/.pi/settings.json` | `~/.config/opencode/opencode.json{,c}`, `opencode.json{,c}` |
| **Agent Config** | Agent roles in config struct | N/A (extensions system) | `.opencode/agents/*.md` with frontmatter + config JSON |
| **Permission Config** | Separate `.rules` files | N/A | Inline `permission` field in config JSON |
| **Untrusted Layers** | Disabled layers ignore rules files | N/A | N/A |
| **Complexity** | High (multi-crate, TOML, constrained values) | Low (2-layer JSON, simple merge) | Very high (7 layers, Zod, JSONC, MD, templates, URLs) |

---

## Synthesis

### Common Patterns

1. **Hierarchical Config with Merge**: All three projects use a layered config system where higher-precedence layers override lower ones. The merge strategy varies (standard deep merge for pi-agent, special array handling for opencode).

2. **Global + Project Split**: All three have at least global and project config layers. This is the minimum viable hierarchy.

3. **Path Convention**: All use a dot-prefixed config directory (`.codex/`, `.pi/`, `.opencode/`) at the project level and a home-directory-based path for global config.

4. **Instruction File Discovery**: Both codex-rs and opencode discover project instruction files (AGENTS.md) in the project tree. opencode also supports CLAUDE.md, CONTEXT.md, URL-based instructions, and contextual resolution from parent directories.

5. **Config Drives Permissions**: Both codex-rs and opencode define permission rules in their config files. Config provides the rules; the approval layer evaluates them.

### Key Differences

1. **Validation Approach**: pi-agent has no validation. codex-rs uses Rust's type system (compile-time). opencode uses Zod (runtime with helpful error messages). For a TypeScript project, Zod is the clear winner.

2. **Config Format**: TOML (codex-rs) vs JSON (pi-agent) vs JSONC (opencode). JSONC allows comments, which is valuable for user-facing config files. JSON is the simplest. For a Bun/TS project, JSONC is optimal.

3. **Array Merge Strategy**: pi-agent replaces arrays. opencode concatenates and deduplicates `plugin` and `instructions` arrays. This distinction matters: instructions should accumulate across layers, not be replaced.

4. **Enterprise Config**: codex-rs uses `Constrained<T>` (complex wrapper). opencode uses a managed config directory (simple override). The managed directory approach is simpler and sufficient.

5. **Template Substitution**: Only opencode supports `{env:VAR}` and `{file:path}` patterns. These are valuable for sensitive values (API keys) and reusable configurations.

### Best Practices Identified

1. **opencode's JSONC + Zod pattern**: JSONC allows comments (user-friendly), Zod provides runtime validation with clear error messages, and `z.toJSONSchema()` enables IDE autocompletion via `$schema`.

2. **opencode's instruction discovery**: The `findUp` pattern for AGENTS.md/CLAUDE.md is essential for project compatibility. Contextual instruction resolution (loading from parent directories when reading files) is a nice advanced feature.

3. **opencode's template substitution**: `{env:VAR}` and `{file:path}` patterns are simple to implement and high value for API keys and reusable config.

4. **pi-agent's file locking**: Using `proper-lockfile` for concurrent config access is practical. Multiple processes editing the same config is a real scenario.

5. **opencode's JSONC-preserving edits**: Using `jsonc-parser`'s `modify()` + `applyEdits()` preserves comments and formatting when editing config files programmatically.

---

## Open Questions

### Q1: Should instructions arrays concatenate or replace across config layers?

pi-agent: replace. opencode: concatenate and deduplicate.

**Recommendation**: Concatenate for instructions (existing D034). Instructions from global config should combine with project instructions, not be replaced. Use Array.from(new Set([...base, ...override])) for deduplication.

### Q2: Should template substitution be supported?

Only opencode has this. It adds `{env:VAR}` and `{file:path}` patterns.

**Recommendation**: Yes, add `{env:VAR}` support at minimum. This is simple to implement (regex replacement), and extremely valuable for API keys and shared team configs. `{file:path}` can be deferred.

### Q3: Should the config system support managed/enterprise config?

codex-rs: full enterprise support with `Constrained<T>`. opencode: simple managed directory.

**Recommendation**: Defer managed config to post-MVP (consistent with D033). The 3-layer hierarchy (global, project, CLI) is sufficient for MVP. Enterprise can be added as a fourth layer later.

### Q4: Should JSONC editing preserve comments?

opencode does this via `jsonc-parser`. pi-agent writes modified fields only.

**Recommendation**: Defer JSONC preservation (existing D074). For MVP, use read-modify-write with standard JSON stringify. JSONC parsing for reading is needed; comment-preserving edits can come later.

### Q5: Should config support markdown-based agent/command definitions?

opencode supports `.opencode/agents/*.md` with YAML frontmatter.

**Recommendation**: Defer to post-MVP. The config JSON `agent` field provides sufficient agent configuration. Markdown-based definitions add complexity (YAML frontmatter parsing) without being essential.

## Decision Validation

| Decision | Status | Notes |
|----------|--------|-------|
| D032 (JSONC with Zod validation) | **Confirmed** | opencode proves this works well; `jsonc-parser` for reading, Zod for validation |
| D033 (3-layer hierarchy: global, project, CLI) | **Confirmed** | pi-agent uses 2, opencode uses 7+. 3 layers is the right MVP balance |
| D034 (Deep merge with array concatenation for instructions) | **Confirmed** | opencode's pattern: deep merge default + concatenate for instructions/plugins |
| D035 (CLAUDE.md discovery via findUp) | **Confirmed** | opencode discovers AGENTS.md/CLAUDE.md/CONTEXT.md via `Filesystem.findUp()` |
| D073 (No locking at MVP, advisory warning) | **Confirmed** | pi-agent uses file locking; opencode does not. Locking can be deferred |
| D074 (Config editing: read-modify-write, JSONC preservation deferred) | **Confirmed** | opencode's JSONC-preserving edits are nice but complex; defer |
