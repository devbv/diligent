# L1: Agent Loop Research

## Problem Definition

The Agent Loop is the core orchestration layer of a coding agent: it manages the conversation lifecycle, coordinates LLM calls with tool execution, handles message history, emits events for UI consumption, manages cancellation and retry, and implements the turn-based interaction model. This layer sits above the Provider (L0) and below the Tool System (L2), consuming streaming events from the provider and dispatching tool calls to registered tools.

### Key Questions

1. How does each project structure the main agent loop (while-loop, channel-based, recursive)?
2. What is the message/event model (types, lifecycle, granularity)?
3. How are turns and sessions modeled as state?
4. How does the loop handle tool call execution (sequential, parallel, interleaved)?
5. How is cancellation implemented (hard abort vs soft steering)?
6. How is retry orchestrated (backoff, attempt counting, error routing)?
7. Where is the boundary between the agent loop and the provider layer?
8. How are events emitted for UI consumption?

### Layer Scope

- Conversation loop orchestration (the main while-loop)
- Message types and history management
- Turn lifecycle (start, LLM call, tool execution, end)
- Event emission for UI/external consumers
- Cancellation (abort, steering, interruption)
- Retry orchestration (backoff timing, attempt tracking)
- Error routing (retry vs fatal vs compaction)
- Context management hooks (transforms, compaction triggers)

### Boundary: What Is NOT in This Layer

- LLM API communication and streaming (L0: Provider)
- Tool definitions and implementations (L2: Tool System, L3: Core Tools)
- Permission checks (L4: Approval)
- Session persistence to disk/DB (L6: Session)
- UI rendering (L7: TUI & Commands)

---

## codex-rs Analysis

### Architecture

codex-rs uses a **channel-based submission loop** pattern. The `Codex` struct is the public API, operating as a queue pair: the caller sends `Submission`s (containing `Op` variants) and receives `Event`s. Internally, a `submission_loop` tokio task processes submissions sequentially.

**Core struct** (`core/src/codex.rs`):
```rust
pub struct Codex {
    pub(crate) tx_sub: Sender<Submission>,
    pub(crate) rx_event: Receiver<Event>,
    pub(crate) agent_status: watch::Receiver<AgentStatus>,
    pub(crate) session: Arc<Session>,
}
```

The `Session` struct holds mutable state behind a `Mutex<SessionState>`:
```rust
pub(crate) struct Session {
    pub(crate) conversation_id: ThreadId,
    tx_event: Sender<Event>,
    agent_status: watch::Sender<AgentStatus>,
    state: Mutex<SessionState>,
    features: Features,
    pub(crate) active_turn: Mutex<Option<ActiveTurn>>,
    pub(crate) services: SessionServices,
    // ...
}
```

The key architectural decision is the **submission_loop** pattern: `Codex::spawn()` creates bounded (512) and unbounded channels, then spawns a tokio task running `submission_loop(session, config, rx_sub)`. This task processes `Op` variants (user messages, configuration changes, approval responses, etc.) one at a time.

### Op/Event Pattern

**Submissions** contain an `Op` (operations from user/UI to agent):
```rust
pub(crate) struct Submission { id: String, op: Op }
```

The `Op` enum includes variants for user messages, approval decisions, configuration changes, session control, etc. The agent processes each `Op` and emits `Event`s back through the event channel.

**Events** are the agent-to-UI communication channel:
```rust
pub(crate) struct Event {
    // Contains EventMsg variants
}
```

Event types are extensive (40+ variants inferred from imports): `SessionConfiguredEvent`, `TurnStartedEvent`, `ItemStartedEvent`, `ItemCompletedEvent`, `AgentMessageContentDeltaEvent`, `ReasoningContentDeltaEvent`, `TokenCountEvent`, `ExecApprovalRequestEvent`, `StreamErrorEvent`, `TurnDiffEvent`, `PlanDeltaEvent`, `WarningEvent`, `ErrorEvent`, `RateLimitSnapshot`, and many more.

### Turn Context vs Session State

codex-rs explicitly separates per-turn immutable context from per-session mutable state:

**`TurnContext`** (immutable per turn, ~30 fields):
```rust
pub(crate) struct TurnContext {
    pub(crate) sub_id: String,
    pub(crate) config: Arc<Config>,
    pub(crate) model_info: ModelInfo,
    pub(crate) provider: ModelProviderInfo,
    pub(crate) reasoning_effort: Option<ReasoningEffortConfig>,
    pub(crate) cwd: PathBuf,
    pub(crate) approval_policy: Constrained<AskForApproval>,
    pub(crate) sandbox_policy: Constrained<SandboxPolicy>,
    pub(crate) tools_config: ToolsConfig,
    pub(crate) features: Features,
    pub(crate) truncation_policy: TruncationPolicy,
    // ... ~20 more fields
}
```

