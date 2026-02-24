# Layer 2: Tool System

## Problem Definition

The Tool System layer provides the **framework** for defining, registering, invoking, and managing tools within a coding agent. It sits between the Agent Loop (L1), which dispatches tool calls, and the Core Tools (L3) / external tools (MCP, plugins), which provide concrete implementations. The tool system must:

1. Define a uniform interface that all tools implement
2. Register tools and make them discoverable by the Agent Loop
3. Validate tool arguments against schemas before execution
4. Invoke tools and convert results back to LLM-consumable format
5. Handle execution progress/streaming for long-running tools
6. Truncate large outputs to fit context windows
7. Support parallel vs sequential execution policies
8. Provide a context object carrying session state, cancellation, and permission hooks

### Key Questions

1. How are tools defined (type/interface)?
2. How are tools registered and discovered?
3. How does the agent loop invoke tools?
4. How are tool results formatted and returned to the LLM?
5. How is schema validation performed?
6. How are parallel vs sequential tool calls managed?
7. How does the tool context carry session state and permission hooks?
8. How is output truncated for large results?
9. How are tool execution events emitted for UI consumption?

### Layer Scope

- Tool definition interface (name, description, parameters, execute function)
- Schema system (definition, validation, JSON Schema export)
- Tool registry (registration, lookup, filtering)
- Tool invocation pipeline (validation -> execution -> result formatting)
- Tool context (session state, abort signal, permission hook, metadata streaming)
- Output truncation framework
- Parallel/sequential execution policy
- Tool lifecycle events

### Boundary: What Is NOT in This Layer

- Concrete tool implementations (L3: Core Tools)
- Permission evaluation logic (L4: Approval)
- MCP tool conversion (L9: MCP)
- UI rendering of tool execution (L7: TUI)

---

## codex-rs Analysis

### Architecture

codex-rs implements the tool system across multiple files in `core/src/tools/`:

```
tools/
  spec.rs           - ToolSpec enum, ToolsConfig, build_specs() factory, JsonSchema subset
  registry.rs       - ToolHandler trait, ToolRegistry (HashMap), ToolRegistryBuilder
  router.rs         - ToolRouter (specs + registry), ToolCall, dispatch pipeline
  context.rs        - ToolInvocation, ToolPayload, ToolOutput
  parallel.rs       - ToolCallRuntime with RwLock for parallel/sequential
  events.rs         - ToolEmitter, ToolEventCtx, event emission helpers
  orchestrator.rs   - Approval + sandbox pipeline (L4 territory)
  sandboxing.rs     - Sandbox policy enforcement
  handlers/         - One file per tool handler
  runtimes/         - Complex tool runtimes (shell, apply_patch, unified_exec)
```

The architecture separates **specification** (what the LLM sees), **registration** (how tools are found), **routing** (how calls are dispatched), and **execution** (how tools run). This is the most layered approach of the three projects.

### Key Types/Interfaces

**Tool Definition -- Two-Level System:**

Wire-level specifications are distinct from implementation handlers:

```rust
// Wire type sent to the LLM (spec.rs):
pub enum ToolSpec {
    Function(ResponsesApiTool),     // name, description, strict, parameters: JsonSchema
    LocalShell {},                   // Built-in shell
    WebSearch { external_web_access? },
    Freeform(FreeformTool),         // name, description, format (Lark grammar)
}

// Wrapper with parallel support flag:
pub struct ConfiguredToolSpec {
    pub spec: ToolSpec,
    pub supports_parallel_tool_calls: bool,
}
```

The handler trait defines the implementation contract:

```rust
#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn kind(&self) -> ToolKind;  // Function | Mcp
    fn matches_kind(&self, payload: &ToolPayload) -> bool;
    async fn is_mutating(&self, _invocation: &ToolInvocation) -> bool;
    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError>;
}
```

Key aspects: `is_mutating()` determines write-lock vs read-lock for parallel execution. `matches_kind()` validates payload type against handler type.

**Tool Context -- ToolInvocation:**

