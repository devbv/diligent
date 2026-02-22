# Layer 0: REPL Loop

## Key Questions

1. How does each project structure the basic conversation loop (user input → LLM → response)?
2. What are the core message/event types? List specific type definitions.
3. How is the LLM provider abstracted?
4. What is the boundary between CLI entry and agent core?
5. How is streaming handled?
6. How is conversation state tracked and persisted?
7. How are errors handled (retries, timeouts, context overflow)?
8. What is the concurrency model?

## codex-rs Analysis

**Architecture:** Rust monorepo with clear crate separation: `codex-cli` (CLI entry) → `codex-rs/tui` (TUI) → `codex-rs/core` (agent loop) → `codex-rs/protocol` (pure types) → `codex-rs/codex-api` (API client).

### Entry Flow

```
CLI (clap arg parsing) → TUI (ThreadManager → Codex sessions) → Core submission_loop()
```

- CLI (`cli/src/main.rs`) dispatches to TUI
- TUI (`tui/src/lib.rs`) spawns `ThreadManager`, creates `Codex` sessions
- `App::run()` drives the main event loop

### Core Types

**Submission/Event Protocol (protocol/src/protocol.rs):**

```rust
pub struct Submission { pub id: String, pub op: Op }
pub struct Event { pub id: String, pub msg: EventMsg }

// Op (user→agent) - ~40 variants, tagged union:
pub enum Op {
    UserInput { items: Vec<UserInput>, final_output_json_schema: Option<Value> },
    UserTurn { items, cwd, approval_policy, sandbox_policy, model, effort, summary, collaboration_mode, personality, ... },
    ExecApproval { id: String, turn_id: Option<String>, decision: ReviewDecision },
    PatchApproval { id: String, decision: ReviewDecision },
    Interrupt,
    Shutdown,
    Review { review_request: ReviewRequest },
    Compact,
    Undo,
    ListMcpTools,
    RefreshMcpServers { config: McpServerRefreshConfig },
    // ... ~30 more
}

// EventMsg (agent→user) - 40+ variants:
pub enum EventMsg {
    TurnStarted(TurnStartedEvent),
    TurnComplete(TurnCompleteEvent),
    TurnAborted(TurnAbortedEvent),
    AgentMessage(AgentMessageEvent),
    AgentMessageDelta(AgentMessageDeltaEvent),
    AgentReasoning(AgentReasoningEvent),
    AgentReasoningDelta(AgentReasoningDeltaEvent),
    ExecCommandBegin(ExecCommandBeginEvent),
    ExecCommandOutputDelta(ExecCommandOutputDeltaEvent),
    ExecCommandEnd(ExecCommandEndEvent),
    McpToolCallBegin(McpToolCallBeginEvent),
    McpToolCallEnd(McpToolCallEndEvent),
    ExecApprovalRequest(ExecApprovalRequestEvent),
    RequestUserInput(RequestUserInputEvent),
    ContextCompacted(ContextCompactedEvent),
    TokenCount(TokenCountEvent),
    Error(ErrorEvent),
    StreamError(StreamErrorEvent),
    // ... more
}
```

**Session State:**

```rust
pub(crate) struct Session {
    pub conversation_id: ThreadId,
    tx_event: Sender<Event>,
    agent_status: watch::Sender<AgentStatus>,
    state: Mutex<SessionState>,
    active_turn: Mutex<Option<ActiveTurn>>,
    services: SessionServices,
}

pub(crate) struct SessionState {
    pub history: ContextManager,  // Accumulated conversation items
    pub latest_rate_limits: Option<RateLimitSnapshot>,
    pub session_configuration: SessionConfiguration,
    // ...
}

pub(crate) struct TurnContext {
    pub sub_id: String,
    pub config: Arc<Config>,
    pub model_info: ModelInfo,
    pub cwd: PathBuf,
    pub approval_policy: Constrained<AskForApproval>,
    pub sandbox_policy: Constrained<SandboxPolicy>,
    pub collaboration_mode: CollaborationMode,
    pub reasoning_effort: Option<ReasoningEffortConfig>,
    pub tools_config: ToolsConfig,
    // ...
}
```

### Agent Loop

