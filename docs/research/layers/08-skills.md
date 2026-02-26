# Layer 8: Skills

## Problem Definition

The Skills layer solves the problem of extending an agent's capabilities through declarative, file-based instruction sets that the LLM can discover and apply. Specifically:

1. **Skill discovery**: Finding SKILL.md files across multiple locations (user global, project local, config-specified paths, remote URLs) and loading their metadata.
2. **Frontmatter parsing**: Extracting structured metadata (name, description, policy flags) from YAML frontmatter in SKILL.md files.
3. **System prompt injection**: Rendering skill metadata (names + descriptions + file paths) into the system prompt so the LLM knows what skills are available and when to use them.
4. **Invocation patterns**: Supporting both implicit invocation (LLM autonomously decides to use a skill based on task matching) and explicit invocation (user mentions a skill by name or via a slash command).
5. **Progressive disclosure**: Loading only skill metadata at startup; the full SKILL.md body is read on-demand when a skill is actually invoked. This keeps the system prompt lean.
6. **Skill policy**: Controlling whether a skill can be implicitly invoked by the LLM or requires explicit user activation.
7. **Validation**: Enforcing naming conventions, description requirements, and detecting naming collisions across skill sources.

Skills are fundamentally different from commands (L7): commands are imperative TUI actions that execute code directly, while skills are declarative LLM content that instructs the model how to behave for specific tasks. A skill's power comes from its markdown body being injected into the conversation context.

## codex-rs Analysis

### Architecture

codex-rs has the most sophisticated skills system, implemented across a dedicated `skills` crate and `core/src/skills/` module (10 source files). The architecture separates skill discovery, loading, caching, system prompt rendering, and invocation into distinct modules.

Key architectural decisions:
- **System skills embedded in binary**: Using `include_dir!` macro, system skills are compiled into the binary and installed to `CODEX_HOME/skills/.system/` on startup. This ensures core skills are always available.
- **Config-layer-based discovery**: Skills are discovered from the config layer stack: global (`~/.codex/skills/`), project (`.codex/skills/`), and `.agents/skills/` directories.
- **Per-cwd caching**: `SkillsManager` caches `SkillLoadOutcome` per working directory in a `RwLock<HashMap<PathBuf, SkillLoadOutcome>>`, avoiding redundant filesystem scanning.
- **Progressive disclosure**: Only metadata (name, description, path) is loaded and injected into the system prompt. The full SKILL.md body is read from disk when the skill is invoked.
- **Implicit invocation with policy control**: Skills can opt out of implicit invocation via `SkillPolicy.allow_implicit_invocation`. The system prompt instructs the LLM to use skills when task matches description or when user mentions `$skill-name`.

### Key Types/Interfaces

**Skill metadata model** (`model.rs`):
```rust
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub short_description: Option<String>,
    pub interface: Option<SkillInterface>,
    pub dependencies: Option<SkillDependencies>,
    pub policy: Option<SkillPolicy>,
    pub permissions: Option<Permissions>,  // Experimental
    pub path: PathBuf,
    pub scope: SkillScope,  // System or User
}

pub struct SkillPolicy {
    pub allow_implicit_invocation: Option<bool>,
}

pub struct SkillInterface {
    pub display_name: Option<String>,
    pub short_description: Option<String>,
    pub icon_small: Option<PathBuf>,
    pub icon_large: Option<PathBuf>,
    pub brand_color: Option<String>,
    pub default_prompt: Option<String>,
}

pub struct SkillDependencies {
    pub tools: Vec<SkillToolDependency>,
}

pub struct SkillToolDependency {
    pub r#type: String,      // e.g., "mcp"
    pub value: String,       // tool identifier
    pub description: Option<String>,
    pub transport: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
}
```

**Skill load outcome** (`model.rs`):
```rust
pub struct SkillLoadOutcome {
    pub skills: Vec<SkillMetadata>,
    pub errors: Vec<SkillError>,
    pub disabled_paths: HashSet<PathBuf>,
}

impl SkillLoadOutcome {
    pub fn is_skill_enabled(&self, skill: &SkillMetadata) -> bool;
    pub fn is_skill_allowed_for_implicit_invocation(&self, skill: &SkillMetadata) -> bool;
    pub fn allowed_skills_for_implicit_invocation(&self) -> Vec<SkillMetadata>;
    pub fn skills_with_enabled(&self) -> impl Iterator<Item = (&SkillMetadata, bool)>;
}
```