```rust
pub struct ToolInvocation {
    pub session: Arc<Session>,
    pub turn: Arc<TurnContext>,
    pub tracker: SharedTurnDiffTracker,
    pub call_id: String,
    pub tool_name: String,
    pub payload: ToolPayload,  // Function{args} | Custom{input} | LocalShell{params} | Mcp{server,tool,args}
}
```

The invocation carries the full session and turn context, enabling tools to access configuration, emit events, and interact with the session state.

**Tool Output:**

```rust
pub enum ToolOutput {
    Function { body: FunctionCallOutputBody, success: Option<bool> },
    Mcp { result: Result<CallToolResult, String> },
}
```

Output is converted to `ResponseInputItem` via `into_response(call_id, payload)`, adapting the wire format based on the payload type (Function -> FunctionCallOutput, Custom -> CustomToolCallOutput, Mcp -> McpToolCallOutput).

### Implementation Details

**Registry**: `ToolRegistry` wraps `HashMap<String, Arc<dyn ToolHandler>>`. Built via `ToolRegistryBuilder` which accumulates handlers and specs, then produces both in `build()`. The `build_specs()` factory function in `spec.rs` (~600 lines) conditionally registers tools based on feature flags, model capabilities, and configuration.

**Schema System**: Custom `JsonSchema` subset supporting Boolean, String, Number, Array, Object with properties/required/additionalProperties. NOT full JSON Schema. Compatible with MCP schemas. A `strict: bool` flag controls validation mode.

**Dispatch Pipeline** (in `ToolRegistry::dispatch()`):
1. Lookup handler by name in HashMap (O(1))
2. Validate payload kind matches handler kind
3. Check `is_mutating()` -- if true, wait for `tool_call_gate.wait_ready()` (approval gate)
4. Execute `handler.handle(invocation)` async
5. Dispatch `AfterToolUse` hook (can abort the result)
6. Convert `ToolOutput` to `ResponseInputItem`
7. Emit telemetry and metrics

**Parallel Execution** (`ToolCallRuntime`):
```rust
pub(crate) struct ToolCallRuntime {
    parallel_execution: Arc<RwLock<()>>,
    // ... router, session, turn context
}
```

Per-tool flag `supports_parallel_tool_calls`. Parallel tools acquire `.read()` lock (concurrent). Sequential tools acquire `.write()` lock (exclusive). Each tool call is spawned as a separate tokio task with cancellation support via `CancellationToken`. Cancelled tools produce an "aborted by user" response (not silently dropped).

**Event Emission**: `ToolEmitter` enum with variants for Shell, ApplyPatch, and UnifiedExec. Emits `ExecCommandBegin/End`, `PatchApplyBegin/End` events through the session's event channel. Events include timing, exit codes, parsed commands, and formatted output.

**Telemetry**: Output preview capped at 2KiB + 64 lines for logging. Full output is available in the tool result but not telemetry.

### Layer Boundaries

- **Above (L1)**: Agent Loop receives `ResponseItem` from provider stream, calls `ToolRouter::build_tool_call()` to parse it, then `ToolCallRuntime::handle_tool_call()` to execute. Results are `ResponseInputItem` pushed back to conversation.
- **Below (L3)**: Each tool implements `ToolHandler` trait. The registry holds `Arc<dyn ToolHandler>` -- concrete types are unknown to the framework.
- **Lateral (L4)**: Approval is handled by `ToolOrchestrator` which wraps the execution pipeline with approval -> sandbox -> network gates. The `tool_call_gate` in `TurnContext` is the integration point.

---

## pi-agent Analysis

### Architecture

pi-agent has the simplest tool system of the three projects. There is NO formal registry -- tools are passed as an array to the agent context. The tool system spans two packages:

```
packages/ai/src/
  types.ts          - Tool interface (LLM-facing: name, description, parameters)

packages/agent/src/
  types.ts          - AgentTool interface (extends Tool with execute function)
  agent-loop.ts     - executeToolCalls() function (tool invocation logic)

packages/coding-agent/src/core/tools/
  index.ts          - Tool collections (codingTools, readOnlyTools, allTools)
  truncate.ts       - Shared truncation utilities
  [tool].ts         - One file per tool (bash, read, edit, write, grep, find, ls)
```

### Key Types/Interfaces

**Tool Definition -- Two-Level Hierarchy:**