```rust
// Core loop (codex.rs):
// Submission queue: async_channel::bounded(64)
// Event queue: async_channel::unbounded()

async fn submission_loop(session: Arc<Session>, rx_sub: Receiver<Submission>) {
    while let Ok(sub) = rx_sub.recv().await {
        match sub.op {
            Op::UserInput { .. } => {
                // Spawn turn: tokio::spawn(run_turn(...))
            }
            Op::Interrupt => { session.interrupt_task().await; }
            Op::ExecApproval { .. } => { /* resolve oneshot channel */ }
            // ...
        }
    }
}

// Public API:
impl Codex {
    pub async fn submit(&self, op: Op) -> Result<String>;  // Returns submission_id
    pub async fn next_event(&self) -> Result<Event>;
    pub fn steer_input(&self, items: Vec<UserInput>) -> String;
}
```

### Provider Abstraction

```rust
// Multi-layer abstraction:
ModelClient (session-scoped)
  → ModelClientSession (turn-scoped, caches WebSocket)
    → ApiWebSocketResponsesClient (codex-api crate)
      → OpenAI Responses API (WebSocket or HTTP/SSE fallback)

// Response streaming via mpsc channel:
pub struct ResponseStream {
    pub rx_event: mpsc::Receiver<Result<ResponseEvent>>,
}

pub enum ResponseEvent {
    Created,
    OutputItemDone(ResponseItem),
    OutputItemAdded(ResponseItem),
    OutputTextDelta(String),
    ReasoningContentDelta { delta: String, content_index: i64 },
    Completed { response_id: String, token_usage: Option<TokenUsage>, can_append: bool },
    RateLimits(RateLimitSnapshot),
    ServerModel(String),
    // ...
}
```

### Streaming

- Model streams `ResponseEvent` via mpsc channel
- Turn loop processes with `tokio::select!` (response event vs cancellation)
- Text deltas emitted as `AgentMessageDelta`, tool calls spawn execution tasks
- Tool execution emits `ExecCommandBegin/OutputDelta/End` events independently

### Error Handling

```rust
pub enum CodexErrorInfo {
    ContextWindowExceeded,
    UsageLimitExceeded,
    HttpConnectionFailed { http_status_code: Option<u16> },
    ResponseStreamDisconnected { http_status_code: Option<u16> },
    ResponseTooManyFailedAttempts { http_status_code: Option<u16> },
    SandboxError,
    // ...
}

// Retry strategy:
// - WebSocket connection failed → retry up to 3 times
// - HTTP 429 (rate limit) → exponential backoff
// - HTTP 5xx → retry
// - Stream disconnected → retry with response.append
// - Context overflow → emit Error, no retry
// Backoff: base 100ms * 2^retries, cap ~3.2s
```

### Concurrency Model

- **tokio** async runtime with spawn per turn
- Bounded submission channel (64), unbounded event channel
- `Mutex<SessionState>` for mutable state, `Mutex<Option<ActiveTurn>>` for turn exclusivity
- `CancellationToken` for graceful turn shutdown
- `watch::channel` for status updates
- `FuturesOrdered` for parallel tool execution
- Only one regular user turn at a time (enforced by `active_turn`)

---

## pi-agent Analysis

**Architecture:** TypeScript monorepo with packages: `coding-agent` (CLI/TUI/modes), `agent` (core loop/tools), `ai` (providers/streaming).

### Entry Flow

```
main.ts → parse args → create Agent + AgentSession
  → Route to: InteractiveMode (TUI) | PrintMode (one-shot) | RPCMode (JSON-RPC)
  → session.prompt(text) kicks off conversation
```

### Core Types

**Messages (ai/src/types.ts):**

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  usage: Usage;
  stopReason: StopReason;  // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; };
}
```

**Agent-specific messages (coding-agent/src/core/messages.ts):**

```typescript
// Extensions to base Message for coding-agent specific needs:
interface BashExecutionMessage { role: "bashExecution"; command; output; exitCode; cancelled; truncated; fullOutputPath?; ... }
interface CustomMessage<T> { role: "custom"; customType; content; display; details?; ... }
interface BranchSummaryMessage { role: "branchSummary"; summary; fromId; ... }
interface CompactionSummaryMessage { role: "compactionSummary"; summary; tokensBefore; ... }

