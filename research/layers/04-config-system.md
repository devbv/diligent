# Layer 4: Config System

## Key Questions

1. What configuration format is used? (TOML, JSON, JSONC, YAML?)
2. What is the configuration hierarchy/precedence? (How many layers, what overrides what?)
3. How are project-level instructions (AGENTS.md, CLAUDE.md) discovered and loaded?
4. What configuration values are supported? (Model, permissions, tools, UI, etc.)
5. How is configuration validated?
6. How does config interact with the permission/approval system?
7. Is there an enterprise/managed config layer?
8. How are configuration changes applied at runtime?
9. How is config persisted and merged?
10. What are the key abstractions and their relationships?

## codex-rs Analysis

### Configuration Format

**TOML** format. Primary config file: `~/.codex/config.toml`. Uses `toml` and `toml_edit` crates for parsing and editing.

### Configuration Hierarchy

**`ConfigLayerStack`** — multi-layer config with provenance tracking:
- Managed (cloud/enterprise requirements via `CloudRequirementsLoader`)
- Cloud-pushed requirements
- Global config (`~/.codex/config.toml`)
- Project config (`.codex/` directory in project root)
- CLI argument overrides (`ConfigOverrides`)

Loaded via `load_config_layers_state()`, merged with explicit precedence ordering (`ConfigLayerStackOrdering`).

### Key Config Types

**`ConfigToml`** — the TOML-level representation (deserialized directly from file).

**`Config`** — the fully resolved application config. Massive struct with fields including:
```rust
pub struct Config {
    pub config_layer_stack: ConfigLayerStack,
    pub startup_warnings: Vec<String>,
    pub model: Option<String>,
    pub review_model: Option<String>,
    pub model_context_window: Option<i64>,
    pub model_auto_compact_token_limit: Option<i64>,
    pub model_provider_id: String,
    pub model_provider: ModelProviderInfo,
    pub personality: Option<Personality>,
    pub permissions: Permissions,
    pub enforce_residency: Constrained<Option<ResidencyRequirement>>,
    // ... many more fields
}
```

**`Permissions`** struct (nested in Config):
```rust
pub struct Permissions {
    pub approval_policy: Constrained<AskForApproval>,
    pub sandbox_policy: Constrained<SandboxPolicy>,
    pub network: Option<NetworkProxySpec>,
    pub allow_login_shell: bool,
    pub shell_environment_policy: ShellEnvironmentPolicy,
    pub windows_sandbox_mode: Option<WindowsSandboxModeToml>,
    pub macos_seatbelt_profile_extensions: Option<MacOsSeatbeltProfileExtensions>,
}
```

### Constrained Values

**`Constrained<T>`** pattern (from `codex_config` crate) — wraps a value with constraint metadata from managed/enterprise config. Allows admins to set minimum/maximum/locked values that users cannot override.

Example: `Constrained<AskForApproval>` means the approval policy has a user-set value but may be constrained by enterprise requirements (e.g., minimum `OnRequest`).

### Project Instructions

- `AGENTS.md` / project doc files discovered in project root
- `PROJECT_DOC_MAX_BYTES = 32 KiB` — large files silently truncated
- `DEFAULT_PROJECT_DOC_FILENAME` and `LOCAL_PROJECT_DOC_FILENAME` for standard discovery
- User instructions embedded in config (`user_instructions` field)

### Rule Files

Config directories can contain `rules/` subdirectories with `*.rules` files for exec policy (see L3). These are loaded as part of the config layer stack.

### Config Service

**`ConfigService`** — runtime config management:
- Hot-reload support via `ArcSwap` for some config components
- `ConfigEdit` for programmatic config file modifications
- `ConfigEditsBuilder` for batching edits

### Additional Config Areas

- MCP servers: `mcp_servers` config with `McpServerConfig`, `McpServerTransportConfig`
- Agent roles: multi-agent configuration
- Memories: `MemoriesConfig` for persistent agent memory
- Features: `FeaturesToml` for feature flags with `FeatureOverrides`
- OTel: observability/telemetry configuration
- History: `History` config for conversation history settings
- TUI: `Tui` config for terminal UI settings

### Config Loading Flow

1. Parse TOML from multiple sources (managed → global → project)
2. Apply `ConfigOverrides` from CLI
3. Merge via `ConfigLayerStack` with provenance
4. Apply `Constrained` wrappers from cloud/managed requirements
5. Resolve final `Config` struct
6. Emit `startup_warnings` for conflicts

---

## pi-agent Analysis

### Configuration Format

**JSON** format. Two files:
- Global: `~/.pi/agent/settings.json`
- Project: `<cwd>/.pi/settings.json`

### Configuration Hierarchy

**2-layer system** (simplest of the three):
1. Global settings (`~/.pi/agent/settings.json`)
2. Project settings (`<cwd>/.pi/settings.json`)

Project overrides global via `deepMergeSettings()`.

### Key Config Types

**`Settings` interface** — flat structure with optional fields:
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