```typescript
// Base (LLM-facing, in ai package):
interface Tool<TParameters extends TSchema = TSchema> {
    name: string;
    description: string;
    parameters: TParameters;  // TypeBox schema
}

// Extended (executable, in agent package):
interface AgentTool<TParameters extends TSchema, TDetails = any> extends Tool<TParameters> {
    label: string;
    execute: (
        toolCallId: string,
        params: Static<TParameters>,   // TypeBox inferred type
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<TDetails>,
    ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];  // To LLM
    details: T;                                // To UI
}
```

The two-level split (`Tool` for LLM, `AgentTool` for agent) cleanly separates wire concerns from execution concerns. The `TDetails` generic enables typed UI metadata per tool.

**Tool Context**: There is NO explicit context object. Tools receive:
- `toolCallId: string` -- for correlation
- `params: Static<TParameters>` -- validated arguments
- `signal?: AbortSignal` -- for cancellation
- `onUpdate?: AgentToolUpdateCallback<TDetails>` -- for streaming progress

This minimalist approach means tools have no access to session state, message history, or permission hooks. All session-level concerns are handled externally.

**Tool Result:**

```typescript
interface ToolResultMessage<TDetails = any> {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    details?: TDetails;
    isError: boolean;
    timestamp: number;
}
```

The `isError` flag differentiates successful results from errors. Error content is sent to the LLM for self-correction.

### Implementation Details

**Registration**: No registry at all. Tools are organized as arrays:
```typescript
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];
```

Factory functions create tools with a custom cwd:
```typescript
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[]
```

**Schema System**: TypeBox (`@sinclair/typebox`) for schema definition, AJV for runtime validation. TypeBox provides excellent TypeScript type inference (`Static<TParameters>`) and compiles to standard JSON Schema.

**Validation**: `validateToolArguments(tool, toolCall)` uses AJV with type coercion. Errors are formatted with JSON paths for clear error messages.

**Invocation Pipeline** (in `executeToolCalls()`):
1. For each tool call sequentially:
2. Emit `tool_execution_start` event
3. Find tool by name in array (O(n))
4. Validate arguments via AJV
5. Execute `tool.execute(toolCallId, validatedArgs, signal, onUpdate)`
6. Catch errors -> set `isError: true`
7. Emit `tool_execution_end` event
8. Create `ToolResultMessage`
9. Check steering messages -> skip remaining if user interrupted

**Parallel Execution**: **Sequential only.** Simple for-loop over tool calls. Between each tool, checks `getSteeringMessages()` for user interruptions. If steering messages found, remaining tools are skipped with placeholder "Skipped due to queued user message" results.

**Event Emission**: Three event types emitted via `EventStream<AgentEvent>`:
```typescript
type AgentEvent =
    | { type: "tool_execution_start"; toolCallId; toolName; args }
    | { type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
    | { type: "tool_execution_end"; toolCallId; toolName; result; isError };
```

The `tool_execution_update` events are generated by the `onUpdate` callback passed to each tool.

**Truncation**: Shared utilities in `truncate.ts`:
```typescript
truncateHead(text, { maxLines: 2000, maxBytes: 50KB })  // For file reads
truncateTail(text, { maxLines: 2000, maxBytes: 50KB })   // For bash output
```
Returns rich metadata: `TruncationResult` with `truncated`, `truncatedBy`, `totalLines`, `totalBytes`, etc. Individual tools call truncation explicitly; there is no automatic framework-level truncation.

**Pluggable Operations**: Each tool defines an `Operations` interface for its I/O:
```typescript
interface BashOperations { exec: (command, cwd, options) => Promise<{ exitCode }> }
interface ReadOperations { readFile: (path) => Promise<Buffer>; access: (path) => Promise<void> }
interface EditOperations { readFile, writeFile, access }
```
Default implementations use local filesystem. This pattern enables SSH/remote execution without changing tool logic.

### Layer Boundaries

- **Above (L1)**: Agent loop calls `executeToolCalls()` with the tools array and parsed tool calls from the LLM response.
- **Below (L3)**: Tools are plain objects conforming to `AgentTool` interface. No trait/class hierarchy.
- **Lateral (L4)**: No approval integration at tool system level. Approval would need to be added externally.