type AgentMessage = Message | BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage;
```

**Events (agent/src/types.ts):**

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex; partial }
  | { type: "text_delta"; contentIndex; delta: string; partial }
  | { type: "text_end"; contentIndex; content: string; partial }
  | { type: "thinking_start"; contentIndex; partial }
  | { type: "thinking_delta"; contentIndex; delta: string; partial }
  | { type: "thinking_end"; contentIndex; content: string; partial }
  | { type: "toolcall_start"; contentIndex; partial }
  | { type: "toolcall_delta"; contentIndex; delta: string; partial }
  | { type: "toolcall_end"; contentIndex; toolCall: ToolCall; partial }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

### Agent Loop (agent/src/agent-loop.ts)

```typescript
// Two entry points:
function agentLoop(messages, context, config, signal, streamFn?): EventStream<AgentEvent, AgentMessage[]>
function agentLoopContinue(context, config, signal, streamFn?): EventStream<AgentEvent, AgentMessage[]>

// Core: runLoop()
async function runLoop(context, config, stream, signal) {
  while (true) {
    // Inner loop: process tool calls + steering
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      stream.push({ type: "turn_start" });
      const message = await streamAssistantResponse(context, config, stream, signal);
      // Extract tool calls, execute sequentially
      const toolExecution = await executeToolCalls(toolCalls, context, config, stream, signal);
      // Check for steering messages
      const steering = await config.getSteeringMessages?.();
      if (steering.length > 0) { /* inject and continue */ }
      stream.push({ type: "turn_end", message, toolResults });
    }
    // Check for follow-up messages
    const followUp = await config.getFollowUpMessages?.();
    if (!followUp?.length) break;
  }
}
```

**Agent Config:**

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}
```

### Provider Abstraction

```typescript
// Plugin-based registry:
interface ApiProvider<TApi, TOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

type StreamFunction<TApi, TOptions> = (
  model: Model<TApi>, context: Context, options?: TOptions
) => AssistantMessageEventStream;

// Registry is a Map<string, RegisteredApiProvider>
registerApiProvider(provider);   // Register provider
getApiProvider(api);             // Look up by api name

// Supported: anthropic-messages, openai-completions, openai-responses, google, bedrock, azure, vertex
// All providers return uniform AssistantMessageEventStream
```

### Streaming

```typescript
// EventStream: generic async iterable with completion promise
class EventStream<T, R> implements AsyncIterable<T> {
  push(event: T): void;      // Producer pushes
  [Symbol.asyncIterator]();   // Consumer awaits
  result(): Promise<R>;       // Final result promise
}

class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {}

// Usage in agentLoop:
const response = await streamFunction(model, context, options);
for await (const event of response) {
  // Handle text_delta, toolcall_end, done, error...
  stream.push({ type: "message_update", assistantMessageEvent: event, message });
}
```

### Session Persistence (coding-agent/src/core/session-manager.ts)

```
File: ~/.pi/agent/sessions/<session-id>.txt (JSONL append-only)

Header: {"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"..."}
Entries (appended):
  {"type":"message","id":"<uuid>","parentId":"<prev>","timestamp":"...","message":{...}}
  {"type":"model_change","id":"<uuid>","parentId":"<prev>","timestamp":"...","provider":"anthropic","modelId":"claude-opus-4.6"}
  {"type":"compaction","id":"<uuid>","parentId":"<prev>","timestamp":"...","summary":"...","firstKeptEntryId":"<id>","tokensBefore":50000}

Tree structure: parentId enables branching/resuming
```

**Session State:**

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamMessage: AgentMessage | null;
  pendingToolCalls: Set<string>;
  error?: string;
}
```

### Error Handling

```typescript
// In AgentSession:
_isRetryableError(message: AssistantMessage): boolean {
  // Pattern match: overloaded|rate.?limit|429|500|502|503|504|service.?unavailable|...
  // Context overflow NOT retried (handled by compaction)
}

_handleRetryableError(message): boolean {
  // Exponential backoff: settings.initialDelayMs * 2^(attempt-1)
  // Max retries from settings.maxRetries
  // Emit auto_retry_start event, wait, call agent.continue()
}
```

### Concurrency Model

- **Single-threaded JavaScript** (async/await, no real threads)
- `AbortController` for cancellation propagation throughout chain
- `agent.steer()` / `agent.followUp()` are non-blocking message queues
- Sequential tool execution with steering checks between each tool
- No locks needed; JS event loop serializes access

---

## opencode Analysis

**Architecture:** TypeScript/Bun monorepo. Server-based architecture: CLI → Hono HTTP server → Session → LLM. Heavy use of Vercel AI SDK. SQLite for persistence.

### Entry Flow

```
src/index.ts → yargs commands:
  TuiThreadCommand: Worker thread for backend + Solid.js TUI
  RunCommand: Direct bootstrap → SDK client → sdk.session.prompt()