**Skills manager** (`manager.rs`):
```rust
pub struct SkillsManager {
    codex_home: PathBuf,
    cache_by_cwd: RwLock<HashMap<PathBuf, SkillLoadOutcome>>,
}

impl SkillsManager {
    pub fn new(codex_home: PathBuf) -> Self;  // Installs system skills
    pub fn skills_for_config(&self, config: &Config) -> SkillLoadOutcome;
    pub async fn skills_for_cwd(&self, cwd: &Path, force_reload: bool) -> SkillLoadOutcome;
    pub fn clear_cache(&self);
}
```

### Implementation Details

**Frontmatter parsing** (`loader.rs`):
```rust
#[derive(Deserialize)]
struct SkillFrontmatter {
    name: String,
    description: String,
    #[serde(default)]
    metadata: SkillFrontmatterMetadata,
}
```
Additional metadata is loaded from a companion `agents/openai.yaml` file in the skill directory, which provides `interface`, `dependencies`, `policy`, and `permissions` fields. This two-file approach separates the user-facing SKILL.md from the technical metadata.

Validation enforces:
- Name max 64 characters, kebab-case (`[a-z0-9-]+`)
- Description max 1024 characters
- Name must match parent directory name

**Discovery roots** (`loader.rs`):
Skill roots are derived from the config layer stack plus `.agents/skills/` directories. Each root has a `SkillScope` (System or User). System skills from the embedded binary are installed to a system cache directory.

**System prompt injection** (`render.rs`):
```rust
pub fn render_skills_section(skills: &[SkillMetadata]) -> Option<String> {
    // "## Skills"
    // "A skill is a set of local instructions..."
    // "### Available skills"
    // For each skill: "- {name}: {description} (file: {path})"
    // "### How to use skills"
    // Detailed instructions for:
    //   - Discovery (list above = available skills)
    //   - Trigger rules ($SkillName or task matching)
    //   - Progressive disclosure (read SKILL.md, resolve relative paths)
    //   - Context hygiene (summarize, don't bulk-load)
    //   - Safety/fallback
}
```
The system prompt includes comprehensive instructions for skill usage, emphasizing progressive disclosure ("read only enough to follow the workflow"), context hygiene ("summarize long sections"), and relative path resolution ("resolve relative to the skill directory").

**Invocation via text mentions** (`injection.rs`):
```rust
pub(crate) fn extract_tool_mentions(text: &str) -> ToolMentions<'_> {
    // Scans for:
    // - $skill-name (plain mentions)
    // - [$skill-name](/path/to/SKILL.md) (linked mentions with explicit path)
    // Filters out common env vars ($PATH, $HOME, etc.)
}

pub(crate) fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<PathBuf>,
    connector_slug_counts: &HashMap<String, usize>,
) -> Vec<SkillMetadata> {
    // 1. Process structured UserInput::Skill selections (exact path match)
    // 2. Scan text inputs for $mentions
    // 3. Resolve by path first, then by name (unambiguous only)
    // 4. Skip disabled skills, skip ambiguous plain names
    // 5. Deduplicate by path
}
```
When a mentioned skill is resolved, `build_skill_injections()` reads the full SKILL.md content from disk and injects it as a `ResponseItem::SkillInstructions` into the conversation.

**Skill enable/disable** (`manager.rs`):
Users can disable specific skills via the config layer. `disabled_paths_from_stack()` reads the user-layer config for a `skills.config` section that maps skill paths to enabled/disabled state.

### Layer Boundaries

- **Above (L7 TUI & Commands)**: The TUI provides a `/skills` command that opens a skill picker overlay. Users can browse, enable/disable, and explicitly invoke skills. The TUI also handles `$skill-name` mention detection in the input editor.
- **Below (L1 Agent Loop)**: Skills are injected into the system prompt at session configuration time. The agent loop receives skill instructions as `ResponseItem` entries added to the conversation context.
- **L5 Config**: Skill discovery roots come from the config layer stack. Skill enable/disable state is stored in user-layer config.

---

## pi-agent Analysis

### Architecture

pi-agent's skills system is simpler than codex-rs's, implemented primarily in a single file (`core/skills.ts`). It follows the same SKILL.md format but with fewer metadata fields and a simpler invocation model.