---

## opencode Analysis

### Architecture

opencode has the most sophisticated tool system, built around a lazy-initialization pattern and Zod schemas:

```
packages/opencode/src/tool/
  tool.ts           - Tool.define(), Tool.Info, Tool.Context namespace
  registry.ts       - ToolRegistry (filesystem discovery + plugins + built-in list)
  truncation.ts     - Truncate.output() with file persistence
  [tool].ts         - One file per tool
```

The tool system integrates with the AI SDK, which manages tool execution during streaming.

### Key Types/Interfaces

**Tool Definition -- Lazy Init Pattern:**

```typescript
interface Tool.Info<Parameters extends z.ZodType, M extends Metadata> {
    id: string;
    init: (ctx?: InitContext) => Promise<{
        description: string;
        parameters: Parameters;    // Zod schema
        execute(args: z.infer<Parameters>, ctx: Tool.Context): Promise<{
            title: string;
            metadata: M;
            output: string;
            attachments?: FilePart[];
        }>;
        formatValidationError?(error: z.ZodError): string;
    }>;
}
```

The `init()` function is called once to produce the tool's description, schema, and execute function. This enables tools to perform async setup (e.g., detecting available shells, initializing tree-sitter). The `Tool.define()` helper wraps `init` with automatic argument validation and output truncation.

**Tool Context:**

```typescript
type Tool.Context<M extends Metadata = Metadata> = {
    sessionID: string;
    messageID: string;
    agent: string;
    abort: AbortSignal;
    callID?: string;
    extra?: Record<string, any>;
    messages: MessageV2.WithParts[];
    metadata(input: { title?: string; metadata?: M }): void;  // Streaming UI updates
    ask(input: PermissionRequest): Promise<void>;              // Permission check
}
```

The context is the richest of all three projects. It includes:
- `messages` -- full message history (for tools that need conversation context)
- `metadata()` -- real-time streaming of progress updates to the UI
- `ask()` -- inline permission checks (throws `RejectedError` if denied)
- `abort` -- cancellation signal

**Tool Result:**

```typescript
{ title: string; metadata: M; output: string; attachments?: FilePart[] }
```

Output is a plain string. Metadata is typed per-tool. Attachments support images/files as base64.

### Implementation Details

**Registry** (`ToolRegistry`):
1. **Built-in tools**: Hard-coded array in `all()` function
2. **Custom tools**: Filesystem scan of `{tool,tools}/*.{js,ts}` in config directories
3. **Plugin tools**: Via `Plugin.list()` -> `plugin.tool` entries
4. **Runtime registration**: `register(tool)` adds to custom list
5. **Filtering**: `tools(model, agent)` filters by provider (e.g., apply_patch for GPT, edit/write for Claude)

The registry is lazy-initialized via `Instance.state()`. Tools are initialized (calling `init()`) when `tools()` is called, not at registration time.

**Schema System**: Zod schemas with `z.toJSONSchema()` for JSON Schema export. Provider-specific schema transforms in `ProviderTransform.schema()` sanitize schemas per provider. Validation happens inside `Tool.define()` via `toolInfo.parameters.parse(args)`.

**Auto-Truncation** (in `Tool.define()`):
```typescript
toolInfo.execute = async (args, ctx) => {
    const result = await execute(args, ctx);
    if (result.metadata.truncated !== undefined) return result;  // Tool handles own truncation
    const truncated = await Truncate.output(result.output);
    return { ...result, output: truncated.content, metadata: { ...result.metadata, truncated: truncated.truncated } };
};
```

Framework-level truncation is applied automatically unless the tool opts out by setting `metadata.truncated`. Truncated output is saved to disk with a hint message pointing to the full file.

**Truncation Details** (`Truncate.output()`):
- Default limits: 2000 lines or 50KB
- Direction: "head" (default) or "tail"
- Full output saved to `~/.opencode/data/tool-output/` with 7-day retention
- Hint message varies based on whether the agent has task tool access

