# Layer 9: Multi-Agent

## Key Questions

1. What is the multi-agent architecture? (flat, tree, hub-and-spoke, etc.)
2. How are sub-agents spawned? (API, tool call, process spawn, etc.)
3. How do agents communicate? (shared memory, message passing, etc.)
4. What agent types/roles exist? (explorer, worker, etc.)
5. How are agent roles defined and configured?
6. What are the depth/recursion limits?
7. How does the permission model change for sub-agents?
8. How does multi-agent interact with the session/persistence layer?
9. What is the lifecycle of a sub-agent? (spawn, run, wait, close)
10. How are sub-agent results collected and returned to the parent?

## codex-rs Analysis

### Architecture Overview

codex-rs has the **most sophisticated multi-agent implementation** of the three projects. It implements a full in-process agent hierarchy with explicit lifecycle management through 5 LLM-callable tools. The architecture is a **depth-limited tree** where agents are threads managed by a central `AgentControl` service.

### Agent Spawning Model

Agents are spawned via the `MultiAgentHandler`, which implements `ToolHandler` and routes to 5 sub-tools:

1. **`spawn_agent`** — Creates a new agent thread
   - Args: `message` or `items` (input to the agent), `agent_type` (optional role name)
   - Returns: `{ agent_id: String }` (a ThreadId)
   - Checks depth limit before spawning
   - Applies role config via `apply_role_to_config()`
   - Calls `agent_control.spawn_agent(config, input_items, source)`

2. **`send_input`** — Sends a message to an existing agent
   - Args: `id` (agent ThreadId), `message` or `items`, `interrupt` (bool, default false)
   - Can interrupt a running agent before sending new input
   - Returns: `{ submission_id: String }`

3. **`resume_agent`** — Resumes a previously closed/shutdown agent
   - Args: `id` (agent ThreadId)
   - If agent is NotFound, attempts `resume_agent_from_rollout()` to restore from persisted state
   - Returns: `{ status: AgentStatus }`

4. **`wait`** — Waits for one or more agents to reach a final status
   - Args: `ids` (list of ThreadIds), `timeout_ms` (optional)
   - Subscribes to `watch::channel` for status updates
   - Returns: `{ status: HashMap<ThreadId, AgentStatus>, timed_out: bool }`
   - Timeout clamped: MIN=10s, DEFAULT=30s, MAX=3600s (prevents busy-polling)

5. **`close_agent`** — Shuts down an agent
   - Args: `id` (agent ThreadId)
   - Calls `agent_control.shutdown_agent()`
   - Returns: `{ status: AgentStatus }`

### Depth Limiting

- `DEFAULT_AGENT_MAX_DEPTH = 1` (configurable via `agent_max_depth` in config)
- Depth tracked via `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { depth, ... })`
- `exceeds_thread_spawn_depth_limit()` checks before spawn and resume
- When depth limit would be exceeded at the next level, the `Feature::Collab` is disabled entirely (the multi-agent tools are removed from the tool set)
- Error message: "Agent depth limit reached. Solve the task yourself."

### Agent Roles

Built-in roles defined in `core/src/agent/role.rs`:

| Role | Description | Config |
|---|---|---|
| `default` | Default agent, no config changes | No config file |
| `explorer` | Fast, read-only codebase exploration. Run in parallel. | `explorer.toml` (sets model, reasoning effort) |
| `worker` | Execution and production work (implement features, fix bugs) | No config file |
| `monitor` | Long-running commands (testing, monitoring) with large timeouts | `monitor.toml` |

Roles are applied by loading a TOML config file and merging it as a `ConfigLayerEntry` with `SessionFlags` precedence. User-defined roles in `config.agent_roles` override built-in ones.

### Permission Model for Sub-Agents

- **Auto-approve all**: `approval_policy` is set to `AskForApproval::Never` for all child agents
- This means sub-agents never prompt the user for approval
- The parent agent's config (model, sandbox policy, developer instructions, etc.) is inherited
- When at the depth limit boundary, `Feature::Collab` is disabled so children cannot spawn further agents

### Communication Pattern

- **Message passing** via `agent_control.send_input()` — the parent explicitly sends messages to child agents
- **Status monitoring** via `tokio::sync::watch::channel` — parent subscribes to agent status changes
- **Interrupt support** — parent can interrupt a running child before sending new input
- No shared memory or direct agent-to-agent communication; all coordination goes through the parent