**Nested config types:**
- `CompactionSettings { enabled, reserveTokens, keepRecentTokens }`
- `RetrySettings { enabled, maxRetries, baseDelayMs, maxDelayMs }`
- `TerminalSettings { showImages, clearOnShrink }`
- `ImageSettings { autoResize, blockImages }`
- `ThinkingBudgetsSettings { minimal, low, medium, high }`

### Settings Manager

**`SettingsManager`** class — manages both scopes:
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

Tracks modified fields per-scope to support write-back (only writes changed fields, not entire settings).

### Deep Merge

`deepMergeSettings(base, overrides)`:
- For nested objects: merge recursively (`{ ...base, ...overrides }`)
- For primitives and arrays: override value wins
- Arrays are NOT merged (replaced entirely)

### File Locking

Uses `proper-lockfile` for concurrent access safety:
```typescript
class FileSettingsStorage {
    withLock(scope, fn: (current) => next): void {
        release = lockfile.lockSync(path, { realpath: false });
        // read → transform → write
    }
}
```

Prevents race conditions when multiple processes access the same settings file.

### Path Configuration

Centralized in `config.ts`:
- `APP_NAME` / `CONFIG_DIR_NAME` from `package.json` piConfig field
- `getAgentDir()`: `~/.pi/agent/` (env override: `PI_CODING_AGENT_DIR`)
- `getSettingsPath()`: `~/.pi/agent/settings.json`
- `getSessionsDir()`: `~/.pi/agent/sessions/`
- `getBinDir()`: `~/.pi/agent/bin/` (managed binaries like fd, rg)
- `getToolsDir()`: `~/.pi/agent/tools/`
- `getPromptsDir()`: `~/.pi/agent/prompts/`
- `getCustomThemesDir()`: `~/.pi/agent/themes/`

### In-Memory Testing

`InMemorySettingsStorage` — testing variant that avoids filesystem:
```typescript
class InMemorySettingsStorage implements SettingsStorage {
    private global: string | undefined;
    private project: string | undefined;
}
```

### No Validation

