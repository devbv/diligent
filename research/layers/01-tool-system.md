# Layer 1: Tool System

## Key Questions

1. How are tools defined (type/interface)?
2. How are tools registered/discovered?
3. How does the agent loop invoke tools?
4. How are tool results returned to the LLM?
5. What is the tool call lifecycle?
6. How are parallel vs sequential tool calls handled?
7. How is approval integrated into tool execution?
8. How are schemas validated?
9. How are errors handled?
10. What are the key abstractions and their relationships?

## codex-rs Analysis

### Tool Definition

**Two-level system: ToolSpec (wire type) + ToolHandler (implementation)**

```rust
// Wire type sent to model:
pub enum ToolSpec {
    Function(ResponsesApiTool),   // name, description, strict, parameters: JsonSchema
    LocalShell {},                 // Built-in shell
    WebSearch { external_web_access? },
    Freeform(FreeformTool),       // name, description, format (Lark grammar)
}

// ConfiguredToolSpec wraps with parallel support flag:
pub struct ConfiguredToolSpec {
    pub spec: ToolSpec,
    pub supports_parallel_tool_calls: bool,
}

// Implementation trait:
#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn kind(&self) -> ToolKind;   // Function | Mcp
    fn matches_kind(&self, payload: &ToolPayload) -> bool;
    async fn is_mutating(&self, invocation: &ToolInvocation) -> bool;
    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError>;
}
```

### Tool Registry

```rust
pub struct ToolRegistry {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
}

pub struct ToolRegistryBuilder {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
    specs: Vec<ConfiguredToolSpec>,
}

impl ToolRegistryBuilder {
    pub fn push_spec(&mut self, spec: ToolSpec);
    pub fn push_spec_with_parallel_support(&mut self, spec: ToolSpec, supports_parallel: bool);
    pub fn register_handler(&mut self, name: impl Into<String>, handler: Arc<dyn ToolHandler>);
    pub fn build(self) -> (Vec<ConfiguredToolSpec>, ToolRegistry);
}

// build_specs() factory: creates all handlers, conditionally adds based on config
// Static registration, no runtime discovery (MCP tools added via MCPConnectionManager)
```

### Tool Invocation

```rust
pub struct ToolRouter {
    registry: ToolRegistry,
    specs: Vec<ConfiguredToolSpec>,
}

impl ToolRouter {
    pub fn specs(&self) -> Vec<ToolSpec>;  // For model
    pub async fn build_tool_call(session, item: ResponseItem) -> Result<Option<ToolCall>>;
    pub async fn dispatch_tool_call(&self, session, turn, tracker, call, source) -> Result<ResponseInputItem>;
}

// Dispatch flow: ResponseItem → ToolCall → ToolInvocation → handler.handle() → ToolOutput → ResponseInputItem
```

**ToolInvocation carries:**
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

### Tool Results

```rust
pub enum ToolOutput {
    Function { body: FunctionCallOutputBody, success: Option<bool> },  // Text or ContentItems
    Mcp { result: Result<CallToolResult, String> },
}

// Converts to ResponseInputItem based on payload type:
// Function → FunctionCallOutput { call_id, output: { body, success } }
// Custom → CustomToolCallOutput { call_id, output }
// Mcp → McpToolCallOutput { call_id, result }
```

### Tool Lifecycle

1. **Lookup**: Find handler by name in HashMap (O(1))
2. **Validation**: Check payload kind matches handler kind
3. **Mutating check**: `is_mutating()` → if true, wait for `tool_call_gate.wait_ready()`
4. **Execution**: `handler.handle(invocation)` async
5. **Hook dispatch**: Fire AfterToolUse hook (can abort)
6. **Response conversion**: `output.into_response(call_id, payload)`

Events emitted: ExecCommandBegin/OutputDelta/End, PatchApplyBegin/End

### Parallel vs Sequential

```rust
pub struct ToolCallRuntime {
    parallel_execution: Arc<RwLock<()>>,  // Single RwLock
}

// Per-tool flag: supports_parallel_tool_calls
// Parallel tools: .read() lock (concurrent)
// Sequential tools: .write() lock (exclusive)
// Example: shell=parallel, apply_patch=sequential
```

### Approval Integration (Orchestrator)

```rust
pub struct ToolOrchestrator { sandbox: SandboxManager }

// Pipeline: Approval → Sandbox Selection → Attempt → Retry with Escalation → Network Approval
// ExecApprovalRequirement: Skip | NeedsApproval { reason } | Forbidden { reason }
// ToolRuntime trait extends: Approvable + Sandboxable + network_approval_spec()
// ApprovalStore caches decisions per-session
```

### Schema System

Custom JsonSchema subset: Boolean, String, Number, Array, Object with properties/required/additionalProperties. NOT full JSON Schema. Compatible with MCP. `strict: bool` flag for validation mode.

### Error Handling