**`SessionState`** (mutable, behind `Mutex`):
Contains conversation history, configuration that can change mid-session, accumulated token usage, etc.

**`ActiveTurn`** tracks the currently running turn, enabling steering/interruption:
```rust
pub(crate) active_turn: Mutex<Option<ActiveTurn>>,
```

### Tool Execution

codex-rs supports **parallel tool execution** via `ToolCallRuntime`:
```rust
use crate::tools::parallel::ToolCallRuntime;
```

Tools are dispatched through a `ToolRouter` that routes tool calls to handlers. The parallel execution uses `RwLock` to allow concurrent read operations (like file reads) while serializing write operations.

### Cancellation and Steering

codex-rs uses `CancellationToken` (from `tokio_util`) for cancellation:
```rust
use tokio_util::sync::CancellationToken;
```

For soft interruption (steering), users can submit new input during an active turn:
```rust
pub async fn steer_input(&self, input: Vec<UserInput>, expected_turn_id: Option<&str>)
    -> Result<String, SteerInputError>
```

`SteerInputError` includes `NoActiveTurn` and `ExpectedTurnMismatch` variants, showing that steering is turn-aware and can verify it targets the right turn.

### Retry and Error Handling

Retry uses exponential backoff from `crate::util::backoff`. The session loop handles errors by classifying them (via L0's `ApiError`) and deciding whether to retry, compact, or fail.

Context overflow triggers compaction:
```rust
use crate::compact::run_inline_auto_compact_task;
use crate::compact_remote::run_inline_remote_auto_compact_task;
```

Both local and remote compaction strategies are available.

### Event Granularity

codex-rs has the most fine-grained event system of the three projects, with 40+ event types. This includes:
- Turn lifecycle: `TurnStartedEvent`, turn completion
- Content streaming: `AgentMessageContentDeltaEvent`, `ReasoningContentDeltaEvent`, `ReasoningRawContentDeltaEvent`
- Tool execution: `ExecApprovalRequestEvent`, `ApplyPatchApprovalRequestEvent`
- Session management: `SessionConfiguredEvent`, `TokenCountEvent`
- Error/warning: `StreamErrorEvent`, `ErrorEvent`, `WarningEvent`, `DeprecationNoticeEvent`
- Advanced: `PlanDeltaEvent`, `TurnDiffEvent`, `ModelRerouteEvent`, `RateLimitSnapshot`

### Layer Boundary

The agent loop in `core` consumes `ResponseStream` (from `codex-api`) and produces `Event`s (from `codex-protocol`). The boundary is enforced by the crate system:
- `codex-api` (L0): Streaming, error classification
- `core` (L1+): Session management, tool routing, submission processing
- `codex-protocol` (shared): Event/Op types, message models

---

## pi-agent Analysis

### Architecture

pi-agent has the cleanest and most minimal agent loop implementation, contained entirely in `packages/agent/src/agent-loop.ts` (~418 lines). The loop is a pure function that takes configuration and returns an `EventStream<AgentEvent, AgentMessage[]>`.

**Entry points**:
```typescript
function agentLoop(
    prompts: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>;

function agentLoopContinue(
    context: AgentContext,
    config: AgentLoopConfig,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>;
```

`agentLoop()` starts a new conversation turn; `agentLoopContinue()` resumes from existing context (for retries or continuation after external events).

### Loop Structure

The loop has a clear two-level structure:

```
Outer loop: follow-up messages (user sends more while agent is idle)
  Inner loop: tool calls + steering
    1. Process pending steering messages
    2. Stream assistant response from LLM
    3. If error/aborted → emit turn_end, agent_end, return
    4. If tool calls → execute tools, check steering between each
    5. Emit turn_end
    6. Check for more steering/follow-up messages
```

**`runLoop()`** implementation (core logic):

```typescript
async function runLoop(currentContext, newMessages, config, signal, stream, streamFn) {
    let firstTurn = true;
    let pendingMessages = await config.getSteeringMessages?.() || [];

    // Outer loop: follow-up messages
    while (true) {
        let hasMoreToolCalls = true;
        let steeringAfterTools = null;

        // Inner loop: tool calls + steering
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            if (!firstTurn) stream.push({ type: "turn_start" });
            else firstTurn = false;

            // Inject pending steering messages
            if (pendingMessages.length > 0) { /* push to context */ }

            // Stream LLM response
            const message = await streamAssistantResponse(context, config, signal, stream, streamFn);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                // Exit on error
                return;
            }

            // Execute tool calls
            const toolCalls = message.content.filter(c => c.type === "toolCall");
            hasMoreToolCalls = toolCalls.length > 0;
            if (hasMoreToolCalls) {
                const toolExecution = await executeToolCalls(tools, message, signal, stream, getSteeringMessages);
                // steeringAfterTools may contain user interruptions
            }

            stream.push({ type: "turn_end", message, toolResults });
        }

        // Check for follow-up messages
        const followUp = await config.getFollowUpMessages?.() || [];
        if (followUp.length > 0) { pendingMessages = followUp; continue; }
        break;
    }

    stream.push({ type: "agent_end", messages: newMessages });
    stream.end(newMessages);
}
```

### Configuration: AgentLoopConfig

The loop is configured via `AgentLoopConfig`, which extends `SimpleStreamOptions`:

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
    model: Model<any>;
    convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    getApiKey?: (provider: string) => Promise<string | undefined>;
    getSteeringMessages?: () => Promise<AgentMessage[]>;
    getFollowUpMessages?: () => Promise<AgentMessage[]>;
}
```

Key callbacks:
- **`convertToLlm`**: Transforms `AgentMessage[]` (app-level) to `Message[]` (LLM-level) at the call boundary. This is the key abstraction that allows custom message types.
- **`transformContext`**: Pre-processing hook for context window management (pruning, injection).
- **`getSteeringMessages`**: Called between tool executions to check for user interruptions.
- **`getFollowUpMessages`**: Called when the agent would stop, allowing queued messages to continue the loop.

### Message Model

pi-agent uses a union of LLM messages plus custom app messages:

```typescript
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}

interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api; provider: Provider; model: string;
    usage: Usage; stopReason: StopReason;
    timestamp: number;
}

interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string; toolName: string;
    content: (TextContent | ImageContent)[];
    isError: boolean;
    timestamp: number;
}
```

The `CustomAgentMessages` interface enables extension via declaration merging -- apps can add custom message types without modifying the core library.

### Agent Events

The agent loop emits 12 event types via `EventStream<AgentEvent, AgentMessage[]>`:

```typescript
type AgentEvent =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: AgentMessage[] }
    | { type: "turn_start" }
    | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
    | { type: "message_start"; message: AgentMessage }
    | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
    | { type: "message_end"; message: AgentMessage }
    | { type: "tool_execution_start"; toolCallId; toolName; args }
    | { type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
    | { type: "tool_execution_end"; toolCallId; toolName; result; isError };
```

Three lifecycle levels:
1. **Agent lifecycle**: `agent_start`, `agent_end`
2. **Turn lifecycle**: `turn_start`, `turn_end` (a turn = one LLM response + tool executions)
3. **Message/tool lifecycle**: `message_start/update/end`, `tool_execution_start/update/end`

### LLM Call: streamAssistantResponse

The `streamAssistantResponse()` function bridges L0 and L1:

1. Apply `transformContext` (optional context pre-processing)
2. Call `convertToLlm` (AgentMessage[] to Message[])
3. Build `Context` (systemPrompt, messages, tools)
4. Call `streamFunction(model, context, options)` -- returns `AssistantMessageEventStream`
5. Iterate events, mapping L0 events to L1 events:
   - `start` -> push to context, emit `message_start`
   - `text_delta/end`, `thinking_*`, `toolcall_*` -> update context message, emit `message_update`
   - `done`/`error` -> finalize message, emit `message_end`

### Tool Execution

Tools are executed **sequentially** in `executeToolCalls()`:

```typescript
for (let index = 0; index < toolCalls.length; index++) {
    const tool = tools?.find(t => t.name === toolCall.name);

    stream.push({ type: "tool_execution_start", ... });
    result = await tool.execute(toolCall.id, validatedArgs, signal, onUpdate);
    stream.push({ type: "tool_execution_end", ... });

    // Check for steering between tools
    if (getSteeringMessages) {
        const steering = await getSteeringMessages();
        if (steering.length > 0) {
            // Skip remaining tools
            for (const skipped of remainingCalls) {
                results.push(skipToolCall(skipped, stream));
            }
            break;
        }
    }
}
```

Key details:
- Sequential execution with steering checks between each tool
- Skipped tools get a "Skipped due to queued user message" result (not silently dropped)
- Tool progress via `onUpdate` callback
- Argument validation via `validateToolArguments(tool, toolCall)`

### Cancellation

Uses `AbortSignal` passed through the entire stack:
- `agentLoop()` accepts `signal?: AbortSignal`
- Signal passed to `streamFunction()` for provider-level cancellation
- Signal passed to `tool.execute()` for tool-level cancellation

Hard cancellation (abort signal) vs soft interruption (steering messages) are two separate mechanisms:
- **Abort**: Immediately cancels the current operation
- **Steering**: Queued messages checked between tool executions; remaining tools skipped

### Layer Boundary

The boundary is sharp: `agent-loop.ts` imports from `@mariozechner/pi-ai` (the L0 package) for `streamSimple`, `EventStream`, `Context`, and message types. It does NOT import HTTP clients, SDK types, or transport code. The loop operates entirely at the semantic level of messages, events, and tool calls.

---

## opencode Analysis

### Architecture

opencode's agent loop is distributed across several files in `src/session/`:
- **`prompt.ts`** (~1960 lines) -- Entry point, user message creation, main loop, tool resolution
- **`processor.ts`** (~421 lines) -- Stream processing, tool call lifecycle, doom loop detection
- **`llm.ts`** (~279 lines) -- LLM call wrapper around AI SDK's `streamText`
- **`retry.ts`** (~101 lines) -- Retry delay calculation and retryable classification
- **`status.ts`** (~76 lines) -- Session status (idle/retry/busy) with bus events

Unlike pi-agent's single-file loop, opencode distributes responsibilities across multiple files with significant complexity.

### Main Loop: SessionPrompt.loop()

The main loop in `prompt.ts` is a `while(true)` loop that:

1. Checks for abort
2. Loads message history (with compaction filtering)
3. Finds last user/assistant messages
4. Checks if processing should stop (assistant finished, no pending work)
5. Resolves model and agent
6. Handles special cases: subtasks, compaction, context overflow
7. Creates `SessionProcessor` for normal LLM processing
8. Resolves tools
9. Calls `processor.process()` which streams the LLM response
10. Routes the result: `"continue"` loops, `"stop"` exits, `"compact"` triggers compaction

```typescript
export const loop = fn(LoopInput, async (input) => {
    const abort = resume_existing ? resume(sessionID) : start(sessionID);
    let step = 0;
    while (true) {
        SessionStatus.set(sessionID, { type: "busy" });
        if (abort.aborted) break;
        let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID));

        // Find last user/assistant messages
        // Check exit conditions
        // Resolve model, agent
        // Handle subtasks, compaction

        // Normal processing
        const processor = SessionProcessor.create({ ... });
        const tools = await resolveTools({ ... });
        const result = await processor.process({ ... });

        if (result === "stop") break;
        if (result === "compact") {
            await SessionCompaction.create({ ... });
        }
    }
});
```

### Stream Processing: SessionProcessor

`SessionProcessor.create()` returns an object with a `process()` method that:

1. Calls `LLM.stream()` to get an AI SDK stream
2. Iterates `stream.fullStream` events
3. Creates and updates message parts (reasoning, text, tool) in the database
4. Handles doom loop detection
5. Manages retry on error
6. Returns `"continue"` | `"stop"` | `"compact"`

The processing loop handles 15+ event types from the AI SDK:

```typescript
for await (const value of stream.fullStream) {
    input.abort.throwIfAborted();
    switch (value.type) {
        case "start": /* set status busy */
        case "reasoning-start": /* create reasoning part */
        case "reasoning-delta": /* update reasoning part delta */
        case "reasoning-end": /* finalize reasoning part */
        case "tool-input-start": /* create tool part (pending) */
        case "tool-call": /* update tool part (running), doom loop check */
        case "tool-result": /* update tool part (completed) */
        case "tool-error": /* update tool part (error) */
        case "text-start": /* create text part */
        case "text-delta": /* update text part delta */
        case "text-end": /* finalize text part */
        case "start-step": /* snapshot tracking */
        case "finish-step": /* usage, cost, compaction check */
        case "error": /* throw for retry handling */
    }
}
```

### Message Model: Part-Based

opencode uses a **separate message + parts** model (unlike pi-agent's inline content):

```typescript
// Message types
type MessageV2.Info = MessageV2.User | MessageV2.Assistant