**Invocation Pipeline**: Tools are wrapped as AI SDK `tool()` objects in `resolveTools()`:
```typescript
tools[item.id] = tool({
    id: item.id,
    description: item.description,
    inputSchema: jsonSchema(schema),
    async execute(args, options) {
        const ctx = context(args, options);  // Build Tool.Context
        await Plugin.trigger("tool.execute.before", ...);
        const result = await item.execute(args, ctx);
        await Plugin.trigger("tool.execute.after", ...);
        return result;
    },
});
```

The AI SDK manages tool call detection and invocation during streaming. Plugin hooks fire before and after execution.

**Parallel Execution**: The AI SDK processes tool calls sequentially from the stream. opencode adds `BatchTool` for explicit parallel execution: `Promise.all(toolCalls.map(execute))`, up to 25 tools. No built-in parallel in the core loop.

**Event Emission**: Tool state changes are tracked as `ToolPart` state machine transitions:
```typescript
ToolStatePending   { status: "pending", input, raw }
ToolStateRunning   { status: "running", input, title?, metadata?, time: { start } }
ToolStateCompleted { status: "completed", input, output, title, metadata, time: { start, end }, attachments? }
ToolStateError     { status: "error", input, error, metadata?, time: { start, end } }
```

Progress updates via `ctx.metadata()` update the running state in real-time. These are persisted as message parts, enabling UI rendering and crash recovery.

**Permission Integration**: Tools call `ctx.ask()` during execution:
```typescript
await ctx.ask({
    permission: "read",
    patterns: [filepath],
    always: ["*"],
    metadata: { filepath },
});
// Throws PermissionNext.RejectedError if denied
```

**Doom Loop Detection**: In the processor (not the tool system itself), 3 identical tool+input calls in a row triggers a "doom_loop" permission check.

### Layer Boundaries

- **Above (L1)**: The AI SDK invokes tool execute functions during stream processing. The processor observes tool lifecycle via stream events.
- **Below (L3)**: Tools implement `Tool.Info` interface, registered in `ToolRegistry`.
- **Lateral (L4)**: Permission checks via `ctx.ask()` evaluated against agent + session rulesets.
- **Lateral (Plugins)**: Plugin hooks `tool.execute.before/after` and `tool.definition` for customization.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Definition Pattern** | `ToolSpec` enum + `ToolHandler` trait | `Tool` interface + `AgentTool` extension | `Tool.Info` with lazy `init()` + Zod |
| **Schema System** | Custom JsonSchema subset (Boolean, String, Number, Array, Object) | TypeBox + AJV validation | Zod + `z.toJSONSchema()` + ProviderTransform |
| **Schema Validation** | JSON deserialization (`serde`) | AJV with type coercion | `Zod.parse()` in `Tool.define()` wrapper |
| **Registry** | HashMap + ToolRegistryBuilder, static | Array, no registry, factory functions | Filesystem discovery + plugins + built-in list |
| **Registry Size** | ~300 lines | ~50 lines | ~170 lines |
| **Invocation** | Router -> Registry -> Handler.handle() | Direct array find -> tool.execute() | AI SDK tool() wrapper -> execute |
| **Context Object** | `ToolInvocation` (session, turn, tracker, call_id, name, payload) | None (toolCallId, params, signal, onUpdate) | `Tool.Context` (sessionID, messages, abort, metadata(), ask()) |
| **Result Format** | `ToolOutput` enum (Function{body,success}, Mcp{result}) | `AgentToolResult<T>` (content[], details) | `{title, output, metadata, attachments?}` |
| **Result to LLM** | `into_response(call_id, payload)` -> ResponseInputItem | Direct content blocks -> ToolResultMessage | String output -> AI SDK tool result |
| **Parallel** | RwLock (read for parallel, write for sequential) per-tool flag | Sequential only (with steering interruption) | Sequential + BatchTool (Promise.all, up to 25) |
| **Cancellation** | CancellationToken, aborted tools produce response | AbortSignal passed to execute() | AbortSignal in ctx.abort |
| **Truncation** | TruncationPolicy module, per-tool | Explicit truncateHead/truncateTail per tool | Auto-truncation in Tool.define() wrapper + disk save |
| **Truncation Limits** | Configurable via TruncationPolicy | 2000 lines / 50KB | 2000 lines / 50KB |
| **Progress Streaming** | ToolEmitter events via session channel | onUpdate callback -> tool_execution_update | ctx.metadata() -> ToolPart state updates |
| **Permission Hook** | tool_call_gate (external, orchestrator) | None | ctx.ask() inline |
| **Lifecycle Events** | ExecCommandBegin/End, PatchApplyBegin/End | tool_execution_start/update/end | ToolPart state machine (pending/running/completed/error) |
| **Hook System** | AfterToolUse hook (can abort) | None | Plugin.trigger before/after |
| **Error Handling** | FunctionCallError enum (RespondToModel, Fatal) | try/catch -> isError flag | Zod validation + permission denial + doom loop |
| **Module Organization** | 7+ files, layered (spec/registry/router/context/parallel/events) | 2 files (types.ts + tools/index.ts) | 3 files (tool.ts + registry.ts + truncation.ts) |
| **LOC (framework)** | ~2000+ lines | ~200 lines | ~400 lines |

