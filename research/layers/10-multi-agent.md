# Layer 10: Multi-Agent

## Problem Definition

Multi-agent enables a coding agent to delegate subtasks to specialized child agents, each with their own context window and (potentially) different models, permissions, and prompts. The core problems are:

1. **Task delegation**: How the LLM dispatches work to child agents via tool calls, and how the tool system (L2) facilitates this.
2. **Session/context isolation**: How child agents get their own conversation context separate from the parent, preventing context window pollution.
3. **Permission isolation**: How child agents are restricted from dangerous operations that the parent might allow (or shouldn't delegate).
4. **Agent types/roles**: How different agent specializations are defined, configured, and selected.
5. **Result collection**: How child agent output flows back to the parent agent.
6. **Depth control**: How to prevent infinite nesting of agents spawning agents.
7. **Lifecycle management**: How child agents are started, monitored, and terminated.

This is the highest-dependency layer. It must integrate with L2 (Tool System) for the task/spawn tool, L4 (Approval) for permission isolation, L6 (Session) for child session management, L1 (Agent Loop) for running the child agent's conversation, and L7 (TUI) for displaying multi-agent activity.

## codex-rs Analysis

### Architecture

codex-rs has the most sophisticated multi-agent implementation. It uses a **depth-limited tree** architecture with in-process agent threads managed by `AgentControl`. The LLM interacts through 5 separate tools:

- **`spawn_agent`**: Creates a new agent thread with initial message and optional role.
- **`send_input`**: Sends a follow-up message to an existing agent (supports interrupts).
- **`resume_agent`**: Resumes a previously closed/shutdown agent from persisted state.
- **`wait`**: Subscribes to status updates and blocks until one or more agents reach a final state.
- **`close_agent`**: Shuts down an agent thread.

All 5 tools are handled by the `MultiAgentHandler` struct implementing `ToolHandler`.

### Key Types/Interfaces

**MultiAgentHandler** (`core/src/tools/handlers/multi_agents.rs`):
```rust
pub struct MultiAgentHandler;

impl ToolHandler for MultiAgentHandler {
    fn kind(&self) -> ToolKind { ToolKind::Function }
    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError> {
        match tool_name.as_str() {
            "spawn_agent" => spawn::handle(...).await,
            "send_input" => send_input::handle(...).await,
            "resume_agent" => resume_agent::handle(...).await,
            "wait" => wait::handle(...).await,
            "close_agent" => close_agent::handle(...).await,
        }
    }
}
```

**Spawn arguments**:
```rust
struct SpawnAgentArgs {
    message: Option<String>,
    items: Option<Vec<UserInput>>,
    agent_type: Option<String>,  // role name
}
```

**Wait result**:
```rust
struct WaitResult {
    status: HashMap<ThreadId, AgentStatus>,
    timed_out: bool,
}
```

**Session source tracking**:
```rust
enum SessionSource {
    SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id: ThreadId,
        depth: i32,
        agent_nickname: Option<String>,
        agent_role: Option<String>,
    }),
    // ...
}
```

**Agent roles** (`core/src/agent/role.rs`):
```rust
// Built-in roles:
// "default" - Default agent, no config changes
// "explorer" - Fast, read-only codebase exploration
// "worker" - Execution and production work
// "monitor" - Long-running commands with large timeouts
```

**Collaboration events**:
```rust
CollabAgentSpawnBeginEvent { call_id, sender_thread_id, prompt }
CollabAgentSpawnEndEvent { call_id, sender_thread_id, new_thread_id, new_agent_nickname, new_agent_role, prompt, status }
CollabAgentInteractionBeginEvent { call_id, sender_thread_id, receiver_thread_id, prompt }
CollabAgentInteractionEndEvent { call_id, sender_thread_id, receiver_thread_id, receiver_agent_nickname, receiver_agent_role, prompt, status }
CollabWaitingBeginEvent { sender_thread_id, receiver_thread_ids, receiver_agents, call_id }
CollabWaitingEndEvent { sender_thread_id, call_id, agent_statuses, statuses }
CollabCloseBeginEvent { call_id, sender_thread_id, receiver_thread_id }
CollabCloseEndEvent { call_id, sender_thread_id, receiver_thread_id, receiver_agent_nickname, receiver_agent_role, status }
CollabResumeBeginEvent { call_id, sender_thread_id, receiver_thread_id, ... }
CollabResumeEndEvent { call_id, sender_thread_id, receiver_thread_id, ..., status }
```

### Implementation Details

**Agent spawning** (`spawn::handle()`):
1. Parse input: accepts either `message` (text) or `items` (structured UserInput, including mentions/images). Exactly one must be provided.
2. Get role name from `agent_type` parameter (defaults to `"default"`).
3. Calculate child depth via `next_thread_spawn_depth()` from current `session_source`.
4. Check depth limit: `exceeds_thread_spawn_depth_limit(child_depth, config.agent_max_depth)`.
5. Emit `CollabAgentSpawnBeginEvent`.
6. Build config: clone parent's config, set model/provider/reasoning from current turn context, set base instructions.
7. Apply role: `apply_role_to_config(&mut config, role_name)` loads role's TOML config and merges it as a `ConfigLayerEntry` with `SessionFlags` precedence.
8. Apply overrides: set `approval_policy = Never`, disable `Feature::Collab` if at depth limit boundary.
9. Call `agent_control.spawn_agent(config, input_items, session_source)` to create the thread.
10. Emit `CollabAgentSpawnEndEvent` with new thread ID and status.
11. Return `{ agent_id: thread_id }` as JSON.

**Interactive messaging** (`send_input::handle()`):
1. Parse `id` (ThreadId), `message`/`items`, and optional `interrupt` flag.
2. If `interrupt: true`, call `agent_control.interrupt_agent(id)` first.
3. Emit `CollabAgentInteractionBeginEvent`.
4. Call `agent_control.send_input(id, items)`.
5. Emit `CollabAgentInteractionEndEvent`.
6. Return `{ submission_id }`.

**Wait mechanism** (`wait::handle()`):
1. Parse `ids` (non-empty) and optional `timeout_ms`.
2. Validate timeout: must be > 0, clamped to [10s, 3600s] to prevent busy-polling.
3. Emit `CollabWaitingBeginEvent`.
4. Subscribe to status via `agent_control.subscribe_status(id)` which returns a `tokio::sync::watch::Receiver<AgentStatus>`.
5. Check for already-final statuses. If any found, return immediately.
6. Otherwise, use `FuturesUnordered` to race status watchers with `timeout_at()`.
7. Return first agent(s) to reach final status, or `timed_out: true` if deadline exceeded.
8. Emit `CollabWaitingEndEvent`.

**Agent resume** (`resume_agent::handle()`):
1. Parse agent ID and check depth limit.
2. Check current status. If `NotFound`, try `agent_control.resume_agent_from_rollout()` to restore from persisted session state.
3. Return current status.

**Permission model**:
- All child agents get `approval_policy = AskForApproval::Never` (auto-approve everything). This means sub-agents never prompt the user.
- When at the depth limit boundary (`child_depth + 1` exceeds max), `Feature::Collab` is disabled. This removes the multi-agent tools entirely from the child's tool set.

**Depth limiting**:
- Default: `DEFAULT_AGENT_MAX_DEPTH = 1` (configurable via `agent_max_depth` in config).
- Tracked via `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { depth, ... })`.
- At spawn/resume: `exceeds_thread_spawn_depth_limit(child_depth, config.agent_max_depth)` returns error message: "Agent depth limit reached. Solve the task yourself."

**Role system**:
- Built-in roles defined in `role.rs` with embedded TOML config files (`explorer.toml`, `monitor.toml`).
- User-defined roles via `config.agent_roles` map (name -> `AgentRoleConfig { description, config_file }`).
- User roles override built-in roles of the same name.
- Role config is merged as a `ConfigLayerEntry` at `SessionFlags` precedence level.
- Explorer role: sets fast model (`gpt-5.1-codex-mini`), medium reasoning effort, read-only exploration.
- Monitor role: large timeouts for long-running commands.

**Config inheritance**:
```rust
fn build_agent_spawn_config(...) -> Config {
    config.model = turn.model_info.slug.clone();
    config.model_provider = turn.provider.clone();
    config.model_reasoning_effort = turn.reasoning_effort;
    config.developer_instructions = turn.developer_instructions.clone();
    config.compact_prompt = turn.compact_prompt.clone();
    config.permissions.shell_environment_policy = turn.shell_environment_policy.clone();
    config.cwd = turn.cwd.clone();
    config.base_instructions = Some(base_instructions.text.clone());
    // Then override:
    config.permissions.approval_policy = Constrained::allow_only(AskForApproval::Never);
}
```

### Layer Boundaries

- **L2 (Tool System)**: `MultiAgentHandler` registered as a `ToolHandler` for 5 tools (`spawn_agent`, `send_input`, `resume_agent`, `wait`, `close_agent`). Uses `ToolKind::Function` and `ToolPayload::Function`.
- **L1 (Agent Loop)**: Each agent is a separate thread managed by `ThreadManager` / `AgentControl`. The agent loop runs independently in each thread.
- **L4 (Approval)**: Child agents auto-approved (`AskForApproval::Never`). Feature gating disables `Collab` at depth limit.
- **L5 (Config)**: Role configs loaded from TOML files, merged via config layer stack. `agent_max_depth` and `agent_roles` in config.
- **L6 (Session)**: Each agent is a thread with `ThreadId`. Resume from rollout (persisted session). Session source tracks parent-child relationships.
- **L7 (TUI)**: 10 event types (Spawn/Interaction/Wait/Close/Resume begin/end) enable rich TUI visualization.

---

## pi-agent Analysis

### Architecture

pi-agent implements multi-agent as an **extension** (not built-in). The `subagent` extension in `examples/extensions/subagent/` registers a single `subagent` tool via `pi.registerTool()`. Each sub-agent invocation spawns a **separate OS process** (`pi` CLI), giving complete context isolation at the cost of process overhead.

The architecture supports three execution modes: single, parallel, and chain.

### Key Types/Interfaces

**SubagentParams** (TypeBox schema):
```typescript
const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String()),    // For single mode
    task: Type.Optional(Type.String()),      // For single mode
    tasks: Type.Optional(Type.Array(TaskItem)),  // For parallel mode
    chain: Type.Optional(Type.Array(ChainItem)), // For chain mode
    agentScope: Type.Optional(AgentScopeSchema), // "user" | "project" | "both"
    confirmProjectAgents: Type.Optional(Type.Boolean()),
    cwd: Type.Optional(Type.String()),
})
```

**AgentConfig** (`agents.ts`):
```typescript
interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}
```

**SingleResult**:
```typescript
interface SingleResult {
    agent: string;
    agentSource: "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
}
```

### Implementation Details

**Agent discovery** (`agents.ts`):
- User agents: `~/.pi/agent/agents/*.md`
- Project agents: `.pi/agents/*.md` (nearest ancestor directory, searched upward)
- Scope controlled by `agentScope` parameter: `"user"` (default), `"project"`, `"both"`
- Agent definition in Markdown with YAML frontmatter:
  ```yaml
  ---
  name: agent-name
  description: What this agent does
  tools: tool1,tool2,tool3
  model: model-name
  ---
  System prompt content here...
  ```
- Project agents override user agents of the same name.

**Single mode execution** (`runSingleAgent()`):
1. Look up agent config by name. Return error if not found.
2. Build CLI args: `["--mode", "json", "-p", "--no-session"]` plus optional `--model`, `--tools`, `--append-system-prompt`.
3. If agent has system prompt, write to temp file and pass via `--append-system-prompt`.
4. Spawn `pi` process with `spawn("pi", args, { cwd, shell: false, stdio: [...] })`.
5. Parse NDJSON events from stdout:
   - `message_end`: Capture messages, usage stats (tokens, cost), model, stopReason.
   - `tool_result_end`: Capture tool results.
6. Track stderr separately.
7. Emit `onUpdate` callbacks for streaming progress.
8. Wait for process exit. Non-zero exit, `error` stopReason, or `aborted` stopReason = failure.

**Parallel mode**:
- Max 8 tasks, max 4 concurrent via `mapWithConcurrencyLimit()`.
- Each task runs as separate `runSingleAgent()` invocation.
- Progress tracked with placeholder results updated as tasks complete.
- Returns summary: `"Parallel: X/Y succeeded"` with per-task previews.

**Chain mode**:
- Sequential execution with `{previous}` placeholder text substitution.
- Each step receives the final output of the previous step injected into its task string.
- Stops on first error.
- Returns final step's output.

**Permission model**:
- Process isolation provides inherent sandboxing (each agent is a separate OS process).
- Project agent confirmation: When using project-local agents (`agentScope: "both"` or `"project"`), user is prompted via `ctx.ui.confirm()` before running (security against untrusted repos).
- No explicit tool restriction beyond what's in the agent config `tools` field (which controls which tools the CLI loads).

**Abort handling**:
- `signal: AbortSignal` passed to `runSingleAgent()`.
- On abort: `proc.kill("SIGTERM")`, then `SIGKILL` after 5s timeout if process still alive.

**Depth limiting**:
- No explicit depth limit. Since each agent is a separate process with `--no-session`, recursive nesting would require the sub-agent to explicitly invoke the subagent extension again.

**TUI rendering**:
- Rich `renderCall()` shows mode (single/parallel/chain) with agent names and task previews.
- `renderResult()` shows success/failure per agent, collapsed/expanded display items (tool calls + text), usage stats.
- Supports `Ctrl+O` to expand/collapse output.

### Layer Boundaries

- **L2 (Tool System)**: Registered as a single tool via `pi.registerTool()`. Uses pi-agent's extension API.
- **L1 (Agent Loop)**: Each sub-agent runs a completely separate `pi` CLI process with its own agent loop.
- **L4 (Approval)**: Project agent confirmation via `ctx.ui.confirm()`. No explicit permission restriction within agents.
- **L5 (Config)**: Agent configs in Markdown files with YAML frontmatter. No config integration (agents discovered from filesystem).
- **L6 (Session)**: `--no-session` flag means no persistence. Each invocation is ephemeral.
- **L7 (TUI)**: Rich `renderCall`/`renderResult` functions. `onUpdate` callbacks for streaming. Collapsed/expanded views.

---

## opencode Analysis

### Architecture

opencode implements multi-agent through a **TaskTool** that creates child sessions. It has a well-defined agent type system with per-agent permissions, prompts, and model configurations. The architecture is a **session-based tree** where each sub-agent runs in a child session linked to the parent.

The key components:
- **`src/tool/task.ts`**: The `TaskTool` definition.
- **`src/agent/agent.ts`**: The `Agent` namespace with type definitions, built-in agents, and config override logic.
- **`src/session/prompt.ts`**: `SessionPrompt.prompt()` runs the agent loop in a child session.

### Key Types/Interfaces

**TaskTool parameters** (`src/tool/task.ts`):
```typescript
const parameters = z.object({
    description: z.string().describe("A short (3-5 words) description of the task"),
    prompt: z.string().describe("The task for the agent to perform"),
    subagent_type: z.string().describe("The type of specialized agent to use for this task"),
    task_id: z.string().optional().describe("Resume a previous task by passing prior task_id"),
    command: z.string().optional().describe("The command that triggered this task"),
})
```

**Agent.Info** (`src/agent/agent.ts`):
```typescript
const Info = z.object({
    name: z.string(),
    description: z.string().optional(),
    mode: z.enum(["subagent", "primary", "all"]),
    native: z.boolean().optional(),
    hidden: z.boolean().optional(),
    topP: z.number().optional(),
    temperature: z.number().optional(),
    color: z.string().optional(),
    permission: PermissionNext.Ruleset,
    model: z.object({ modelID, providerID }).optional(),
    variant: z.string().optional(),
    prompt: z.string().optional(),
    options: z.record(z.string(), z.any()),
    steps: z.number().int().positive().optional(),
})
```

**Built-in agents**:

| Agent | Mode | Description | Key Permissions |
|-------|------|-------------|-----------------|
| `build` | primary | Default agent, full tool access | question/plan_enter allowed |
| `plan` | primary | Plan mode, edits restricted to plan files | edit: deny (except plan dirs) |
| `general` | subagent | General-purpose research and multi-step tasks | todoread/todowrite denied |
| `explore` | subagent | Fast codebase exploration | Only read-only tools allowed |
| `compaction` | primary (hidden) | Context compaction | All tools denied |
| `title` | primary (hidden) | Title generation | All tools denied, temp 0.5 |
| `summary` | primary (hidden) | Summary generation | All tools denied |

### Implementation Details

**TaskTool execution flow** (`task.ts`):
1. List agents, filter to non-primary mode (callable by task tool).
2. Filter by caller's permissions: `PermissionNext.evaluate("task", agent.name, caller.permission)`.
3. Build tool description listing accessible agents.
4. On execute:
   a. Permission check: `ctx.ask({ permission: "task", patterns: [params.subagent_type] })` (skipped if `bypassAgentCheck` is set, i.e. user explicitly invoked via `@`).
   b. Look up agent: `Agent.get(params.subagent_type)`. Error if not found.
   c. Check `hasTaskPermission`: Whether the agent's own permission ruleset includes a `task` permission rule.
   d. Create or resume session:
      - If `task_id` provided, try `Session.get(task_id)`.
      - Otherwise: `Session.create({ parentID: ctx.sessionID, title, permission: [...] })`.
   e. Child session permissions:
      ```typescript
      permission: [
          { permission: "todowrite", pattern: "*", action: "deny" },
          { permission: "todoread", pattern: "*", action: "deny" },
          // If agent doesn't have task permission:
          { permission: "task", pattern: "*", action: "deny" },
          // Primary tools allowed:
          ...primary_tools.map(t => ({ permission: t, pattern: "*", action: "allow" })),
      ]
      ```
   f. Run prompt: `SessionPrompt.prompt({ messageID, sessionID, model, agent, tools, parts })`.
   g. Tools disabled in child: `{ todowrite: false, todoread: false, task: false (if no permission) }`.
   h. Extract result: last text part from prompt result.
   i. Return output:
      ```
      task_id: <session_id> (for resuming to continue this task if needed)

      <task_result>
      <final text output>
      </task_result>
      ```

**Agent configuration** (`agent.ts`):
- Agents defined in code with `Instance.state()` singleton.
- Default permissions built from a base set: `{ "*": "allow", doom_loop: "ask", question: "deny", plan_enter: "deny", ... }`.
- User permissions from config merged via `PermissionNext.merge(defaults, user)`.
- Each agent gets permissions = `PermissionNext.merge(defaults, agent_specific, user)`.
- Config overrides: `cfg.agent` section allows users to modify, disable, or create agents.
- Override fields: model, variant, prompt, description, temperature, topP, mode, color, hidden, name, steps, options, permission.

**Permission isolation model**:
- `todowrite` and `todoread` always denied (prevents sub-agents from modifying the parent's task list).
- `task` tool denied unless the agent explicitly has task permission (prevents infinite nesting by default).
- Primary tools (from `config.experimental?.primary_tools`) allowed through.
- The caller's permission system controls which agent types can be invoked (`ctx.ask({ permission: "task", patterns: [subagent_type] })`).

**Depth limiting**:
- Implicit via permission: sub-agents have `task` tool denied unless explicitly permitted in their permission ruleset.
- No explicit numeric depth limit (unlike codex-rs's `agent_max_depth`).
- The `general` agent doesn't have `task` permission, so it cannot spawn further agents.
- But a user-configured agent could have `task` permission, enabling nesting.

**Session integration**:
- Child sessions are full `Session` objects with `parentID` linking to the parent.
- Sessions persisted in the session store.
- Resume: If `task_id` provided, the existing session is retrieved and continued.
- Session title: `"description (@agent_name subagent)"`.

**Agent generation** (`Agent.generate()`):
- Unique feature: LLM generates new agent configurations from natural language descriptions.
- Uses `generateObject()` with schema: `{ identifier, whenToUse, systemPrompt }`.
- Prevents duplicate names by listing existing agents.

**Model selection**:
- Agent can specify model: `agent.model: { modelID, providerID }`.
- Falls back to parent message's model if not specified.

**Abort handling**:
- Registers `SessionPrompt.cancel(session.id)` on abort signal.
- Uses `defer()` pattern for cleanup on abort listener.

### Layer Boundaries

- **L2 (Tool System)**: `TaskTool` registered via `Tool.define("task", ...)`. Single tool, dynamic description based on available agents.
- **L1 (Agent Loop)**: Child agent runs via `SessionPrompt.prompt()` which invokes the full agent loop in the child session.
- **L4 (Approval)**: Permission check via `ctx.ask({ permission: "task", patterns: [agent_type] })`. Per-agent permission rulesets. Selective tool denial in child sessions.
- **L5 (Config)**: `agent` section in config for overrides. Permission rules in config.
- **L6 (Session)**: Full session per child agent with `parentID`. Resume support via `task_id`. Sessions persisted.
- **L7 (TUI)**: Dialog subagent component (`dialog-subagent.tsx`). Metadata updates (sessionId, model).

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Built-in** | Yes (core feature, `MultiAgentHandler`) | No (extension) | Yes (core `TaskTool`) |
| **Architecture** | In-process thread tree | OS process per agent | Child session per agent |
| **Tool Count** | 5 (spawn, send_input, resume, wait, close) | 1 (subagent, 3 modes) | 1 (task) |
| **Communication** | Interactive messaging (send_input, interrupt) | One-shot (chain uses text substitution) | One-shot with resume |
| **Execution Modes** | Single spawn + interactive | Single, Parallel (8 max, 4 concurrent), Chain | Single (with resume) |
| **Context Isolation** | Separate conversation thread (same process) | Separate OS process | Separate session |
| **Depth Limit** | Numeric (`DEFAULT_AGENT_MAX_DEPTH = 1`, configurable) | None explicit | Implicit via permission (task tool denied) |
| **Built-in Roles** | default, explorer, worker, monitor | N/A (filesystem-discovered) | build, plan, general, explore, compaction, title, summary |
| **Role Definition** | TOML config files (built-in or user-defined) | Markdown with YAML frontmatter | Code + config override |
| **Role Discovery** | `config.agent_roles` map + built-in list | Filesystem (`~/.pi/agent/agents/`, `.pi/agents/`) | Code-defined + `config.agent` section |
| **Permission Isolation** | Auto-approve all (`AskForApproval::Never`) | Process isolation + project agent confirmation | Explicit deny rules (todowrite, todoread, task) |
| **Config Inheritance** | Clone parent, apply role TOML, override approval | Independent process, agent config only | Session permission rules merged |
| **Session Integration** | Thread per agent in `ThreadManager`, resume from rollout | No session (`--no-session`) | Full session per agent, resume via `task_id` |
| **Status Monitoring** | `watch::channel` subscription (real-time) | NDJSON event stream from stdout | None (waits for completion) |
| **Abort Support** | Interrupt via `send_input(interrupt: true)` | SIGTERM/SIGKILL to child process | `SessionPrompt.cancel()` |
| **Event System** | 10 event types (Spawn/Interaction/Wait/Close/Resume begin/end) | `onUpdate` callback with streaming | Metadata updates |
| **Result Format** | JSON in tool output (`SpawnAgentResult`, `WaitResult`, etc.) | Final assistant message text | `<task_result>` wrapped text with `task_id` |
| **Parallel Execution** | LLM decides (spawn multiple + wait) | Built-in parallel mode (`mapWithConcurrencyLimit`) | LLM decides (multiple task calls) |
| **Agent Generation** | No | No | Yes (LLM-generated agent configs) |
| **Concurrency Control** | Wait tool with timeout clamping (10s-3600s) | MAX_PARALLEL_TASKS=8, MAX_CONCURRENCY=4 | N/A |
| **TUI Rendering** | Rich collab events for TUI visualization | `renderCall`/`renderResult` with collapsed/expanded | Dialog subagent component |
| **Complexity** | Very high (5 tools, thread manager, events, roles, resume) | Medium (process management, 3 modes, TUI rendering) | Medium (session management, permission rules, agent types) |

## Synthesis

### Common Patterns

1. **Tool-based delegation**: All three projects implement multi-agent as tool calls. The LLM invokes a tool (spawn_agent/subagent/task) and receives results back through the normal tool output channel.

2. **Context isolation**: All three isolate child agent context from the parent. codex-rs uses separate threads, pi-agent uses separate processes, opencode uses separate sessions. This prevents context window pollution.

3. **Role/agent type system**: All three support different agent specializations. codex-rs: config-based roles (explorer, worker, monitor). pi-agent: filesystem-discovered agents with Markdown definitions. opencode: code-defined agents with config overrides (general, explore).

4. **Read-only exploration agent**: All three define a fast, read-only agent type for codebase exploration (codex-rs: explorer, opencode: explore). This is the most common sub-agent pattern.

5. **Abort/cancel support**: All three provide mechanisms to abort child agents. codex-rs: interrupt + close tools. pi-agent: SIGTERM/SIGKILL. opencode: SessionPrompt.cancel().

6. **Result as text**: All three return child agent results as text to the parent. The parent LLM reads the text output to understand what the child accomplished.

### Key Differences

1. **Interactive vs one-shot**: codex-rs uniquely supports ongoing interactive conversation with child agents (send_input, interrupt). opencode and pi-agent are one-shot (though opencode supports resume). This adds complexity but enables more sophisticated coordination.

2. **Depth control strategy**: codex-rs uses explicit numeric limits (`agent_max_depth`, default 1). opencode uses implicit permission-based control (task tool denied by default). pi-agent has no explicit depth control.

3. **Permission model**: codex-rs auto-approves everything for children (simplest, least secure). opencode selectively denies specific tools (todowrite, todoread, task) while inheriting other permissions. pi-agent relies on process isolation.

4. **Parallel execution**: pi-agent has built-in parallel mode in the tool itself (up to 8 tasks, 4 concurrent). codex-rs and opencode rely on the LLM spawning multiple agents via separate tool calls and waiting/collecting results.

5. **Agent definition location**: pi-agent discovers agents from the filesystem (Markdown files), enabling user-created agents without code changes. codex-rs and opencode define agents in code/config with override support.

6. **Event granularity**: codex-rs emits 10 distinct event types for TUI visualization of multi-agent activity. opencode uses metadata updates. pi-agent uses streaming callbacks.

7. **Resume capability**: codex-rs resumes from rollout (persisted session state). opencode resumes by passing `task_id` to retrieve an existing session. pi-agent does not support resume.

### Best Practices Identified

1. **Single task tool pattern** (opencode): A single `task` tool with `subagent_type` parameter is simpler for the LLM to use than 5 separate tools (codex-rs). The LLM doesn't need to learn spawn/wait/close orchestration.

2. **Permission-based depth control** (opencode): Denying the `task` tool in child permissions is more elegant than numeric depth limits. It's composable with the existing permission system and doesn't require special-case depth tracking.

3. **Selective permission denial** (opencode): Denying specific dangerous operations (todowrite, todoread, task) while inheriting everything else is a balanced approach between codex-rs's auto-approve-all and pi-agent's complete isolation.

4. **Session-based children** (opencode): Using the session system for child agents enables persistence, resume, and visibility in the session list. It's the most natural approach for a TypeScript session-based architecture.

5. **Explorer agent pattern**: All three projects define a read-only exploration agent. This should be a built-in agent type with restricted permissions (read, grep, glob, bash with read-only constraints).

6. **Agent config overrides** (opencode): Allowing users to modify agent properties (model, prompt, permissions, temperature) via config is essential for customization without code changes.

7. **Project agent confirmation** (pi-agent): Prompting before running project-local agents is an important security measure for untrusted repositories.

8. **Chain/previous pattern** (pi-agent): The `{previous}` placeholder for sequential task chaining is a simple but effective pattern for multi-step workflows.

## Open Questions

1. **Single tool vs multi-tool**: Should diligent use a single TaskTool (like opencode) or multiple tools (like codex-rs)? The single tool is simpler for the LLM but doesn't support interactive communication.

2. **Interactive messaging**: Is codex-rs's `send_input`/`wait`/`interrupt` pattern worth the complexity? It enables richer coordination but most workflows are one-shot.

3. **Depth limit strategy**: Numeric limit (codex-rs) or permission-based (opencode)? Permission-based is more composable but less explicit.

4. **Permission isolation**: Auto-approve all (codex-rs), selective denial (opencode), or process isolation (pi-agent)? Selective denial (opencode) seems the best balance.

5. **Agent definition format**: Code-defined (opencode), TOML config (codex-rs), or Markdown with frontmatter (pi-agent)? Code-defined with config overrides (opencode) is the most flexible.

6. **Parallel execution**: Should diligent have built-in parallel mode in the task tool (pi-agent) or rely on the LLM spawning multiple tasks (codex-rs/opencode)?

7. **Resume support at MVP**: Is resuming child sessions essential? opencode's `task_id`-based resume is relatively simple to implement.

8. **Agent generation**: opencode's LLM-generated agent configs are innovative. Should this be a post-MVP feature?

9. **Event system**: How much event infrastructure is needed at MVP? Minimal metadata updates (opencode) or rich collaboration events (codex-rs)?

10. **Connection to D062-D066**: Cycle 1 decisions chose TaskTool pattern (D062), code-defined agents with config override (D063), explicit deny rules (D064), wrapped text with session ID (D065). These align well with opencode's approach. Should any be revised?

11. **Filesystem agent discovery**: pi-agent's pattern of discovering agents from `~/.diligent/agents/*.md` could be a powerful extensibility mechanism. Worth adding beyond the code-defined agents?

12. **Child agent model selection**: Should child agents inherit the parent's model, use a per-agent model override, or default to a cheaper/faster model? All three projects support model overrides per agent type.