```

### Core Types

**Messages (session/message-v2.ts):**

```typescript
// Discriminated union on role:
MessageV2.User {
  id: string; role: "user"; sessionID: string;
  time: { created: number };
  format?: { type: "text" | "json_schema"; schema?; retryCount? };
  agent: string;
  model: { providerID: string; modelID: string };
  system?: string;
  tools?: Record<string, boolean>;
}

MessageV2.Assistant {
  id: string; role: "assistant"; sessionID: string;
  time: { created: number; completed?: number };
  error?: NamedError;  // AuthError | APIError | ContextOverflowError | AbortedError | StructuredOutputError
  parentID: string;
  modelID: string; providerID: string;
  agent: string;
  path: { cwd: string; root: string };
  cost: number;
  tokens: { input; output; reasoning; cache: { read; write }; total? };
  finish?: string;  // "stop" | "tool-calls" | "unknown"
}

// Part types (separate from message):
TextPart { type: "text"; text: string; synthetic?; time?: { start; end? }; metadata? }
ReasoningPart { type: "reasoning"; text: string; time: { start; end? }; metadata? }
ToolPart { type: "tool"; callID: string; tool: string; state: ToolState; metadata? }
FilePart { type: "file"; mime: string; filename?; url: string; source? }
SnapshotPart { type: "snapshot"; snapshot: string }
PatchPart { type: "patch"; hash: string; files: string[] }
StepStartPart { type: "step-start"; snapshot? }
StepFinishPart { type: "step-finish"; reason: string; cost; tokens }
SubtaskPart { type: "subtask"; prompt: string; agent: string }
CompactionPart { type: "compaction"; auto: boolean }

// Tool state machine:
ToolStatePending { status: "pending"; input: any }
ToolStateRunning { status: "running"; input: any; time: { start } }
ToolStateCompleted { status: "completed"; input; output; title; metadata; time: { start; end }; attachments? }
ToolStateError { status: "error"; input; error: string; time: { start; end } }
```

**Events (Bus-based):**

```typescript
// Session Events:
Session.Event.Created/Updated/Deleted: { info: Session.Info }
Session.Event.Diff: { sessionID; diff: FileDiff[] }
Session.Event.Error: { sessionID?; error }

// Message Events:
MessageV2.Event.Updated: { info: MessageV2.Info }
MessageV2.Event.PartUpdated: { part: MessageV2.Part }
MessageV2.Event.PartDelta: { sessionID; messageID; partID; field; delta: string }
MessageV2.Event.PartRemoved: { sessionID; messageID; partID }

// Status:
SessionStatus.Info = { type: "idle" } | { type: "retry"; attempt; message; next } | { type: "busy" }
```

### Agent Loop (session/prompt.ts)

```typescript
// Main entry: SessionPrompt.prompt(input: PromptInput)
// Creates user message → Session.touch() → SessionPrompt.loop()

// The loop (line 274, ~450 lines):
async function loop(input) {
  using _ = defer(() => cancel(sessionID));  // Cleanup on exit
  start(sessionID);  // Create AbortController

  while (true) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID));

    // 1. Subtask handler (if pending subtask)
    if (task.type === "subtask") { await TaskTool.execute(); continue; }

    // 2. Compaction handler (if pending compaction)
    if (task.type === "compaction") { await SessionCompaction.process(); continue; }

    // 3. Context overflow check
    if (overflowing) { await SessionCompaction.create(); continue; }

    // 4. Normal processing
    const agent = Agent.get(lastUser.agent);
    const tools = await resolveTools({ agent, model, session, processor, messages });
    const assistantMsg = createAssistantMessage();
    const processor = SessionProcessor.create();
    const systemPrompt = buildSystemPrompt();
    const modelMessages = convertToModelMessages(msgs);

    const result = await processor.process({
      sessionID, model, system: systemPrompt, messages: modelMessages,
      tools, abort, user: lastUser
    });

    if (assistantMsg.finish !== "tool-calls") break;
    // Otherwise loop continues for next turn
  }
}
```

**SessionProcessor.process (processor.ts):**

```typescript
// Wraps LLM.stream() and handles all stream events
for await (const value of stream.fullStream) {
  switch(value.type) {
    case "text-start": /* Create TextPart */
    case "text-delta": /* Append + publish PartDelta */
    case "text-end": /* Finalize + plugin hook */
    case "tool-input-start": /* Create ToolPart (pending) */
    case "tool-call": /* Update to running → execute tool → completed/error */
    case "tool-result": /* Store output in ToolPart */
    case "tool-error": /* Permission check, set error state */
    case "reasoning-*": /* Create/update ReasoningPart */
    case "finish-step": /* Calculate cost/tokens, check overflow */
    case "error": /* Throw for retry logic */
  }
}
```

### Provider Abstraction

```typescript
// Built on Vercel AI SDK (ai package)
Provider.getModel(providerID, modelID): Promise<Provider.Model>
Provider.getLanguage(model): Promise<LanguageModel>  // ai SDK model instance
Provider.getProvider(providerID): Promise<Provider.Info>