// Parts (stored separately, linked by messageID)
type MessageV2.Part =
    | TextPart      // text content
    | ReasoningPart // thinking/reasoning content
    | ToolPart      // tool call with state machine (pending → running → completed/error)
    | FilePart      // file attachments
    | StepStartPart // LLM step lifecycle
    | StepFinishPart // with usage data
    | PatchPart     // file change snapshots
    | CompactionPart // compaction markers
    | SubtaskPart   // sub-agent task
    | AgentPart     // agent invocation

// WithParts combines message info and its parts
interface WithParts { info: MessageV2.Info; parts: MessageV2.Part[] }
```

Tool parts have a state machine:
```typescript
state: { status: "pending", input: {} }
     → { status: "running", input, time: { start } }
     → { status: "completed", input, output, metadata, title, time: { start, end } }
     → { status: "error", input, error, time: { start, end } }
```

### Doom Loop Detection

The processor checks for doom loops by examining the last N tool calls:

```typescript
const DOOM_LOOP_THRESHOLD = 3;

const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD);
if (
    lastThree.length === DOOM_LOOP_THRESHOLD &&
    lastThree.every(p =>
        p.type === "tool" &&
        p.tool === value.toolName &&
        p.state.status !== "pending" &&
        JSON.stringify(p.state.input) === JSON.stringify(value.input)
    )
) {
    // Ask for permission to continue (doom_loop permission)
    await PermissionNext.ask({ permission: "doom_loop", ... });
}
```

This detects when the same tool is called 3+ times with identical input and prompts the user for confirmation.

### Retry Orchestration

Retry logic is split between `processor.ts` and `retry.ts`:

**In processor (catch block)**:
```typescript
catch (e) {
    const error = MessageV2.fromError(e, { providerID });
    if (MessageV2.ContextOverflowError.isInstance(error)) {
        // TODO: Handle context overflow
    }
    const retry = SessionRetry.retryable(error);
    if (retry !== undefined) {
        attempt++;
        const delay = SessionRetry.delay(attempt, error);
        SessionStatus.set(sessionID, { type: "retry", attempt, message: retry, next: Date.now() + delay });
        await SessionRetry.sleep(delay, input.abort);
        continue;  // Retry the while(true) loop
    }
    // Non-retryable: set error on message, publish error event
    input.assistantMessage.error = error;
    Bus.publish(Session.Event.Error, { ... });
}
```

**In retry.ts**:
```typescript
// Delay calculation
function delay(attempt, error?) {
    // Check retry-after-ms header
    // Check retry-after header (seconds or HTTP date)
    // Fallback: RETRY_INITIAL_DELAY * 2^(attempt-1)
    // Cap at RETRY_MAX_DELAY_NO_HEADERS (30s) when no headers
}

