# Layer 1: Tool System

## Key Questions

1. How are tools defined (type/interface)?
2. How are tools registered/discovered?
3. How does the agent loop invoke tools?
4. How are tool results returned to the LLM?
5. What is the tool call lifecycle?
6. How are parallel vs sequential tool calls handled?
7. What are the key abstractions?
8. How does it interface with the REPL loop (L0)?

## codex-rs Analysis

**Tool Definition:**
- `ToolSpec` enum with variants: `Function(ResponsesApiTool)`, `LocalShell`, `WebSearch`, `Freeform(FreeformTool)`
- `ResponsesApiTool`: name, description, strict, parameters (JsonSchema)
- Rust-native JsonSchema subset (Boolean, String, Number, Array, Object)

**Registry:**
- `ToolRegistry` stores `HashMap<String, Arc<dyn ToolHandler>>`
- `ToolRegistryBuilder` (builder pattern): `push_spec()`, `register_handler()`, `build()`
- `build_specs()` factory creates all tools conditionally based on feature flags
- Single registry holds built-in + MCP + dynamic tools

**Invocation Flow:**
1. `ToolRouter::build_tool_call()` converts LLM `ResponseItem` → `ToolCall`
2. `ToolRouter::dispatch_tool_call()` dispatches with session, turn context
3. `ToolRegistry` looks up handler by name, validates payload kind
4. Checks if tool is mutating → gates execution
5. Handler executes and returns `ToolOutput`

**Results to LLM:**
- `ToolOutput` enum: `Function { body, success }` or `Mcp { result }`
- Converted to `ResponseInputItem` (FunctionCallOutput / CustomToolCallOutput / McpToolCallOutput)
- Output formatting: structured JSON (exit_code, duration) or freeform text
- Truncation policies applied (max bytes/lines)

**Lifecycle:**
- Implicit through async: Pending → Approval → Sandbox selection → Running → Complete/Error
- `FunctionCallError` variants: `RespondToModel`, `Fatal`, `MissingLocalShellCallId`
- `Orchestrator::run()` pipeline: Approval → Sandbox Escalation → Network Approval

**Parallel vs Sequential:**
- `ToolCallRuntime` uses `RwLock`: read lock for parallel-capable, write lock for sequential-only
- Per-tool `supports_parallel` flag in `ConfiguredToolSpec`
- Parallel: shell, grep, read_file, list_dir; Sequential: apply_patch, spawn_agent, plan
- `CancellationToken` + `AbortOnDropHandle` for cleanup

**Key Abstractions:**
- `ToolHandler` trait: `kind()`, `is_mutating()`, `handle()` — core dispatch interface
- `ToolRuntime<Rq, Out>` trait: `run()`, `exec_approval_requirement()`, `start_approval_async()`, `network_approval_spec()` — lifecycle hooks for complex tools
- `ToolInvocation`: carries session, turn, call_id, tool_name, payload
- `ToolPayload` enum: Function, Custom, LocalShell, Mcp
- `Orchestrator`: central approval/sandbox/network pipeline

**Interface with L0:**
- After LLM response, `build_tool_call()` converts each tool call
- `ToolCallRuntime::handle_tool_call()` returns `ResponseInputItem`
- Results feed back into next LLM turn as history
- Tools emit events via session's event channel

## pi-agent Analysis

**Tool Definition:**
- Base `Tool<TParameters>`: name, description, parameters (TypeBox schema)
- `AgentTool<TParameters, TDetails>` extends with: label, `execute(toolCallId, params, signal?, onUpdate?)`
- `AgentToolResult<T>`: content (TextContent | ImageContent)[], details
- `onUpdate` callback for streaming partial results during execution

**Registry:**
- No explicit registry — tools passed as array to `AgentContext.tools`
- `Agent.setTools(t)` updates state directly
- Tool collections exported from `coding-agent/src/core/tools/index.ts`
- `createCodingTools(cwd, options)` factory for custom working directories

**Invocation Flow:**
1. `agentLoop()` streams assistant response
2. Filters `toolCall` content from response
3. `executeToolCalls()` iterates sequentially
4. Looks up tool by name in array
5. `validateToolArguments()` with AJV against TypeBox schema
6. `tool.execute(id, args, signal, onUpdate)` called
7. Result wrapped in `ToolResultMessage`

**Results to LLM:**
- `ToolResultMessage`: role="toolResult", toolCallId, toolName, content[], details, isError
- Added to `currentContext.messages` for next LLM turn
- Content is TextContent or ImageContent blocks

**Lifecycle:**
- Events: `tool_execution_start` → `tool_execution_update` (streaming) → `tool_execution_end`
- `AgentState.pendingToolCalls` Set tracks active tool IDs
- isError flag on result distinguishes success/failure

**Parallel vs Sequential:**
- **Sequential only** — simple for loop over tool calls
- Between each tool, checks `getSteeringMessages()` for user interruption
- If steering messages arrive, remaining tools are skipped with placeholder results

**Key Abstractions:**
- `Tool<TParameters>` (base, in ai package)
- `AgentTool<TParameters, TDetails>` (extended, in agent package)
- `AgentToolResult<T>` (output)
- `ToolCall` (LLM-generated invocation)
- `ToolResultMessage` (result for context)
- `EventStream<AgentEvent, AgentMessage[]>` (async event queue)