// Provider.Model carries:
{ id, providerID, api: { id, npm, url? }, capabilities: { temperature, topP, reasoning },
  cost?: { input, output, cache? }, headers?, options?, variants? }

// BUNDLED_PROVIDERS: @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google,
//   @ai-sdk/amazon-bedrock, @ai-sdk/groq, @ai-sdk/mistral, @openrouter/ai-sdk-provider, 20+ more

// ProviderTransform namespace handles:
// - options() → Build provider options
// - schema() → Transform JSON schema for provider compatibility
// - message() → Transform message format for provider
```

### Streaming

```typescript
// LLM.stream() returns StreamTextResult from ai SDK
const stream = await LLM.stream({
  user, sessionID, model, agent, system, abort, messages, tools, retries?, toolChoice?
});

// Events consumed from stream.fullStream (AsyncIterable):
// text-start/delta/end, reasoning-start/delta/end, tool-input-start/delta/end,
// tool-call, tool-result, tool-error, start-step, finish-step, error, finish

// Real-time updates published immediately via Bus:
Bus.publish(MessageV2.Event.PartDelta, { sessionID, messageID, partID, field: "text", delta })
// UI subscribes to these for live rendering
```

### Session Persistence (SQLite + Drizzle ORM)

```typescript
// Database tables:
SessionTable { id, project_id, parent_id?, slug, directory, title, version, share_url?,
  summary?, revert?, permission?, time_created, time_updated, time_compacting?, time_archived? }

MessageTable { id, session_id (FK cascade), time_created, time_updated, data: MessageV2.Info (JSON) }

PartTable { id, message_id (FK cascade), session_id, time_created, time_updated, data: MessageV2.Part (JSON) }

// Message loading: paginated stream (50 at a time) with compaction filtering
MessageV2.stream(sessionID): AsyncGenerator<MessageV2.WithParts>
MessageV2.filterCompacted(stream): Promise<MessageV2.WithParts[]>

// Session forking: copy messages/parts up to fork point with new IDs
Session.fork({ sessionID, messageID? }): Promise<Session.Info>
```

### Error Handling

```typescript
// Error classification (MessageV2.fromError):
AbortError → MessageV2.AbortedError
APIKeyError → MessageV2.AuthError { providerID; message }
APICallError → MessageV2.APIError { message; statusCode?; isRetryable; responseHeaders?; responseBody? }
StreamError → MessageV2.ContextOverflowError | MessageV2.APIError

// Retry strategy (SessionRetry):
SessionRetry.retryable(error): string | undefined
  - ContextOverflowError → NOT retryable (use compaction)
  - APIError.isRetryable=false → NOT retryable
  - FreeUsageLimitError → NOT retryable
  - All others → retryable

SessionRetry.delay(attempt, error?): number
  - If retry-after header → use it
  - Otherwise: 2^attempt seconds (2, 4, 8, ..., cap 30s)