// Retryable classification
function retryable(error) {
    if (ContextOverflowError) return undefined;  // Not retryable
    if (APIError && isRetryable) return message;
    if (FreeUsageLimitError) return special message;
    // Parse JSON error bodies for rate limit, overloaded patterns
}
```

### Cancellation

Uses `AbortController`/`AbortSignal`:

```typescript
// In SessionPrompt state
state: Record<string, {
    abort: AbortController;
    callbacks: { resolve, reject }[];
}>

function start(sessionID) {
    const controller = new AbortController();
    state[sessionID] = { abort: controller, callbacks: [] };
    return controller.signal;
}

function cancel(sessionID) {
    state[sessionID].abort.abort();
    delete state[sessionID];
    SessionStatus.set(sessionID, { type: "idle" });
}
```

The abort signal propagates to:
- `LLM.stream()` via `abortSignal` parameter on `streamText()`
- `SessionRetry.sleep()` for interruptible retry waits
- `input.abort.throwIfAborted()` checked on each stream event

### Session Status

Status is tracked via a bus-based event system:

```typescript
type SessionStatus.Info =
    | { type: "idle" }
    | { type: "retry"; attempt: number; message: string; next: number }
    | { type: "busy" }
```

Status changes are published as events, allowing the TUI to show retry countdowns and busy indicators.

### Busy Guard

opencode prevents concurrent prompts on the same session:

```typescript
function assertNotBusy(sessionID) {
    if (state[sessionID]) throw new Session.BusyError(sessionID);
}
```

This is simpler than codex-rs's turn-aware steering but prevents data corruption from concurrent access.

### Tool Execution

Tools are executed by the AI SDK itself (tool functions are passed to `streamText()`). The processor observes tool lifecycle through stream events (`tool-call`, `tool-result`, `tool-error`). This means tool execution is integrated into the AI SDK's step processing rather than being orchestrated by the agent loop directly.

The processor includes a tool call repair mechanism:
```typescript
async experimental_repairToolCall(failed) {
    const lower = failed.toolCall.toolName.toLowerCase();
    if (lower !== failed.toolCall.toolName && tools[lower]) {
        return { ...failed.toolCall, toolName: lower };  // Case-insensitive fix
    }
    return { ...failed.toolCall, toolName: "invalid" };  // Route to error tool
}
```

### Layer Boundary

The boundary between provider and loop is blurry. `LLM.stream()` in `session/llm.ts` directly calls AI SDK's `streamText()`, mixing provider configuration (model resolution, transforms, headers) with loop-level concerns (system prompt construction, tool resolution). The processor iterates AI SDK stream events directly rather than through a normalized event type.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Loop Pattern** | Channel-based `submission_loop` (tokio task) | Functional `runLoop()` with nested while-loops | `SessionPrompt.loop()` while-true with processor |
| **Loop Size** | Massive (codex.rs ~2000+ lines) | Compact (~418 lines, one file) | Distributed (~2700 lines across 5 files) |
| **Entry Point** | `Codex::spawn()` → tokio task | `agentLoop()` / `agentLoopContinue()` → EventStream | `SessionPrompt.prompt()` → `loop()` |
| **Return Type** | Events via channel | `EventStream<AgentEvent, AgentMessage[]>` | `MessageV2.WithParts` (promise) |
| **Message Model** | `ResponseItem` (OpenAI format) | `Message` union (User/Assistant/ToolResult) with inline content | `MessageV2.Info` + separate `Part[]` with state machines |
| **Custom Messages** | Via protocol types | `CustomAgentMessages` (declaration merging) | Part types (TextPart, FilePart, AgentPart, SubtaskPart) |
| **Agent Events** | 40+ event types | 12 event types | Bus events (no unified event type) |
| **Event Delivery** | Async channel (`Receiver<Event>`) | `EventStream<AgentEvent>` (async iterable) | `Bus.publish()` (pub-sub) |
| **Turn Model** | `TurnContext` (immutable) + `ActiveTurn` | Implicit (inner loop iteration) | Step counter + message ordering |
| **State Separation** | `TurnContext` (immutable) vs `SessionState` (mutable) | `AgentContext` (mixed) with `AgentState` for UI | Message DB (parts table) |
| **Tool Execution** | Parallel via `ToolCallRuntime` + RwLock | Sequential with steering between each | AI SDK manages execution via stream events |
| **Steering** | `steer_input()` on Session | `getSteeringMessages()` callback between tools | Not supported (abort only) |
| **Follow-up** | Via `Op` submission | `getFollowUpMessages()` callback | Via new `prompt()` call |
| **Cancellation** | `CancellationToken` | `AbortSignal` | `AbortController`/`AbortSignal` |
| **Retry Location** | In session loop | External (caller handles) | In `SessionProcessor.process()` catch block |
| **Retry Strategy** | `backoff` utility | Not in agent loop | Exponential backoff + retry-after headers |
| **Doom Loop** | Not observed in agent loop | Not implemented | 3 identical tool calls triggers permission check |
| **Context Overflow** | Triggers compaction (local or remote) | Via `transformContext` hook | Processor returns `"compact"`, loop creates compaction |
| **Busy Guard** | Turn-aware (`ActiveTurn`) | Not needed (functional) | `assertNotBusy()` throws `BusyError` |
| **LLM Call Bridge** | Consumes `ResponseStream` from codex-api | Calls `streamSimple()`, iterates `AssistantMessageEventStream` | Calls AI SDK `streamText()`, iterates `fullStream` |

---

## Synthesis

### Loop Architecture Patterns

The three projects represent three fundamentally different approaches to structuring the agent loop:

1. **codex-rs: Actor/Channel model.** The loop runs as a persistent background task consuming operations from a bounded channel. This supports concurrent operation (UI can submit while agent is working), enables steering, and naturally handles backpressure. The cost is complexity: the `codex.rs` file is 2000+ lines with 200+ imports.

2. **pi-agent: Functional/Stream model.** The loop is a pure function returning an `EventStream`. No background task, no channels, no mutable global state. The caller drives interaction through callbacks (`getSteeringMessages`, `getFollowUpMessages`). This is the simplest and most testable approach.

3. **opencode: Stateful/DB model.** The loop reads message history from the database on each iteration, creates processors for each step, and persists results immediately. The loop is interruptible (abort controller) and resumable (can resume from DB state). This supports crash recovery but creates tight coupling to the persistence layer.

**Recommendation for Diligent**: Start with pi-agent's functional model. It is the simplest to implement, easiest to test, and cleanest in terms of separation of concerns. The callbacks for steering and follow-up provide all the extensibility needed without the complexity of channels or DB-driven loops.

### Event Model: How Many Events?

The three projects span a wide range:
- codex-rs: 40+ event types (very fine-grained)
- pi-agent: 12 event types (three lifecycle levels)
- opencode: No unified event type (bus-based pub-sub)

pi-agent's 12 events cover all essential UI needs:
- Agent lifecycle (2): agent_start, agent_end
- Turn lifecycle (2): turn_start, turn_end
- Message lifecycle (3): message_start, message_update, message_end
- Tool lifecycle (3): tool_execution_start, tool_execution_update, tool_execution_end

Missing from pi-agent that might be needed:
- **Retry status events** (opencode's `SessionStatus` with retry attempt/countdown)
- **Token/cost events** (codex-rs's `TokenCountEvent`)
- **Error events** as separate from message errors

**Recommendation**: Start with pi-agent's 12 + add 2-3: `retry_status`, `token_usage`, `error`. Total: ~15 events.

### Message Model: Inline vs Part-Based

- **pi-agent**: Messages carry content inline. Simple, good for in-memory operation.
- **opencode**: Messages + separate parts with state machines. Complex but enables granular persistence, streaming part updates, and rich tool call lifecycle tracking.

The part-based model is needed for:
- Streaming delta updates to the UI
- Tool call state machines (pending → running → completed)
- Crash recovery (parts persisted independently)
- Snapshot tracking (step-start/step-finish with git snapshots)

For MVP, inline content (pi-agent style) is sufficient. The part-based model can be introduced when session persistence (L6) needs granular state tracking.

### Steering: The Key Differentiator

pi-agent's steering design is elegant and worth adopting:

```typescript
// Called between tool executions
getSteeringMessages?: () => Promise<AgentMessage[]>;