Key architectural decisions:
- **Explicit invocation via slash commands**: Skills are exposed as slash commands with a `skill:` prefix (e.g., `/skill:my-skill`). There is no implicit invocation by default.
- **`disable-model-invocation` flag**: Skills can be hidden from the system prompt entirely. When true, the skill can only be invoked via `/skill:name`.
- **Simple filesystem discovery**: Scans `~/.pi/agent/skills/`, project `.pi/skills/`, and additional skill paths from config. Respects `.gitignore` patterns.
- **No caching**: Skills are loaded on-demand by the `ResourceLoader` and reloaded on `/reload`.

### Key Types/Interfaces

**Skill interface** (`skills.ts`):
```typescript
interface SkillFrontmatter {
    name?: string;
    description?: string;
    "disable-model-invocation"?: boolean;
    [key: string]: unknown;
}

interface Skill {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    source: string;                    // "user", "project", or "path"
    disableModelInvocation: boolean;
}

interface LoadSkillsResult {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
}
```

**Loading options**:
```typescript
interface LoadSkillsOptions {
    cwd?: string;
    agentDir?: string;
    skillPaths?: string[];         // Explicit paths from config
    includeDefaults?: boolean;
}
```

### Implementation Details

**Discovery** (`skills.ts`):
```typescript
export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
    // 1. Load from ~/.pi/agent/skills/ (user skills)
    // 2. Load from .pi/skills/ (project skills)
    // 3. Load from explicit skillPaths in config
    // Name collisions: first-loaded wins, collision diagnostic emitted
}
```

Discovery rules for `loadSkillsFromDir()`:
- Direct `.md` children in the root directory
- Recursive `SKILL.md` under subdirectories
- Respects `.gitignore`, `.ignore`, `.fdignore` patterns
- Skips hidden directories (`.`-prefixed) and `node_modules`
- Follows symlinks (with broken symlink detection)

**Validation** (`skills.ts`):
- Name must match parent directory name
- Name max 64 characters, lowercase `[a-z0-9-]` only
- No leading/trailing hyphens, no consecutive hyphens
- Description required, max 1024 characters
- Skills with missing description are not loaded (validation error)
- Real path deduplication prevents loading symlinked duplicates