// Doom loop detection (processor.ts):
// If same tool + same input executes 3 times in a row, ask for permission before continuing
```

### Concurrency Model

- **Single-threaded async/await** (Bun runtime)
- `AbortController` chain: prompt → loop → processor → LLM.stream → streamText
- `SessionPrompt.assertNotBusy(sessionID)` prevents concurrent prompts per session
- Database transactions with deferred effects: events published only after commit
- Individual tool executions may spawn child processes (Bun.spawn)

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Language/Runtime** | Rust (tokio) | TypeScript (Node) | TypeScript (Bun) |
| **Loop Pattern** | Channel-based (mpsc + submission_loop) | Async generator / while loop | While loop with processor |
| **Message Format** | Tagged union (Op/Event, 40+ variants each) | Discriminated union by role | Part-based messages (message + parts separate) |
| **Streaming** | WebSocket + HTTP/SSE fallback, mpsc channel | Custom EventStream (AsyncIterable), provider streams | ai-sdk streamText, Bus PartDelta events |
| **Provider Abstraction** | ModelClient → ModelClientSession → API client | Registry + plugin pattern, uniform EventStream | ai-sdk + custom ProviderTransform wrappers |
| **CLI/Core Boundary** | Crate separation (protocol → core → tui → cli) | Package separation (ai → agent → coding-agent) | Server/client (HTTP/RPC via Hono) |
| **State Storage** | In-memory (ContextManager) + StateDbHandle | JSONL append-only files (tree-structured) | SQLite (Drizzle ORM, 3 tables) |
| **Event Granularity** | Very fine (40+ event types) | Medium (12 agent events + 12 streaming events) | Part-based (type-specific PartDelta events) |
| **Multi-mode** | TUI only | Interactive + Print + RPC | TUI + CLI Run |
| **Concurrency** | tokio spawn per turn, Mutex for state, CancellationToken | Single-threaded async, AbortController, message queues | Single-threaded async, AbortController, DB transactions |
| **Error Retry** | Exponential backoff (100ms base, 3.2s cap), up to 3 retries | Pattern-match based, configurable max/delay, exponential | retry-after headers or 2^n seconds, cap 30s |
| **Context Overflow** | Emit error (no auto-recovery) | Auto-compaction via AgentSession | Auto-compaction + CompactionPart |
| **Interruption** | CancellationToken + Op::Interrupt | agent.steer() / agent.abort() message queues | SessionPrompt.cancel() via AbortController |
| **Tool Execution** | Parallel (RwLock), per-tool flag | Sequential with steering checks between | Sequential (ai-sdk processes one by one) |
| **Turn Exclusivity** | active_turn Mutex (one turn at a time) | isStreaming flag + abort on new prompt | assertNotBusy() check |

## Open Questions

1. **Event granularity**: codex-rs has 40+ event types (very detailed), pi-agent has ~24 total across two layers (good middle ground), opencode uses part-based deltas (fewer event types but part-type polymorphism). What's the right level for diligent?

2. **Message model**: Should messages and parts be separate entities (opencode) or unified (pi-agent)? Separation enables granular streaming updates but adds complexity. Union approach is simpler but harder to stream partial tool results.

3. **Streaming transport**: codex-rs uses WebSocket (complex, bidirectional), pi-agent uses custom EventStream (simple, elegant), opencode uses ai-sdk (convenient but vendor-coupled). Direct fetch+SSE with custom EventStream seems like the best balance.

4. **State persistence**: In-memory (codex-rs) is fastest but loses state. JSONL (pi-agent) is simple and append-only with branching. SQLite (opencode) is most queryable but heaviest. For a coding agent, JSONL seems like the right starting point.

5. **Provider SDK usage**: opencode couples heavily to ai-sdk (20+ provider packages). pi-agent rolls its own streaming abstraction per provider. codex-rs is fully custom. Rolling our own with a uniform streaming interface (like pi-agent) gives most control.

6. **Server architecture**: opencode puts a full HTTP server between TUI and core. Is this over-engineering for early stages or a good foundation for extensibility?

7. **Context overflow handling**: pi-agent and opencode both auto-compact when context fills up. codex-rs just emits an error. Auto-compaction is clearly more user-friendly but adds significant complexity. When should this be introduced?

8. **Steering/interruption**: pi-agent's message queue approach is elegant — `steer()` queues a message, checked between tool calls. codex-rs uses CancellationToken for hard abort. Should we support soft interruption (steering) from day one?

9. **Turn context vs session state**: codex-rs clearly separates immutable TurnContext (per-turn) from mutable SessionState (per-session). This clean separation is worth adopting. pi-agent mixes both in AgentContext.

10. **Doom loop detection**: opencode detects when the same tool+input runs 3 times in a row and asks for permission. This is a practical safety measure worth considering early.