// If steering messages exist, skip remaining tools
if (steering.length > 0) {
    steeringMessages = steering;
    for (const skipped of remainingCalls) {
        results.push(skipToolCall(skipped, stream));  // Not silently dropped
    }
    break;
}
```

Key insights:
1. Steering is checked between tool executions (natural breakpoint)
2. Skipped tools get explicit "skipped" results (LLM sees them)
3. Steering messages are injected into context before next LLM call
4. Separate from abort (steering redirects, abort cancels)

### Retry: Where Should It Live?

- **codex-rs**: In the session loop (L1)
- **pi-agent**: External (caller decides, not in agent loop)
- **opencode**: In the processor, inside the main loop

pi-agent's approach (retry external to the loop) is the cleanest separation, but it means every caller must implement retry. opencode's approach (retry inside the processor) keeps retry contained but mixes it with stream processing.

**Recommendation**: Retry orchestration belongs in L1, but as a wrapper around the core loop, not mixed into it. The loop function itself should be retry-agnostic; a `withRetry()` wrapper can add retry behavior.

### Existing Decision Validation

**D004 (Op/Event pattern, ~10-15 events)**: **Confirmed and refined.** pi-agent's 12 events + 2-3 additions gives ~15. codex-rs's 40+ is too granular for MVP. The event types should follow pi-agent's three-level lifecycle model.

**D005 (Unified messages, not part-based)**: **Confirmed for MVP.** pi-agent's inline content model is simpler and sufficient. Part-based model (opencode) is powerful but premature. Can be introduced in L6 if session persistence needs it.

**D008 (Immutable TurnContext + mutable SessionState)**: **Confirmed.** codex-rs demonstrates this clearly with `TurnContext` (~30 immutable fields) vs `SessionState` (behind Mutex). pi-agent's `AgentContext` mixes these, which is simpler but less rigorous. For Diligent, a lightweight version: immutable `TurnConfig` (model, tools, policies) + mutable `SessionContext` (messages, settings).

**D009 (AbortController-based cancellation)**: **Confirmed.** Both TypeScript projects use `AbortController`/`AbortSignal`. codex-rs uses `CancellationToken` (Rust equivalent). Add soft steering via `getSteeringMessages` callback (pi-agent pattern).

**D010 (Exponential backoff retry)**: **Confirmed.** opencode's implementation is the reference: exponential backoff with `retry-after`/`retry-after-ms` header support, cap at 30s without headers. Context overflow triggers compaction, not retry. Max attempts configurable.

**D011 (Deferred decisions)**:
- **Doom loop detection**: Now resolved. opencode's approach (3 identical tool calls → permission check) is practical. Adopt it.
- **Steering/soft interruption**: Now resolved. pi-agent's `getSteeringMessages()` callback is the right pattern.
- **Auto-compaction**: Still deferred to L6.

---

## Open Questions

### Q1: Should the agent loop be a function or a class?

pi-agent: Pure function returning EventStream. Simplest, most testable.
codex-rs: Session class with submission_loop. Supports persistent state.
opencode: Namespace with stateful closures. Middle ground.

Functions are simpler but make state management harder for long-running sessions. A lightweight class wrapping the loop function could provide the best of both worlds.

### Q2: How to handle multi-step tool execution?

opencode tracks tool state machines (pending → running → completed/error) with the AI SDK managing multi-step execution. pi-agent handles one LLM call per inner loop iteration with explicit tool execution between calls.

For Diligent, should the loop manage tool execution directly (pi-agent) or delegate to a framework that handles multi-step tool invocation?

### Q3: Where does context window management live?

- pi-agent: `transformContext` callback (L1 hooks into it, implementation in higher layer)
- opencode: `SessionCompaction` (separate module, triggered by processor)
- codex-rs: Compaction modules in core

The question is whether context management is L1's responsibility (it knows the token budget) or L6's responsibility (it manages message history). The hook approach (pi-agent) is the most flexible -- L1 provides the hook, higher layers implement the strategy.

### Q4: EventStream for both L0 and L1?

pi-agent uses `EventStream` for both:
- L0: `AssistantMessageEventStream` (provider events)
- L1: `EventStream<AgentEvent, AgentMessage[]>` (agent events)

Should Diligent use the same `EventStream` primitive at both layers with different event types? This would give a uniform streaming model throughout the stack but means the L1 event type must be a superset of (or wrap) L0 events.

### Q5: Should the loop handle follow-up messages?

pi-agent's `getFollowUpMessages()` enables the loop to continue after the LLM would stop (e.g., user typed a new message while the agent was finishing). This is a nice UX feature but adds complexity.

codex-rs handles this via the submission channel (new `Op` submitted). opencode handles it via new `prompt()` calls.

Should Diligent implement pi-agent's follow-up pattern or use a simpler new-prompt approach?

---

## Decision Refinements

### D004 Refinement: Event Type Catalog

Based on pi-agent's proven set plus gaps identified from codex-rs and opencode:

```typescript
type AgentEvent =
    // Agent lifecycle
    | { type: "agent_start" }
    | { type: "agent_end"; messages: Message[] }
    // Turn lifecycle
    | { type: "turn_start"; turnId: string }
    | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
    // Message lifecycle
    | { type: "message_start"; message: Message }
    | { type: "message_update"; message: Message; event: ProviderEvent }
    | { type: "message_end"; message: Message }
    // Tool lifecycle
    | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
    | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
    | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
    // Status (from opencode's SessionStatus)
    | { type: "status_change"; status: "idle" | "busy" | "retry"; retry?: { attempt: number; next: number } }
    // Usage (from codex-rs's TokenCountEvent)
    | { type: "usage"; tokens: TokenUsage; cost: number }
    // Error (separate from message errors for fatal/session-level errors)
    | { type: "error"; error: Error; fatal: boolean }