**Interface with L0:**
- `agentLoop()` is the main entry: streams LLM → executes tools → feeds back results
- Inner while loop continues until no more tool calls AND no steering messages
- Outer while loop handles follow-up messages after completion

## opencode Analysis

**Tool Definition:**
- `Tool.Info<Parameters, Metadata>`: id, `init()` async function
- `init()` returns: description, parameters (Zod schema), `execute(args, ctx)`, optional `formatValidationError()`
- **Lazy initialization** — expensive setup deferred until first use
- Execute returns: title, metadata, output (string), optional attachments (FilePart[])
- `Tool.Context`: sessionID, messageID, agent, abort signal, `metadata()` for streaming, `ask()` for permissions

**Registry:**
- `ToolRegistry` with filesystem discovery: scans `{tool,tools}/*.{js,ts}` in config directories
- Plugin system: `Plugin.list()` loads tools from registered plugins
- `register()` for runtime addition/replacement
- `tools(model, agent)` filters tools based on model/provider capabilities
- Model-based filtering (e.g., apply_patch only for certain GPT models)

**Invocation Flow:**
1. `ToolRegistry.tools()` fetches and initializes tools
2. Converted to AI SDK format via `tool()` wrapper
3. Schema transformed for provider compatibility via `ProviderTransform.schema()`
4. Passed to `streamText()` from `ai` library
5. Stream events processed by `SessionProcessor`: tool-call → tool-result → tool-error
6. Plugin hooks: `tool.execute.before`, `tool.execute.after`

**Results to LLM:**
- Output: string (main result), title (display), metadata (tool-specific), attachments
- Truncated via `Truncate.output()` if exceeds limits
- Stored as `MessageV2.ToolPart` in session history
- State tracked: `ToolStateCompleted { output, title, metadata, time, attachments }`

**Lifecycle:**
- Explicit state machine: `pending` → `running` → `completed` | `error`
- Each state is a Zod-validated object with specific fields
- `running` state supports metadata updates mid-execution
- Permission denial handled as special error case

**Parallel vs Sequential:**
- LLM can generate multiple tool calls in single response (processed independently)
- `batch` tool enables explicit parallel execution (up to 25 tools via Promise.all)
- Sequential within agent loop: result feeds into next LLM turn

**Key Abstractions:**
- `Tool.Info`: definition with lazy init
- `Tool.Context`: runtime context with abort, permissions, metadata streaming
- `MessageV2.ToolPart`: persisted tool call with state machine
- `MessageV2.ToolState`: union of Pending/Running/Completed/Error
- `ToolRegistry`: discovery + filtering + initialization

**Interface with L0:**
- `SessionPrompt.prompt()` creates tool definitions, calls LLM, processes results
- Loop continues until finish event or max steps
- Results stored in SQLite via session messages
- Event bus publishes state changes for reactive UI updates

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Language** | Rust | TypeScript | TypeScript (Bun) |
| **Tool Definition** | ToolSpec enum + ToolHandler trait | AgentTool interface with execute() | Tool.Info with lazy init() |
| **Schema System** | Custom JsonSchema subset | TypeBox (@sinclair/typebox) | Zod |
| **Registry** | HashMap + builder pattern | Array (no registry) | Filesystem + plugin discovery |
| **Invocation** | Router → Registry → Handler | Direct array lookup → execute() | AI SDK tool() wrapper → execute |
| **Result Format** | ToolOutput → ResponseInputItem | AgentToolResult → ToolResultMessage | {output, title, metadata, attachments} |
| **Lifecycle States** | Implicit (async flow) | 3 events (start/update/end) | 4 explicit states (pending/running/completed/error) |
| **Parallel Execution** | RwLock per-tool parallelism flag | Sequential only (with steering) | Batch tool (Promise.all, up to 25) |
| **Approval Integration** | Orchestrator pipeline (approval → sandbox → network) | None (handled externally) | ctx.ask() inline permission requests |
| **Streaming Results** | Output deltas via events | onUpdate callback | ctx.metadata() updates |
| **Complexity** | High (orchestrator, sandbox, network) | Low (direct execute) | Medium (registry, permissions, batch) |

## Open Questions

1. **Schema system**: TypeBox vs Zod vs custom? Zod is most popular in TS ecosystem, TypeBox has better JSON Schema alignment. Custom subset like codex-rs is maximum control but more work.

2. **Registry complexity**: pi-agent's "no registry" (just an array) is simplest. opencode's filesystem discovery is most extensible. What level of dynamism is needed?

3. **Parallel execution strategy**: codex-rs's RwLock approach is most sophisticated (per-tool parallelism). pi-agent's sequential-with-steering is simplest. opencode's batch tool is a middle ground. Which fits our needs?

4. **Approval integration point**: Should approval be in the tool system (codex-rs orchestrator), in the tool context (opencode ctx.ask()), or external (pi-agent)? This heavily affects L3 design.

5. **Lazy initialization**: opencode's `init()` pattern defers tool setup. Worth adopting for tools with expensive setup (e.g., MCP connections)?

6. **Tool result format**: String-only (simple, LLM-native) vs structured (richer for UI)? opencode returns string output + separate metadata. pi-agent returns content blocks (text + image).

7. **Streaming during execution**: All three support it differently. codex-rs emits event deltas, pi-agent uses onUpdate callback, opencode uses ctx.metadata(). What's the cleanest pattern for our Op/Event model?