```rust
pub enum FunctionCallError {
    RespondToModel(String),    // Error message sent to LLM
    MissingLocalShellCallId,   // Parse error
    Fatal(String),             // Unrecoverable
}

pub enum ToolError {
    Rejected(String),          // User declined
    Codex(CodexErr),           // Execution error (sandbox timeout, etc.)
}
```

---

## pi-agent Analysis

### Tool Definition

**Two-level hierarchy: Tool (base) → AgentTool (executable)**

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
    onUpdate?: AgentToolUpdateCallback<TDetails>,  // Streaming callback
  ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // To LLM
  details: T;                                // To UI
}
```

### Tool Registry

```typescript
// No formal registry — tools passed as array to AgentContext
interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}

// Tool collections:
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];
export const allTools = { read: readTool, bash: bashTool, edit: editTool, ... };

// Factory for custom cwd:
export function createCodingTools(cwd, options?): Tool[]
```

### Tool Invocation

```typescript
// In agentLoop's runLoop():
// 1. Stream assistant response
// 2. Filter tool calls from content
const toolCalls = message.content.filter(c => c.type === "toolCall");
// 3. Execute sequentially
const { toolResults, steeringMessages } = await executeToolCalls(tools, message, signal, stream, getSteeringMessages);
// 4. Push results to context
for (const result of toolResults) context.messages.push(result);
```

**executeToolCalls flow:**
1. For each toolCall in sequence:
2. Emit `tool_execution_start` event
3. Validate args: `validateToolArguments(tool, toolCall)` (AJV + TypeBox)
4. Execute: `tool.execute(toolCallId, validatedArgs, signal, onUpdate)`
5. Emit `tool_execution_update` via onUpdate callback
6. Catch errors → `isError = true`
7. Emit `tool_execution_end`
8. Create `ToolResultMessage`
9. Check steering messages → skip remaining if user interrupted

### Tool Results

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
// Added to context.messages for next LLM turn
```

### Tool Lifecycle Events

```typescript
type AgentEvent =
  | { type: "tool_execution_start"; toolCallId; toolName; args }
  | { type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
  | { type: "tool_execution_end"; toolCallId; toolName; result; isError };
```

### Parallel vs Sequential

**Sequential only** with steering interruption:
- Simple for loop over tool calls
- Between each tool, check `getSteeringMessages()`
- If steering messages found, skip remaining tools with placeholder results
- No parallel execution at all

### Validation

AJV with TypeBox schema compilation. Supports type coercion (AJV mutates args). CSP-aware (disables in browser extensions). Errors formatted with JSON paths.

### Error Handling

All tool execution wrapped in try/catch. Errors converted to content `[{ type: "text", text: error.message }]` with `isError: true`. Error message sent to LLM for self-correction.

---

## opencode Analysis

### Tool Definition

**Lazy init pattern with Zod schemas:**

```typescript
interface Tool.Info<Parameters extends z.ZodType, M extends Metadata> {
  id: string;
  init: (ctx?: InitContext) => Promise<{
    description: string;
    parameters: Parameters;   // Zod schema
    execute(args: z.infer<Parameters>, ctx: Tool.Context): Promise<{
      title: string;
      metadata: M;
      output: string;
      attachments?: FilePart[];
    }>;
    formatValidationError?(error: z.ZodError): string;
  }>;
}

// Tool.Context provides:
interface Tool.Context<M> {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
  callID?: string;
  extra?: Record<string, any>;
  messages: MessageV2.WithParts[];
  metadata(input: { title?; metadata?: M }): void;  // Real-time streaming updates
  ask(input: PermissionRequest): Promise<void>;      // Permission check
}

// Convenience constructor:
function Tool.define<P, R>(id, init: function | object): Tool.Info<P, R>
```

### Tool Registry

```typescript
// Discovery: filesystem scan + plugin loading
const matches = Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: configDir });
// Dynamic import of each module
const mod = await import(match);
// Plus plugin tools: Plugin.list() → plugin.tool entries

// Built-in tools listed explicitly in all():
[InvalidTool, BashTool, ReadTool, GlobTool, GrepTool, EditTool, WriteTool, TaskTool, ...]

// Filtered by model/provider:
async function tools(model, agent?): Promise<Tool[]>
// apply_patch for GPT, edit/write for Claude, websearch for opencode provider, etc.

// Runtime registration:
async function register(tool: Tool.Info): void
```

### Tool Invocation

```typescript
// In resolveTools() (prompt.ts):
// 1. Get tools from ToolRegistry.tools(model, agent)
// 2. For each tool, create AI SDK wrapper:
const schema = ProviderTransform.schema(model, z.toJSONSchema(item.parameters));
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

// 3. Pass to LLM.stream({ tools }) which calls ai-sdk streamText()
// 4. AI SDK handles tool-call events, invokes execute
```

### Tool Results

```typescript
// Tool returns:
{ title: string, metadata: M, output: string, attachments?: FilePart[] }

// Automatically truncated if tool doesn't handle truncation:
if (result.metadata.truncated === undefined) {
  const truncated = await Truncate.output(result.output);
  result.output = truncated.content;
  result.metadata.truncated = truncated.truncated;
}

// Stored as ToolPart in session:
ToolStateCompleted { status: "completed", input, output, title, metadata, time, attachments? }
```