```

Total: 15 event types. Expandable without breaking existing consumers.

### D008 Refinement: State Shape

```typescript
interface TurnConfig {
    readonly model: Model;
    readonly tools: Tool[];
    readonly systemPrompt: string;
    readonly policies: { approval: ApprovalPolicy; sandbox: SandboxPolicy };
    readonly signal: AbortSignal;
}

interface SessionContext {
    messages: Message[];
    settings: SessionSettings;  // model preferences, etc.
    status: "idle" | "busy" | "retry";
}
```

### D011 Resolution: Doom Loop Detection

Adopt opencode's pattern: track the last N tool calls. If the same tool is called N times with identical input, trigger a permission check (or a warning event). Default threshold: 3.

### D011 Resolution: Steering

Adopt pi-agent's `getSteeringMessages()` callback pattern. The loop checks for steering messages between tool executions. If messages are found, remaining tool calls are skipped with explicit skip results.

### New: Loop Function Signature

```typescript
function agentLoop(
    input: { messages: Message[]; prompt?: Message },
    config: AgentLoopConfig,
): EventStream<AgentEvent, Message[]>;
```

Where `AgentLoopConfig` includes:
- `model: Model`
- `tools: Tool[]`
- `systemPrompt: string`
- `signal?: AbortSignal`
- `convertToLlm?: (messages: Message[]) => LLMMessage[]`
- `transformContext?: (messages: Message[]) => Promise<Message[]>`
- `getSteeringMessages?: () => Promise<Message[]>`
- `getFollowUpMessages?: () => Promise<Message[]>`
- `streamFn?: StreamFunction`

The loop returns an `EventStream<AgentEvent, Message[]>` where the final result is the complete list of new messages from the interaction.