Settings are plain JSON parsed directly into the `Settings` interface. No schema validation (unlike opencode's Zod). Invalid values may cause runtime errors.

### No Project Instructions Discovery

pi-agent does not have a built-in system for discovering AGENTS.md or CLAUDE.md files. System prompts are configured programmatically, not via file discovery.

---

## opencode Analysis

### Configuration Format

**JSONC** (JSON with Comments). Parsed via `jsonc-parser` library. Primary files: `opencode.json` or `opencode.jsonc`.

### Configuration Hierarchy

**7+ layers** (most sophisticated of the three), low → high precedence:
1. Remote `.well-known/opencode` (organization defaults, fetched via HTTP)
2. Global config (`~/.config/opencode/opencode.json{,c}`)
3. Custom config (`OPENCODE_CONFIG` environment variable)
4. Project config (`opencode.json{,c}` in project root)
5. `.opencode` directories (`.opencode/agents/`, `.opencode/commands/`, `.opencode/plugins/`, `.opencode/opencode.json{,c}`)
6. Inline config (`OPENCODE_CONFIG_CONTENT` environment variable)
7. Managed config (enterprise: `/etc/opencode` or platform-specific)

**Managed config directory** (highest priority, admin-controlled):
```typescript
function getManagedConfigDir(): string {
    switch (process.platform) {
        case "darwin": return "/Library/Application Support/opencode"
        case "win32": return path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
        default: return "/etc/opencode"
    }
}
```

### Config Schema (Zod-validated)

**`Config.Info`** — top-level schema with extensive nested types:
```typescript
// Config.Permission — per-tool permission rules
Permission: z.record(z.string(), z.union([
    z.enum(["ask", "allow", "deny"]),
    z.record(z.string(), z.enum(["ask", "allow", "deny"]))
]))

// Config.Agent — agent definitions
Agent { model, prompt, tools, permission, steps, color, mode }

// Config.Command — slash command definitions
Command { template, description, agent, model, subtask }

// Config.Mcp — MCP server configurations
Mcp { local: { command[] }, remote: { url } }

// Config.Provider — provider overrides
Provider { options, models_whitelist, models_blacklist }
```

### Custom Merge Logic

```typescript
function merge(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source);
    // Arrays are CONCATENATED, not replaced:
    if (target.plugin && source.plugin) {
        merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]));
    }
    if (target.instructions && source.instructions) {
        merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]));
    }
    return merged;
}
```

Notable: `plugin` and `instructions` arrays are concatenated (deduplicated) across layers, not replaced. All other values follow standard deep merge (later layers win).

### Template Substitution

Config values support template patterns:
- `{env:VAR}` — environment variable substitution
- `{file:path}` — file content substitution

### Project Instructions

**Instruction file discovery** (`session/instruction.ts`):
- Searches for `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` via `Filesystem.findUp()`
- Global files: `~/.config/opencode/AGENTS.md`, `~/.claude/CLAUDE.md`
- Supports URL-based instructions (fetched with 5s timeout)
- `systemPaths()` and `system()` for loading all instruction content

### Markdown-Based Config

**`ConfigMarkdown`** — agents, commands, and plugins defined as `.md` files with YAML frontmatter:
- `.opencode/agents/*.md` — agent definitions
- `.opencode/commands/*.md` — command definitions
- `.opencode/plugins/*.ts|.js` — plugin code
- Parsed via `gray-matter` library with fallback YAML sanitization

### Directory-Based Discovery

```typescript
async function loadAgent(dir: string): Promise<Record<string, Config.Agent>> {
    const files = Glob.scanSync("*.md", { cwd: dir });
    // Parse each .md file: frontmatter → Config.Agent, body → prompt
}
```

Similar patterns for `loadCommand()` and `loadPlugin()`.

### Runtime Config State

`Config.state` — instance-scoped lazy state:
- Loaded once per project instance
- Cached via `Instance.state()`
- `Config.get()` — async accessor
- `Config.current` — synchronous accessor (after initial load)

### Config Modification

Supports programmatic config editing via `jsonc-parser`'s `modify()` + `applyEdits()`:
- `Config.set(key, value)` — modify config file
- Preserves comments and formatting in JSONC files

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Format** | TOML | JSON | JSONC (JSON with Comments) |
| **Validation** | Serde deserialization (compile-time types) | None (plain JSON parse) | Zod schemas (runtime validation) |
| **Layers** | 4-5 (managed → cloud → global → project → CLI) | 2 (global → project) | 7+ (remote → global → custom → project → .opencode → inline → managed) |
| **Enterprise/Managed** | Cloud requirements + managed layer with `Constrained<T>` | None | Managed config dir (`/etc/opencode`, highest priority) |
| **Project Instructions** | AGENTS.md with 32 KiB truncation | None | AGENTS.md/CLAUDE.md/CONTEXT.md discovery, URL-based instructions |
| **Merge Strategy** | Layer stack with provenance, constrained overrides | Deep merge (objects recursive, arrays replaced) | Deep merge + array concatenation for plugins/instructions |
| **File Locking** | Not observed | `proper-lockfile` for concurrent access | Not observed |
| **Hot Reload** | `ArcSwap` for some components, `ConfigService` | No (read at startup) | Instance-scoped state (reload per instance) |
| **Config Editing** | `ConfigEditsBuilder` for programmatic edits | Direct JSON write-back (modified fields only) | `jsonc-parser` modify + applyEdits (preserves comments) |
| **Agent/Command Config** | Agent roles in config | Extensions/skills via packages | .md files with YAML frontmatter in .opencode/ dirs |
| **Template Substitution** | Not observed | Not observed | `{env:VAR}`, `{file:path}` patterns |
| **MCP Config** | `mcp_servers` in config | Not prominent | `Config.Mcp` with local/remote variants |
| **Constrained Values** | `Constrained<T>` for enterprise requirements | N/A | Managed dir overrides everything |
| **Path Conventions** | `~/.codex/config.toml` | `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json` | `~/.config/opencode/opencode.json{,c}` + `opencode.json{,c}` |
| **Complexity** | High (layer stack, constrained values, features, provenance) | Low (2-layer merge, simple paths) | High (7 layers, Zod validation, markdown parsing, template substitution) |

## Open Questions

1. **Config format**: TOML (codex-rs) vs JSON (pi-agent) vs JSONC (opencode). For a Bun/TS project, JSON/JSONC is natural. JSONC allows comments which is user-friendly. D001 chose Bun+TS, suggesting JSONC or JSON.

2. **Number of layers**: 2 (pi-agent) vs 7+ (opencode). What is the minimum viable hierarchy? Global + project is sufficient for MVP. Enterprise/managed can be added later.

3. **Schema validation**: pi-agent has none, opencode uses Zod extensively. Given D012 (Zod for tool schemas), using Zod for config validation is consistent and provides good error messages.

4. **Project instructions**: opencode's AGENTS.md/CLAUDE.md discovery is important for tool integration. This should be implemented early since it affects system prompt construction.

5. **Constrained values**: codex-rs's `Constrained<T>` is powerful for enterprise but complex. opencode's managed config directory is simpler (just overrides). Can be deferred.

6. **File locking**: pi-agent uses `proper-lockfile` for concurrent access. Is this needed? Multiple instances editing the same config is a real scenario.

7. **Config editing**: opencode's JSONC-preserving edits are nice. pi-agent's modified-fields tracking is practical. Both are relevant for /settings commands.

8. **Markdown-based config**: opencode's .md files with frontmatter for agents/commands is elegant but adds a dependency (gray-matter). Worth the trade-off?

9. **Template substitution**: opencode's `{env:VAR}` and `{file:path}` patterns are useful for sensitive values (API keys). Simple to implement and high value.

10. **Remote config**: opencode's `.well-known/opencode` fetch is interesting for organizations. Likely too complex for MVP but worth noting for the architecture.