**System prompt injection** (`skills.ts`):
```typescript
export function formatSkillsForPrompt(skills: Skill[]): string {
    // Filters out skills with disableModelInvocation=true
    // Returns XML format per Agent Skills spec:
    // <available_skills>
    //   <skill>
    //     <name>...</name>
    //     <description>...</description>
    //     <location>...</location>
    //   </skill>
    // </available_skills>
    // Includes instructions:
    // "Use the read tool to load a skill's file when the task matches"
    // "Resolve relative paths against the skill directory"
}
```
The format follows the [Agent Skills specification](https://agentskills.io/integrate-skills) using XML tags. This is different from codex-rs's markdown-based rendering.

**Invocation via TUI** (`interactive-mode.ts`):
Skills are registered as slash commands in the interactive mode:
```typescript
for (const skill of session.resourceLoader.getSkills().skills) {
    const commandName = `skill:${skill.name}`;
    this.skillCommands.set(commandName, skill.filePath);
    skillCommandList.push({ name: commandName, description: skill.description });
}
```
When invoked via `/skill:name`, the interactive mode reads the SKILL.md file and constructs a special message block:
```typescript
// parseSkillBlock() extracts the skill invocation
// The content is read from disk and injected into the conversation
```

**Implicit invocation**: The system prompt tells the LLM about available skills. The LLM can use the `read` tool to load a skill's file when it determines the task matches. However, skills with `disableModelInvocation=true` are excluded from the system prompt entirely.

### Layer Boundaries

- **Above (L7 TUI & Commands)**: Skills are exposed as slash commands with `skill:` prefix. Autocomplete includes skill commands.
- **Below (L1 Agent Loop)**: Skills are injected into the system prompt via `formatSkillsForPrompt()`. The LLM reads skill files via the `read` tool.
- **L5 Config**: Skill paths are configurable. `loadSkills()` accepts `skillPaths` from config.

---

## opencode Analysis

### Architecture

opencode's skill system is modular, implemented across `skill/skill.ts` and `skill/discovery.ts`. It uses the same SKILL.md format but adds **remote skill discovery** as a unique feature.

Key architectural decisions:
- **Unified command namespace**: Skills are automatically registered as commands. `Skill.all()` returns skills, and `Command.list()` merges them into the command registry. A skill IS a command whose template is the SKILL.md body.
- **Cross-compatibility with external agents**: Scans `.claude/skills/` and `.agents/skills/` directories in addition to `.opencode/skill/` directories, providing compatibility with Claude Code and other agents.
- **Remote discovery**: `Discovery.pull(url)` fetches a skill index from a URL, downloads skill files to a local cache, and loads them.
- **Instance-scoped state**: Uses `Instance.state()` for lazy initialization and per-instance caching.

### Key Types/Interfaces

**Skill info** (`skill.ts`):
```typescript
namespace Skill {
    const Info = z.object({
        name: z.string(),
        description: z.string(),
        location: z.string(),   // File path
        content: z.string(),    // Full SKILL.md content
    })
    type Info = z.infer<typeof Info>
}
```
Note: opencode loads the full content at discovery time, not on-demand like codex-rs. This is simpler but means all skill bodies are in memory.

**Discovery index** (`discovery.ts`):
```typescript
type Index = {
    skills: Array<{
        name: string;
        description: string;
        files: string[];   // Files to download
    }>
}
```

### Implementation Details

**Discovery** (`skill.ts`):
```typescript
export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()

    // 1. Scan external dirs (.claude/skills/, .agents/skills/) - global + project
    // 2. Scan .opencode/skill/ and .opencode/skills/ directories
    // 3. Scan additional paths from config (config.skills.paths[])
    // 4. Download and load from URLs (config.skills.urls[])
    //    via Discovery.pull(url)

    return { skills, dirs }
})
```

Scanning order (later overwrites earlier):
1. Global external: `~/.claude/skills/`, `~/.agents/skills/`
2. Project external: Walk up from `Instance.directory` to `Instance.worktree`, scanning `.claude/skills/` and `.agents/skills/`
3. Opencode directories: `.opencode/skill/` and `.opencode/skills/` from config directories
4. Config-specified paths: `config.skills.paths[]`
5. Remote URLs: `config.skills.urls[]` via `Discovery.pull()`

**Remote discovery** (`discovery.ts`):
```typescript
export async function pull(url: string): Promise<string[]> {
    // 1. Fetch index.json from base URL
    // 2. For each skill in index:
    //    a. Download each file to local cache (Global.Path.cache/skills/{name}/)
    //    b. Only download if not already cached
    // 3. Return directories containing SKILL.md
}
```
The cache directory is `$CACHE/skills/`. Files are downloaded lazily (skip if exists). The index format is a simple JSON array of skills with their file lists.

**Frontmatter parsing**: Uses `ConfigMarkdown.parse()` which extracts YAML frontmatter and returns `{ data, content }`. Validation via Zod schema (`Info.pick({ name, description })`).

**Command integration** (`command/index.ts`):
```typescript
// Skills are added to the command registry:
for (const skill of await Skill.all()) {
    if (result[skill.name]) continue;  // Don't override existing commands
    result[skill.name] = {
        name: skill.name,
        description: skill.description,
        source: "skill",
        get template() { return skill.content },
        hints: [],
    }
}
```
Skills have lower priority than built-in commands, user-defined commands, and MCP prompts. They're accessed via the same `/command` syntax as everything else -- no `skill:` prefix needed.

**System prompt injection**: Since skills are commands, their template (SKILL.md content) is substituted when the command is invoked. There is no separate "available skills" section in the system prompt. The skill content is injected directly as a user message.

**Disabling external skills**: `Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS` flag disables scanning of `.claude/` and `.agents/` directories.

### Layer Boundaries

- **Above (L7 TUI & Commands)**: Skills appear in the command palette alongside other commands. No special `skill:` prefix.
- **Below (L1 Agent Loop)**: When a skill command is invoked, its template (full SKILL.md body) is substituted into the prompt and sent to the agent.
- **L5 Config**: `config.skills.paths[]` and `config.skills.urls[]` control additional discovery locations.
- **Network**: Remote skill discovery downloads from URLs. Security implications for untrusted skill sources.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Skill Format** | SKILL.md + agents/openai.yaml | SKILL.md with frontmatter | SKILL.md with frontmatter |
| **Frontmatter Fields** | name, description, metadata.short-description | name, description, disable-model-invocation | name, description |
| **Extended Metadata** | interface, dependencies, policy, permissions (via openai.yaml) | None | None |
| **Discovery Locations** | Config layer stack + .agents/skills/ + system embedded | ~/.pi/agent/skills/ + .pi/skills/ + config paths | .claude/ + .agents/ + .opencode/ + config + URLs |
| **System Skills** | Embedded in binary, installed at startup | None | None |
| **Caching** | Per-cwd RwLock HashMap | None (reload on /reload) | Instance.state (lazy init) |
| **Content Loading** | Metadata only; body on demand | Full content at load time | Full content at load time |
| **Progressive Disclosure** | Yes (metadata -> body on invoke) | No (all loaded) | No (all loaded) |
| **System Prompt Format** | Markdown with detailed instructions | XML per Agent Skills spec | No prompt section (via command template) |
| **Prompt Instructions** | Comprehensive (trigger rules, context hygiene, safety) | Brief (read tool to load, resolve paths) | None (skill body IS the prompt) |
| **Implicit Invocation** | Yes (allow_implicit_invocation policy) | Yes (LLM reads via tool, unless disabled) | No (explicit command only) |
| **Explicit Invocation** | Skills picker in TUI | /skill:name slash command | /name command (unified) |
| **$mention Syntax** | Yes ($skill-name + linked [$name](path)) | No | No |
| **Invocation Mechanism** | ResponseItem injection into conversation | Read tool + message injection | Command template substitution |
| **Skill Policy** | allow_implicit_invocation (per-skill) | disable-model-invocation (per-skill) | None |
| **Skill Dependencies** | SkillDependencies (tools, MCP) | None | None |
| **Skill Permissions** | Experimental per-skill Permissions | None | None |
| **Skill Enable/Disable** | User config (disabled_paths) | None | None |
| **Remote Discovery** | No | No | Yes (Discovery.pull(url)) |
| **Cross-Agent Compat** | .agents/skills/ | .claude/skills/, .codex/skills/, .pi/skills/ | .claude/skills/, .agents/skills/ |
| **Name Validation** | kebab-case, 64 chars, match parent dir | kebab-case, 64 chars, match parent dir | Zod schema validation |
| **Collision Handling** | First-loaded wins | First-loaded wins, diagnostic | Duplicate warning logged |
| **Gitignore Respect** | Via config layer stack | .gitignore, .ignore, .fdignore | Via glob scanning |
| **Complexity** | High (10 files, rich metadata) | Medium (1 file, simple model) | Medium (2 files, remote discovery) |

## Synthesis

### Common Patterns

1. **SKILL.md with YAML frontmatter**: All three projects use the same fundamental format. YAML frontmatter with `name` and `description` fields, followed by a markdown body with instructions. This is a de facto industry standard (confirmed by [agentskills.io](https://agentskills.io)).

2. **Multi-location discovery**: All three scan multiple directories: user-global (home directory), project-local (cwd-relative), and config-specified paths. Priority ordering allows project-level overrides of global skills.

3. **Name-based deduplication**: All three handle naming collisions (first-loaded wins). codex-rs and pi-agent emit diagnostics; opencode logs warnings.

4. **Cross-agent compatibility**: pi-agent scans Claude Code and Codex directories. opencode scans Claude Code and .agents directories. This cross-compatibility is important for the ecosystem.

5. **Skill-as-instructions pattern**: Skills are not code -- they're natural language instructions that the LLM reads and follows. The key mechanism is "give the LLM the skill body when it's relevant."

6. **Implicit + explicit invocation**: Both codex-rs and pi-agent support LLM-driven implicit invocation (the system prompt lists available skills and instructs the LLM to use them when tasks match). Explicit invocation provides user control.

### Key Differences

1. **Progressive disclosure vs. eager loading**:
   - codex-rs loads only metadata at startup; reads SKILL.md body on demand
   - pi-agent and opencode load full content at discovery time
   - Progressive disclosure (D052) is better for large skill collections -- keeps system prompt lean.

2. **System prompt injection style**:
   - codex-rs: Detailed markdown section with comprehensive instructions (trigger rules, context hygiene, safety fallback). This is the most thorough approach.
   - pi-agent: XML format per Agent Skills spec with brief instructions.
   - opencode: No system prompt section; skills are just commands.
   - The codex-rs approach produces the best LLM behavior because the instructions explicitly guide when/how to use skills.

3. **Invocation mechanism**:
   - codex-rs: `$skill-name` mentions in text OR structured `UserInput::Skill` selections. Content injected as `ResponseItem`.
   - pi-agent: `/skill:name` slash command. Content read and injected as message.
   - opencode: Unified as command template. Content substituted and sent as message.
   - codex-rs's `$mention` syntax (D053) is the most natural for users, combined with implicit invocation.

4. **Extended metadata**:
   - codex-rs has `SkillInterface` (display metadata), `SkillDependencies` (tool requirements), `SkillPolicy` (invocation control), and experimental `Permissions`. All via a separate `agents/openai.yaml` file.
   - pi-agent has `disable-model-invocation` in frontmatter.
   - opencode has no extended metadata.
   - Skill dependencies (D075 deferred) are valuable for validating tool availability before invocation.

5. **Remote discovery**: Only opencode supports downloading skills from URLs. While powerful (enables shared skill repositories), it introduces security concerns for untrusted sources.

### Best Practices Identified

1. **Progressive disclosure** (codex-rs pattern): Load only name + description + path at startup. Inject metadata into system prompt. Read full body on-demand. This scales to large skill collections.

2. **Comprehensive system prompt instructions** (codex-rs `render.rs`): The system prompt should include:
   - Available skills list (name, description, path)
   - Trigger rules (user mentions $name OR task matches description)
   - Progressive disclosure guidance (read only what's needed)
   - Relative path resolution (resolve against skill directory)
   - Context hygiene (summarize, don't bulk-load)
   - Safety fallback (state issues, continue with best approach)

3. **Dual invocation: implicit + explicit** (D053): Allow both:
   - Implicit: LLM reads skill file via tool when task matches description
   - Explicit: User invokes via `$skill-name` mention or skill picker
   - Per-skill policy controls implicit invocation

4. **Cross-agent directory compatibility**: Scan `.claude/skills/`, `.agents/skills/`, and project-specific locations. This ensures skills work across different agent tools.

5. **YAML frontmatter validation**: Enforce naming conventions (kebab-case, 64 chars, match parent directory), require description, and validate against a schema.

6. **Gitignore-aware scanning**: Respect `.gitignore`, `.ignore`, and `.fdignore` patterns during directory traversal. Skip `node_modules` and hidden directories.

7. **Separate metadata from content**: codex-rs's `agents/openai.yaml` companion file keeps technical metadata (dependencies, policy, interface) separate from the user-facing SKILL.md. This preserves SKILL.md portability.

## Open Questions

1. **Frontmatter schema**: D052 chose SKILL.md with frontmatter. What fields should diligent's frontmatter support? Minimum is `name` + `description`. Should we add `disable-model-invocation` (pi-agent) in frontmatter or use a companion file (codex-rs)?

2. **System prompt rendering format**: codex-rs uses markdown; pi-agent uses XML per agentskills.io spec. Which format produces better LLM understanding? The agentskills.io spec is a community standard, but codex-rs's markdown with detailed instructions seems more effective.

3. **Content loading strategy**: D052 chose progressive disclosure. How do we handle the race between system prompt generation (needs metadata) and skill content loading (deferred)? codex-rs solves this by having the LLM use the `read` tool to load the body.

4. **Skill dependency validation**: D075 deferred this. codex-rs's `SkillDependencies` declares required tools (MCP servers). Should we implement validation that checks tool availability before allowing skill invocation?

5. **Remote skill discovery security**: opencode's `Discovery.pull(url)` enables shared repositories but creates supply-chain risk. Should diligent support this? If so, what verification mechanisms (signatures, checksums, allowlists)?

6. **Skill-command boundary**: opencode unifies skills as commands. pi-agent prefixes with `skill:`. codex-rs keeps them separate with a picker. D052/D053 chose separation. Is there a reason to revisit this?

7. **Skill scope and visibility**: codex-rs has `SkillScope` (System vs User) affecting visibility and priority. Should diligent distinguish between built-in skills (shipped with the agent) and user skills?

8. **$mention detection**: codex-rs's `extract_tool_mentions()` parses `$skill-name` from user text, supporting both plain mentions and linked mentions (`[$name](path)`). This requires careful parsing to avoid false positives (e.g., `$PATH`, `$HOME`). How complex should mention detection be?

9. **Skill enable/disable UI**: codex-rs has a skills picker with enable/disable toggle, persisted to user config. pi-agent has no such UI. What level of skill management UI is appropriate for v1?

10. **Skill reload**: pi-agent supports `/reload` to re-scan skills. codex-rs supports `force_reload` on the manager. When should skills be reloaded? On every session? On explicit command only?