---

## Synthesis

### Common Patterns

1. **Two-Level Tool Definition**: All three projects separate the LLM-facing specification (name, description, schema) from the execution implementation. codex-rs: `ToolSpec` vs `ToolHandler`. pi-agent: `Tool` vs `AgentTool`. opencode: `Tool.Info.init()` returns both together but separates concerns. This split enables sending only schema information to the LLM while keeping execution logic private.

2. **String-Based Output**: All three ultimately return text/string output to the LLM. codex-rs wraps in `FunctionCallOutputBody::Text(string)`. pi-agent uses `TextContent` blocks. opencode uses a plain `output: string`. The LLM processes text; richer structured outputs (images, files) are secondary.

3. **Truncation at ~50KB / 2000 lines**: All three converge on nearly identical truncation limits. pi-agent and opencode use exactly 2000 lines / 50KB. codex-rs uses a configurable TruncationPolicy. Truncation is essential because LLM context windows are finite and large tool outputs waste tokens.

4. **Sequential Execution Default**: All three default to sequential tool execution. codex-rs adds RwLock for true parallelism. opencode adds BatchTool for explicit parallel. pi-agent stays pure sequential with steering interruption. Sequential is the safe default; parallel is an optimization.

5. **AbortSignal for Cancellation**: Both TypeScript projects use AbortSignal. codex-rs uses CancellationToken (Rust equivalent). Cancellation propagates from the agent loop through the tool system to individual tool execution.

### Key Differences

1. **Registry Complexity**: pi-agent has no registry (plain array). codex-rs has a HashMap registry with builder pattern. opencode has filesystem discovery + plugin loading + runtime registration. The complexity tracks with the extensibility requirements: pi-agent is closed, codex-rs is static, opencode is dynamic.

2. **Context Richness**: pi-agent gives tools almost nothing (just params, signal, callback). codex-rs gives tools the full session and turn context. opencode gives tools session state, message history, and inline permission hooks. Richer context enables more sophisticated tools but creates tighter coupling.

3. **Truncation Strategy**: pi-agent leaves truncation to individual tools. opencode applies auto-truncation at the framework level with disk persistence. codex-rs has a configurable policy. Framework-level truncation (opencode) prevents tools from accidentally blowing up context windows.

4. **Permission Integration**: codex-rs handles permissions externally via an orchestrator pipeline. opencode integrates permissions inline via `ctx.ask()`. pi-agent has no permission integration. The inline approach (opencode) is more ergonomic but couples tools to the permission system.

5. **Event Granularity**: codex-rs emits detailed events per tool type (shell begin/end, patch begin/end). pi-agent emits uniform start/update/end events. opencode uses a state machine (pending/running/completed/error). The state machine approach (opencode) is most suitable for persistence and UI rendering.

### Best Practices Identified

1. **Tool.define() wrapper pattern** (opencode): Wrapping the execute function to add automatic validation, truncation, and error handling reduces boilerplate in individual tool implementations. Every tool gets correct behavior by default.

2. **Typed tool metadata** (pi-agent's `TDetails`, opencode's `M extends Metadata`): Separating LLM output from UI metadata enables rich tool-specific UI rendering without polluting the LLM context.

3. **Pluggable operations** (pi-agent): The `Operations` interface per tool enables remote execution (SSH) without changing tool logic. Worth considering but not essential for MVP.