### Session/Persistence Integration

- Each agent is a separate thread (`ThreadId`) managed by `ThreadManager`
- Agents can be resumed from rollout (persisted session state) via `resume_agent_from_rollout()`
- Session source tracks the parent-child relationship: `SubAgentSource::ThreadSpawn { parent_thread_id, depth, agent_nickname, agent_role }`

### Event System

Rich collaboration events for UI tracking:
- `CollabAgentSpawnBegin/End` — spawn lifecycle
- `CollabAgentInteractionBegin/End` — message sending
- `CollabWaitingBegin/End` — wait lifecycle
- `CollabCloseBegin/End` — shutdown lifecycle
- `CollabResumeBegin/End` — resume lifecycle

Each event includes `sender_thread_id`, `receiver_thread_id`, and agent metadata (nickname, role).

### Result Collection

Results are returned inline in tool output as JSON. The `wait` tool returns a status map, and the parent LLM reads agent output from the conversation. There is no explicit "get result" tool; the agent's final output is part of its conversation history.

---

## pi-agent Analysis

### Architecture Overview

pi-agent implements multi-agent as an **extension** (NOT built-in). The `subagent` extension in `examples/extensions/subagent/` demonstrates the pattern. Each sub-agent spawns a **separate OS process** (`pi` CLI), giving complete context isolation. This is the simplest but most heavyweight approach.

### Agent Spawning Model

The extension registers a `subagent` tool via `pi.registerTool()`. It supports three modes:

1. **Single mode**: `{ agent: "name", task: "..." }` — one agent, one task
2. **Parallel mode**: `{ tasks: [{ agent: "name", task: "..." }, ...] }` — up to 8 tasks, max 4 concurrent
3. **Chain mode**: `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }` — sequential execution with `{previous}` placeholder for prior output

Each invocation spawns a new `pi` CLI process:
```
pi --mode json -p --no-session [--model <model>] [--tools <tools>] "Task: <task>"
```

### Agent Discovery

Agents are discovered from the filesystem:
- **User agents**: `~/.pi/agent/agents/*.md`
- **Project agents**: `.pi/agents/*.md` (nearest ancestor directory)
- Scope controlled by `agentScope` parameter: `"user"` (default), `"project"`, or `"both"`

Agent config is defined in Markdown files with YAML frontmatter:
```yaml
---
name: agent-name
description: What this agent does
tools: tool1,tool2,tool3
model: model-name
---
System prompt content here...
```

### Communication Pattern

- **Process-isolated**: Each sub-agent is a completely separate `pi` process
- **No inter-agent communication**: Agents cannot talk to each other
- **One-shot**: Each agent runs to completion; no interactive message passing
- **Chain mode** enables sequential data flow via `{previous}` text substitution
- Output captured via NDJSON events from `stdout` (`--mode json`)

### Permission Model

- **Project agent confirmation**: When using project-local agents (`agentScope: "both"` or `"project"`), the user is prompted to confirm before running (security measure for untrusted repos)
- No explicit permission restrictions on sub-agents beyond what's in the agent config (`tools` field)
- Each process inherits the parent's environment

### Depth Limiting

- **No explicit depth limit**: The extension does not prevent recursive agent spawning
- However, since each agent is a separate process with `--no-session`, there is no automatic nesting — an agent would need to explicitly invoke the subagent tool again

### Result Collection

- NDJSON event stream parsed from stdout
- Events: `message_end` (captures messages and usage), `tool_result_end` (captures tool results)
- Final output extracted from the last assistant message
- Usage tracking: input/output tokens, cache read/write, cost, context tokens, turns
- Rich TUI rendering with `renderCall` and `renderResult` for collapsed/expanded views

### Concurrency Control