### Tool Lifecycle (State Machine)

```typescript
ToolStatePending   { status: "pending", input, raw }           // Input being streamed
ToolStateRunning   { status: "running", input, title?, metadata?, time: { start } }  // Executing
ToolStateCompleted { status: "completed", input, output, title, metadata, time: { start, end }, attachments? }
ToolStateError     { status: "error", input, error, metadata?, time: { start, end } }

// Transitions via Session.updatePart() in processor.ts
```

### Parallel vs Sequential

- AI SDK processes tool calls sequentially from stream
- **BatchTool** enables explicit parallel: `Promise.all(toolCalls.map(execute))`, up to 25 tools
- No built-in parallel in the core loop

### Permission Integration

```typescript
// Tools call ctx.ask() mid-execution:
await ctx.ask({
  permission: "read",          // Permission name
  patterns: [filepath],         // Specific resource patterns
  always: ["*"],               // Broad patterns to pre-approve
  metadata: { filepath, diff }, // Context for user decision
});
// Throws PermissionNext.RejectedError if denied
// Evaluated against agent + session rulesets
```

### Schema System

Zod schemas → `z.toJSONSchema()` → `ProviderTransform.schema(model, jsonSchema)` for provider compatibility. Validation at execution time via `toolInfo.parameters.parse(args)`. Custom `formatValidationError()` optional.

### Error Handling

- Validation errors: Zod parse failure → descriptive error message
- Permission denial: `PermissionNext.RejectedError` → may stop loop
- Execution errors: caught by AI SDK → `tool-error` event → ToolStateError
- **Doom loop detection**: same tool+input 3x in a row → ask for "doom_loop" permission

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Definition Pattern** | ToolSpec enum + ToolHandler trait | Tool interface + AgentTool extension | Tool.Info with lazy init() + Zod |
| **Schema System** | Custom JsonSchema subset | TypeBox + AJV validation | Zod + z.toJSONSchema() + ProviderTransform |
| **Registry** | HashMap + builder, static registration | Array (no registry), factory functions | Filesystem discovery + plugins + runtime register |
| **Invocation** | Router → Registry → Handler | Direct array lookup → execute() | AI SDK tool() wrapper → execute |
| **Result Format** | ToolOutput(body, success) → ResponseInputItem | AgentToolResult(content[], details) → ToolResultMessage | {title, output, metadata, attachments?} → ToolPart |
| **Lifecycle States** | Implicit (async flow) + events | 3 events (start/update/end) | 4 explicit states (pending/running/completed/error) |
| **Parallel** | RwLock per-tool flag (true parallel) | Sequential only (with steering) | Sequential + batch tool (Promise.all, up to 25) |
| **Approval** | Orchestrator pipeline (approval → sandbox → network) | None (external) | ctx.ask() inline permission |
| **Streaming Results** | Event deltas via channels | onUpdate callback | ctx.metadata() updates |
| **Error Recovery** | FunctionCallError enum, hook abort | try/catch → isError flag | Zod validation, permission denial, doom loop |
| **Complexity** | High (orchestrator, sandbox, network approval) | Low (direct execute, simple events) | Medium (registry, permissions, state machine) |

## Open Questions

1. **Schema system**: Zod is the clear winner for TS. `z.toJSONSchema()` provides native JSON Schema export. TypeBox (pi-agent) has better JSON Schema alignment but worse ecosystem.

2. **Registry complexity**: pi-agent's "no registry" (array) is simplest but limits dynamism. opencode's filesystem discovery is most extensible but adds startup cost. A simple Map registry (like codex-rs but simpler) is the right balance.

3. **Parallel execution**: codex-rs's RwLock is most sophisticated but premature. pi-agent's sequential-with-steering is simplest. Sequential first with `supportParallel` flag for later is correct.

4. **Approval integration point**: codex-rs's orchestrator is heavy. opencode's ctx.ask() is elegant but tightly coupled to tool implementation. pi-agent's external approach requires refactoring. Placeholder approval hook in context (auto-approve initially) is the right starting point.

5. **Lazy initialization**: opencode's `init()` pattern defers expensive setup. Not needed initially but useful for MCP connections later.

6. **Tool result format**: opencode's `{output: string, metadata: M}` with automatic truncation is the cleanest. pi-agent's content blocks are more flexible for images. Start with string output + metadata.

7. **Streaming during execution**: pi-agent's onUpdate callback is simple. opencode's ctx.metadata() is richer. codex-rs emits events via channels. For our Op/Event model, the callback approach maps cleanly to event emission.

8. **Doom loop detection**: opencode's 3-strike detection is practical. Worth adding early since it prevents common failure modes.

9. **ProviderTransform**: opencode's schema transformation for different providers is necessary for multi-provider support. Should be built into the provider abstraction, not the tool system.