4. **Disk-persisted truncation** (opencode): Saving full output to disk and providing a path in the truncation message enables the agent to access full output via follow-up tool calls. Practical for large outputs.

5. **Factory functions with cwd** (pi-agent): `createBashTool(cwd)` pattern enables tools configured for different working directories without global state.

---

## Open Questions

### Q1: Schema system choice -- Zod vs TypeBox?

**Existing decision D012**: Zod. Confirmed by this research.

opencode uses Zod with `z.toJSONSchema()` for export and `z.parse()` for validation. pi-agent uses TypeBox with AJV for validation. codex-rs uses a custom JSON Schema subset.

Zod advantages: better TypeScript integration, simpler API, built-in validation, native JSON Schema export. TypeBox advantage: closer to JSON Schema semantically, better AJV integration. For a Bun-based project, Zod is the clear winner (opencode proves it works).

### Q2: Should truncation be automatic (framework-level) or explicit (per-tool)?

opencode's approach (auto-truncation in `Tool.define()` with opt-out) prevents tools from accidentally producing oversized output. pi-agent's approach (explicit per-tool) gives tools more control.

**Recommendation**: Auto-truncation with opt-out (opencode pattern). The `Tool.define()` wrapper should apply truncation unless `metadata.truncated` is already set. This provides a safety net while allowing tools like grep (which truncate internally) to handle their own output.

### Q3: How rich should the tool context be?

pi-agent: minimal (params, signal, callback). opencode: rich (session, messages, permissions, metadata streaming). codex-rs: full session access.

**Recommendation**: Start with a medium context: `{ sessionID, callID, abort: AbortSignal, metadata(update): void, ask(permission): Promise<void> }`. Omit message history initially (tools that need it can get it through other means). The `ask()` and `metadata()` hooks are the key additions over pi-agent's minimal approach.

### Q4: Should there be a formal tool registry?

pi-agent: array (no registry). codex-rs: HashMap. opencode: dynamic discovery.

**Recommendation**: Simple Map registry (existing decision D014). `Map<string, ToolInfo>` with a builder pattern. Add filesystem discovery later for plugins. The Map provides O(1) lookup without the complexity of dynamic discovery.

### Q5: Should truncated output be saved to disk?

opencode saves full output to disk with a 7-day retention schedule. pi-agent saves large bash output to temp files. codex-rs does not persist truncated output.

**Recommendation**: Save to disk (opencode pattern). This is cheap and enables agents to access full output via follow-up tool calls. Use a data directory with scheduled cleanup.

### Q6: Parallel execution strategy?

codex-rs: RwLock with per-tool flag. pi-agent: sequential only. opencode: sequential + BatchTool.

**Existing decision D015**: Sequential execution with parallel-ready interface. Confirmed. Start sequential, add per-tool parallel flag later. The RwLock approach (codex-rs) is elegant but premature for MVP.

---

## Decision Validation

| Decision | Status | Notes |
|----------|--------|-------|
| D012 (Zod schemas) | **Confirmed** | opencode proves Zod works well; z.toJSONSchema() for export, z.parse() for validation |
| D013 (Tool interface with execute) | **Confirmed + Refined** | Adopt opencode's `Tool.define()` wrapper pattern for auto-validation and auto-truncation |
| D014 (Simple Map registry) | **Confirmed** | Map<string, ToolInfo> with builder. Add dynamic discovery later |
| D015 (Sequential with parallel-ready) | **Confirmed** | All three projects default to sequential. Add parallel flag later |
| D016 (Tool context with approval hook) | **Confirmed + Refined** | Adopt opencode's ctx.ask() pattern for inline permission checks |
| D020 (String output + metadata) | **Confirmed** | All three use string output. opencode's {output, metadata, title} is cleanest |
| D021 (One file per tool) | **Confirmed** | All three use this pattern |
| D025 (Auto-truncation with file fallback) | **Confirmed** | opencode's approach: auto-truncate in define() wrapper, save full output to disk |
| D071 (Progress via callback/event) | **Confirmed** | opencode's ctx.metadata() is the best pattern; pi-agent's onUpdate callback is simpler alternative |