- Parallel mode: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`
- `mapWithConcurrencyLimit()` utility controls parallel execution
- Streaming updates: `onUpdate` callback provides real-time progress for each task

### Error Handling

- Non-zero exit codes, `stopReason === "error"`, or `stopReason === "aborted"` treated as failures
- Chain mode stops on first error
- Abort signal support: parent can kill sub-agent processes via SIGTERM (with SIGKILL fallback after 5s)
- Temp files for system prompts cleaned up in `finally` block

---

## opencode Analysis

### Architecture Overview

opencode implements multi-agent through a **TaskTool** that creates child sessions. It has a well-defined **agent type system** with per-agent permissions, prompts, and model configurations. The architecture is a **session-based tree** where each sub-agent runs in its own session linked to the parent.

### Agent Spawning Model

The `TaskTool` (`src/tool/task.ts`) is a single tool that delegates to different agent types:
- Args: `description` (short summary), `prompt` (the task), `subagent_type` (agent name), `task_id` (optional, for resuming)
- Creates a child session via `Session.create({ parentID: ctx.sessionID })`
- Uses `SessionPrompt.prompt()` to run the agent
- Returns result wrapped in `<task_result>` tags plus `task_id` for potential resumption

### Agent Types and Roles

Defined in `src/agent/agent.ts` via `Agent.Info` schema. Built-in agents:

| Agent | Mode | Description | Key Permissions |
|---|---|---|---|
| `build` | primary | Default agent, executes tools per permissions | Full access, question/plan_enter allowed |
| `plan` | primary | Plan mode, disallows edit tools | Edits denied except plan files |
| `general` | subagent | General-purpose for research and multi-step tasks | todoread/todowrite denied |
| `explore` | subagent | Fast codebase exploration | Only read-only tools (grep, glob, list, bash, read, webfetch, websearch, codesearch) |
| `compaction` | hidden | Context compaction | All tools denied |
| `title` | hidden | Title generation | All tools denied, temperature 0.5 |
| `summary` | hidden | Summary generation | All tools denied |

Agent modes: `"subagent"` (callable by task tool), `"primary"` (top-level agents), `"all"` (both).

### Agent Configuration

Agents are highly configurable:
- Per-agent `permission` rulesets (merged with defaults and user config via `PermissionNext.merge()`)
- Optional `model` override (providerID + modelID)
- Optional `prompt` (system prompt text)
- Optional `steps` (max number of steps)
- Optional `temperature`, `topP`
- Optional `variant`, `color`, `hidden`
- Config-driven: users can override, disable, or add agents via config `agent` section

### Permission Model for Sub-Agents

- Sub-agent sessions created with explicit permission overrides:
  - `todowrite` and `todoread` always denied (prevents sub-agents from modifying task lists)
  - `task` tool denied unless the agent's own permissions include task permission (prevents infinite nesting by default)
  - Primary tools (`config.experimental?.primary_tools`) allowed
- Permission check: `ctx.ask({ permission: "task", patterns: [params.subagent_type] })` — the parent's permission system controls which agent types can be invoked
- User-invoked tasks (via `@` or command) bypass the agent permission check

### Depth Limiting

- **Implicit via permission**: Sub-agents have `task` tool denied unless explicitly permitted in their permission ruleset
- No explicit numeric depth limit like codex-rs
- The `hasTaskPermission` check determines whether the child session includes the task tool

### Communication Pattern

- **Session-based**: Each sub-agent is a child session with `parentID` linking to the parent
- **One-shot with resume**: Agent runs to completion; parent can resume by passing `task_id`
- **No interactive messaging**: Unlike codex-rs, there is no `send_input` equivalent
- Result returned as text in `<task_result>` tags

### Session/Persistence Integration

- Sub-agent sessions are full `Session` objects persisted in the session store
- Resume support: if `task_id` is provided, `Session.get(task_id)` retrieves the existing session
- Session title includes the description and agent name: `description + " (@agent_name subagent)"`

### Result Collection

- Final result: the last text part from the prompt result
- Output format:
  ```
  task_id: <session_id> (for resuming to continue this task if needed)

  <task_result>
  <final text output>
  </task_result>
  ```
- Metadata includes sessionId and model information
- Abort support: `SessionPrompt.cancel(session.id)` triggered on abort signal

### Agent Generation

opencode has a unique feature: `Agent.generate()` can create new agent configurations from a text description using an LLM. It generates an identifier, whenToUse description, and system prompt.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Built-in** | Yes (core feature) | No (extension) | Yes (core tool) |
| **Architecture** | In-process thread tree | OS process per agent | Child session per agent |
| **Spawning** | `spawn_agent` tool → ThreadManager | `spawn("pi", ...)` child process | `Session.create({ parentID })` |
| **Agent Tools** | 5 (spawn, send_input, resume, wait, close) | 1 (subagent, 3 modes) | 1 (task) |
| **Communication** | Interactive message passing (send_input, interrupt) | One-shot only (chain uses text substitution) | One-shot with resume |
| **Execution Modes** | Single spawn + interactive | Single, Parallel (max 8, 4 concurrent), Chain | Single (with resume) |
| **Depth Limit** | Numeric (DEFAULT=1, configurable) | None explicit | Implicit via permission (task tool denied by default) |
| **Built-in Roles** | default, explorer, worker, monitor | N/A (filesystem-discovered) | build, plan, general, explore, compaction, title, summary |
| **Role Definition** | TOML config files (built-in or user-defined) | Markdown files with YAML frontmatter | Code + config override |
| **Role Discovery** | Config `agent_roles` map + built-in list | Filesystem (~/.pi/agent/agents/, .pi/agents/) | Code-defined + config `agent` section |
| **Permission Isolation** | Auto-approve (AskForApproval::Never) | Process isolation (no explicit restriction) | Explicit deny rules (todowrite, todoread, task) |
| **Session Integration** | Thread per agent, resume from rollout | No session (--no-session flag) | Full session per agent, resume via task_id |
| **Status Monitoring** | watch::channel subscription (real-time) | NDJSON event stream from stdout | None (waits for completion) |
| **Abort Support** | Via interrupt (send_input with interrupt: true) | SIGTERM/SIGKILL to child process | SessionPrompt.cancel() |
| **Event System** | Rich Collab* events (Spawn, Interaction, Wait, Close, Resume) | onUpdate callback with streaming | Metadata updates |
| **Result Format** | JSON in tool output + conversation history | Final assistant message text | `<task_result>` wrapped text |
| **Agent Generation** | No | No | Yes (LLM-generated agent configs) |
| **Concurrency** | LLM decides (spawn multiple + wait) | Built-in parallel mode (mapWithConcurrencyLimit) | LLM decides (multiple task tool calls) |
| **Context Isolation** | Separate conversation thread | Separate OS process | Separate session |
| **Complexity** | Very high (5 tools, events, watch channels, roles) | Medium (process management, 3 modes, TUI rendering) | Medium (session management, permission rules) |

## Open Questions

1. **Architecture choice**: codex-rs uses in-process threads (fast, interactive), pi-agent uses OS processes (simple, fully isolated), opencode uses child sessions (balanced). Which model fits a TypeScript/Bun agent best? Child sessions (like opencode) seem most natural.

2. **Interactive vs one-shot**: codex-rs allows ongoing conversation with sub-agents (send_input, interrupt). opencode and pi-agent are one-shot (with resume). Is interactive communication worth the complexity?

3. **Depth limit strategy**: codex-rs uses a numeric config limit (default 1). opencode implicitly limits via permission (task tool denied). pi-agent has no limit. Which approach is simpler and safer?

4. **Role/agent type definition**: codex-rs uses TOML config files, pi-agent uses Markdown with frontmatter, opencode uses code + config override. How should diligent define agent types?

5. **Parallel execution**: pi-agent has built-in parallel mode in the tool itself (up to 8 tasks, 4 concurrent). codex-rs and opencode rely on the LLM spawning multiple agents and waiting. Should diligent have a built-in parallel mode or let the LLM handle it?

6. **Permission isolation**: codex-rs auto-approves everything for children. opencode selectively denies specific tools. pi-agent isolates via separate processes. What level of isolation is appropriate?

7. **Resume support**: Both codex-rs (resume_agent from rollout) and opencode (task_id for session resumption) support resuming sub-agents. Is this essential at MVP?

8. **Agent discovery**: pi-agent discovers agents from the filesystem (Markdown files). codex-rs and opencode define them in code/config. Should diligent support filesystem-based agent discovery?

9. **Connection to D014/D055**: D014 decided on a Map-based tool registry and D055 deferred extension/plugin scope. The multi-agent tool(s) need to be registered in this registry. Should it be a single "task" tool (like opencode) or multiple tools (like codex-rs)?

10. **Agent generation**: opencode can LLM-generate new agent configurations from natural language descriptions. This is a unique feature. Should diligent support this?

11. **Event/status system**: codex-rs has the richest collaboration event system (10 event types). This enables detailed TUI visualization of agent activity. How much status/event infrastructure is needed at MVP?

12. **Connection to L6 (TUI)**: All three projects have different TUI representations for sub-agent activity. pi-agent has the most detailed rendering (renderCall/renderResult with expanded/collapsed views). How should multi-agent activity be displayed?
