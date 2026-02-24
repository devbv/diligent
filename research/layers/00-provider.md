# L0: Provider Layer Research

## Problem Definition

The Provider layer is the lowest-level abstraction in a coding agent: it handles LLM provider communication, streaming response delivery, API client management, token counting, and error classification. This layer must be cleanly separated from the Agent Loop (L1) so that provider-specific concerns (authentication, transport, response parsing, rate limits) do not leak into orchestration logic.

### Key Questions

1. How does each project separate the provider/streaming concern from the agent loop?
2. What abstractions exist for multi-provider support?
3. How are streaming responses delivered to consumers?
4. How are errors classified (retryable vs fatal, context overflow vs rate limit)?
5. How is token usage tracked and cost calculated?
6. What transport mechanisms are supported (SSE, WebSocket, SDK)?
7. How are provider-specific quirks handled without polluting the core interface?

### Layer Scope

- LLM provider abstraction and registry
- API client construction (auth, headers, base URL)
- Streaming response delivery (the streaming primitive itself)
- Token counting and cost calculation
- Error classification (retryable, overflow, rate limit)
- Rate limit header parsing
- Provider-specific transforms and compatibility shims

### Boundary: What Is NOT in This Layer

- Conversation loop logic (L1: Agent Loop)
- Tool execution and dispatch (L2: Tool System)
- Message history management (L1)
- Retry orchestration (L1 -- the loop decides when to retry; L0 classifies errors)
- Session persistence (L6)

---

## codex-rs Analysis

### Architecture

codex-rs isolates the provider layer in the `codex-api` crate, completely separate from the agent loop in `core`. The crate boundary enforces a hard separation: `codex-api` knows nothing about tools, sessions, or conversation orchestration.

**Module structure** (`codex-api/src/lib.rs`):
- `auth` -- Authentication providers
- `common` -- Core types: `ResponseEvent`, `ResponseStream`, `ResponsesApiRequest`
- `endpoint/responses` -- SSE-based HTTP streaming client
- `endpoint/responses_websocket` -- WebSocket streaming client
- `error` -- `ApiError` enum with fine-grained classification
- `provider` -- `Provider` struct (endpoint config, retry config)
- `rate_limits` -- Header-based rate limit parsing
- `sse` -- SSE event parsing and stream processing

### Key Types

**`Provider`** (provider.rs) -- Endpoint configuration, not a trait:
```rust
pub struct Provider {
    pub name: String,
    pub base_url: String,
    pub query_params: Option<HashMap<String, String>>,
    pub headers: HeaderMap,
    pub retry: RetryConfig,
    pub stream_idle_timeout: Duration,
}
```

This is a data struct with helper methods (`url_for_path`, `build_request`, `websocket_url_for_path`). It is NOT a trait/interface -- there is no polymorphic dispatch over providers. Instead, all providers use the same OpenAI Responses API wire format, and the `Provider` struct configures the endpoint.

**`RetryConfig`** -- Provider-level retry policy:
```rust
pub struct RetryConfig {
    pub max_attempts: u64,
    pub base_delay: Duration,
    pub retry_429: bool,
    pub retry_5xx: bool,
    pub retry_transport: bool,
}
```

**`ResponseEvent`** (common.rs) -- The streaming event enum:
```rust
pub enum ResponseEvent {
    Created,
    OutputItemDone(ResponseItem),
    OutputItemAdded(ResponseItem),
    ServerModel(String),
    ServerReasoningIncluded(bool),
    Completed { response_id, token_usage, can_append },
    OutputTextDelta(String),
    ReasoningContentDelta { delta, content_index },
    ReasoningSummaryDelta { delta, summary_index },
    ReasoningSummaryPartAdded { summary_index },
    RateLimits(RateLimitSnapshot),
    ModelsEtag(String),
}
```

**`ResponseStream`** -- A thin wrapper around `mpsc::Receiver<Result<ResponseEvent, ApiError>>` implementing the `Stream` trait. The producer (SSE parser or WebSocket handler) pushes events through an mpsc channel; the consumer (agent loop) reads via async `Stream`.

**`ResponsesApiRequest`** -- The request payload, closely mirroring the OpenAI Responses API schema.

### Streaming Architecture

codex-rs supports two transports, both producing the same `ResponseStream`:

1. **SSE (Server-Sent Events)** via `ResponsesClient::stream_request()`:
   - Sends HTTP POST, receives SSE event stream
   - `spawn_response_stream()` creates mpsc channel, spawns tokio task
   - `process_sse()` loop reads SSE events with idle timeout detection
   - `process_responses_event()` maps SSE event type strings to `ResponseEvent` variants

2. **WebSocket** via `ResponsesWebsocketClient`:
   - `connect()` establishes WebSocket with permessage-deflate compression
   - `WsStream` wraps the connection with a command channel for sending requests
   - `stream_request()` sends `ResponsesWsRequest` and returns `ResponseStream`
   - Supports `response.create` and `response.append` (multi-turn on same connection)
   - Idle timeout per-stream, connection reuse across turns

Both transports produce `ResponseStream` (mpsc-based), making the transport choice invisible to the consumer.

### Error Classification

`ApiError` enum (error.rs) provides fine-grained error types:
```rust
pub enum ApiError {
    Transport(TransportError),
    Api(ApiErrorResponse),
    Stream(StreamError),
    ContextWindowExceeded(ContextWindowExceededError),
    QuotaExceeded(QuotaExceededError),
    UsageNotIncluded,
    Retryable { message, delay },
    RateLimit(RateLimitError),
    InvalidRequest(InvalidRequestError),
    ServerOverloaded,
}
```

The SSE parser (`sse/responses.rs`) classifies errors during stream processing:
- Error response bodies are parsed for `context_window_exceeded`, `server_error`, `rate_limit_exceeded`
- `retry-after` headers are parsed from error message text (not HTTP headers, since SSE is a single long-lived response)
- Idle timeout produces `Stream` error

### Token Counting and Cost

Token usage comes from the `Completed` event's `token_usage: Option<TokenUsage>` field. `TokenUsage` is defined in `codex-protocol` (not in codex-api) and includes input/output token counts. Cost calculation happens at a higher layer -- the provider layer only delivers raw token counts.

### Rate Limit Handling

`rate_limits.rs` parses rate limit info from:
- HTTP headers: `x-codex-*` prefixed headers (custom format)
- WebSocket events: rate limit events in the WebSocket stream

Parsed into `RateLimitSnapshot` (defined in codex-protocol) for consumption by higher layers.

### Layer Boundary

The boundary is extremely clean: the `codex-api` crate exposes `ResponseStream` and `ResponseEvent`. The `core` crate consumes these without knowing about SSE, WebSocket, or HTTP details. The agent loop in `core` only interacts with:
- `Provider` struct (to configure endpoint)
- `ResponsesClient` or `ResponsesWebsocketClient` (to initiate streams)
- `ResponseStream` (to consume events)
- `ApiError` (to classify failures)

---

## pi-agent Analysis

### Architecture

pi-agent separates the provider layer into the `packages/ai` package, completely independent of the agent loop in `packages/agent`. The `ai` package exports:
- `stream()` and `complete()` -- Full streaming/completion entry points
- `streamSimple()` and `completeSimple()` -- Simplified wrappers with reasoning level
- `EventStream` / `AssistantMessageEventStream` -- The streaming primitive
- `registerApiProvider()` / `getApiProvider()` -- Provider registry
- Type definitions: `Model`, `Context`, `Usage`, `AssistantMessageEvent`, `StreamFunction`, `Tool`

### Key Types

**`Model<TApi>`** -- Rich model descriptor:
```typescript
interface Model<TApi extends Api> {
    id: string;
    name: string;
    api: TApi;              // "anthropic-messages", "openai-responses", etc.
    provider: Provider;     // "anthropic", "openai", etc.
    baseUrl: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input, output, cacheRead, cacheWrite };  // $/million tokens
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}
```

The `Model` type carries ALL provider-specific configuration: base URL, cost rates, compatibility settings. This means the consumer (agent loop) passes a `Model` to the streaming function and gets back a uniform event stream.

**`StreamFunction<TApi, TOptions>`** -- The provider contract:
```typescript
type StreamFunction<TApi, TOptions> = (
    model: Model<TApi>,
    context: Context,
    options?: TOptions,
) => AssistantMessageEventStream;
```

Each provider implements this signature. The function is synchronous (returns the stream immediately), and the async work happens internally via a spawned async IIFE.

**`StreamOptions`** -- Shared options across all providers:
```typescript
interface StreamOptions {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    transport?: "sse" | "websocket" | "auto";
    cacheRetention?: "none" | "short" | "long";
    sessionId?: string;
    maxRetryDelayMs?: number;
    metadata?: Record<string, unknown>;
    headers?: Record<string, string>;
}
```

**`AssistantMessageEvent`** -- The streaming event discriminated union:
```typescript
type AssistantMessageEvent =
    | { type: "start"; partial: AssistantMessage }
    | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
    | { type: "done"; reason: StopReason; message: AssistantMessage }
    | { type: "error"; reason: StopReason; error: AssistantMessage };
```

12 event types covering: start, text (start/delta/end), thinking (start/delta/end), tool call (start/delta/end), done, error. Each delta event carries the full `partial` AssistantMessage (progressively built up).

### Streaming Primitive: EventStream

The core streaming abstraction is `EventStream<T, R>` (~88 lines):

```typescript
class EventStream<T, R = T> implements AsyncIterable<T> {
    private queue: T[] = [];
    private waiting: ((value: IteratorResult<T>) => void)[] = [];
    private done = false;
    private finalResultPromise: Promise<R>;

    constructor(
        private isComplete: (event: T) => boolean,
        private extractResult: (event: T) => R,
    );

    push(event: T): void;       // Producer pushes events
    end(result?: R): void;      // Signal completion
    result(): Promise<R>;       // Get final result after stream ends
    [Symbol.asyncIterator]();   // Consumer iterates with for-await
}
```

`AssistantMessageEventStream` extends this with done/error completion detection:
```typescript
class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
    constructor() {
        super(
            (event) => event.type === "done" || event.type === "error",
            (event) => event.type === "done" ? event.message : event.error,
        );
    }
}
```

This is an elegant push/pull bridge: the provider implementation pushes events (from SDK callbacks), and the consumer pulls via `for await`. The queue handles backpressure when the consumer is slower than the producer.

### Provider Registry

```typescript
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

interface ApiProvider<TApi, TOptions> {
    api: TApi;
    stream: StreamFunction<TApi, TOptions>;
    streamSimple: StreamSimpleFunction<TApi>;
}

function registerApiProvider<TApi, TOptions>(provider: ApiProvider<TApi, TOptions>): void;
function getApiProvider(api: string): RegisteredApiProvider;
```

Entry points `stream()` and `streamSimple()` resolve the provider via `getApiProvider(model.api)` and delegate to the provider's stream function. This is a clean registry pattern: providers register themselves at module load time, and the entry points do dynamic dispatch.

### Provider Implementation: Anthropic

The Anthropic provider (`providers/anthropic.ts`, ~852 lines) demonstrates the pattern:

1. Creates `AssistantMessageEventStream`
2. Spawns async IIFE that:
   - Constructs Anthropic SDK client with `new Anthropic({ apiKey, baseURL })`
   - Calls `client.messages.stream()` with converted messages/tools
   - Iterates SDK events, mapping to `AssistantMessageEvent` types
   - Builds up `partialMessage` progressively
   - Pushes events to the EventStream
   - Handles OAuth/Copilot token refresh
   - Calculates cost via `calculateCost()` using model's cost rates

### Error Handling

Errors are surfaced as `AssistantMessageEvent` of type `"error"` with the partial message. The provider layer does NOT classify errors as retryable/non-retryable -- that responsibility is left to the agent loop or higher layers. Some providers implement internal retry (e.g., the `maxRetryDelayMs` option caps server-requested retry delays).

### Token Counting and Cost

The `Usage` type is computed by each provider implementation:
```typescript
interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input, output, cacheRead, cacheWrite, total };
}
```

Cost calculation uses the `Model.cost` rates ($/million tokens). Each provider maps SDK-specific usage fields to this uniform structure. Cost is calculated INSIDE the provider layer (unlike codex-rs where it happens at a higher level).

### Provider-Specific Compatibility

The `OpenAICompletionsCompat` interface handles provider quirks:
```typescript
interface OpenAICompletionsCompat {
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresMistralToolIds?: boolean;
    thinkingFormat?: "openai" | "zai" | "qwen";
}
```

These are carried on the `Model` and checked within provider implementations. This keeps quirk handling localized without requiring separate provider classes for each variant.

### Layer Boundary

The `ai` package exports `stream()`, `streamSimple()`, and the `EventStream` type. The `agent` package imports these and iterates events without knowing about SDK clients, HTTP requests, or provider-specific message formats. The boundary is at the package level, enforced by the monorepo structure.

---

## opencode Analysis

### Architecture

opencode's provider layer lives in `src/provider/` with four main files:
- `provider.ts` (~1338 lines) -- Provider registry, model resolution, SDK instantiation
- `transform.ts` (~955 lines) -- Message normalization, caching, provider-specific transforms
- `error.ts` -- Error classification with overflow pattern matching
- `models.ts` -- External model metadata fetching from models.dev API

Unlike codex-rs and pi-agent, opencode is built on the **Vercel AI SDK** (`ai` package). The provider layer adapts AI SDK providers to opencode's needs rather than implementing streaming from scratch.

### Key Types

**`Provider.Model`** -- Zod-validated model descriptor:
```typescript
Provider.Model = z.object({
    id: z.string(),
    providerID: z.string(),
    api: z.object({ id: z.string(), name: z.string() }),
    capabilities: z.object({
        reasoning: z.boolean(),
        temperature: z.boolean(),
        // ...
    }),
    cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({ read: z.number(), write: z.number() }),
    }),
    limit: z.object({
        context: z.number(),
        output: z.number(),
    }),
    options: z.record(z.any()),
    headers: z.record(z.string()).optional(),
    variants: z.record(z.record(z.any())).optional(),
});
```

**`BUNDLED_PROVIDERS`** -- Static map of 20+ AI SDK provider packages:
```typescript
const BUNDLED_PROVIDERS: Record<string, string> = {
    anthropic: "@ai-sdk/anthropic",
    openai: "@ai-sdk/openai",
    google: "@ai-sdk/google-generative-ai",
    amazon: "@ai-sdk/amazon-bedrock",
    // ... 20+ more
}
```

**`CUSTOM_LOADERS`** -- Provider-specific initialization functions:
Each entry is an async function that creates an AI SDK provider instance with the correct configuration (API key, base URL, compatibility settings). Examples:
- Anthropic: Sets `cacheControl: true`, applies thinking headers
- OpenAI: Handles Codex OAuth, compatibility options
- Azure: Uses `createAzure()` with resource/deployment config
- GitHub Copilot: Token refresh via `@anthropic-ai/sdk`

### Streaming Architecture

opencode does NOT have its own streaming primitive. Instead, it delegates entirely to the AI SDK:

```typescript
// In session/llm.ts
return streamText({
    model: wrapLanguageModel({
        model: language,
        middleware: [/* message transform middleware */],
    }),
    messages: [...system, ...input.messages],
    tools,
    abortSignal: input.abort,
    // ... many more options
});
```

`streamText()` returns a `StreamTextResult` with a `fullStream` async iterable. The consumer (SessionProcessor) iterates `fullStream` events directly:
- `start`, `start-step`, `finish-step`, `finish`
- `reasoning-start`, `reasoning-delta`, `reasoning-end`
- `text-start`, `text-delta`, `text-end`
- `tool-input-start`, `tool-input-delta`, `tool-input-end`
- `tool-call`, `tool-result`, `tool-error`
- `error`

The AI SDK's stream events are richer than pi-agent's 12 types, including step-level lifecycle events and tool input streaming.

### Provider-Specific Transforms

`ProviderTransform` namespace (~955 lines) handles the massive complexity of provider compatibility:

1. **`message()`** -- Normalizes message arrays per provider:
   - Anthropic: Handles empty content (API rejects empty strings), cache control markers
   - Mistral: Rewrites tool call IDs to 9-char alphanumeric format
   - Interleaved reasoning: Some providers need reasoning blocks restructured

2. **`applyCaching()`** -- Adds cache control breakpoints:
   - Anthropic uses `cacheControl: { type: "ephemeral" }` on specific parts
   - Strategy differs per provider

3. **`options()`** -- Builds provider-specific options:
   - `reasoningEffort` for OpenAI
   - `thinkingConfig` for Google
   - `promptCacheKey` for session-based caching

4. **`schema()`** -- Sanitizes JSON schemas per provider:
   - Removes unsupported fields (e.g., `$schema`, `default`)
   - Adjusts for provider limitations

5. **`variants()`** -- Generates reasoning effort variants per provider

### Error Classification

`ProviderError` namespace (`error.ts`) classifies errors:

**Context overflow detection** via pattern matching:
```typescript
const OVERFLOW_PATTERNS = [
    /maximum context length/i,
    /context_length_exceeded/i,
    /too many tokens/i,
    /exceeds the model's context/i,
    /prompt is too long/i,
    // ... 12 patterns total
]
```

**Error classification functions**:
- `parseAPICallError()` -- Classifies as `context_overflow` or `api_error` with `isRetryable` flag
- `parseStreamError()` -- Similar for stream-level errors
- Uses status codes: 429 and 529 are retryable, 400 is overflow-suspicious

The retry logic itself lives in `session/retry.ts` (L1), but the error CLASSIFICATION (is it retryable? is it overflow?) is in the provider error module.

### Token Counting and Cost

Token usage comes from AI SDK step events (`finish-step`):
```typescript
const usage = Session.getUsage({
    model: input.model,
    usage: value.usage,       // AI SDK usage object
    metadata: value.providerMetadata,
});
```

`Session.getUsage()` maps AI SDK's `{ promptTokens, completionTokens }` to opencode's token/cost structure using model cost rates.

### Model Resolution

`getModel()` provides fuzzy model resolution with suggestions:
```typescript
async function getModel(providerID: string, modelID: string): Promise<Model> {
    // Looks up in cached model list
    // If not found, suggests similar model IDs
    throw new ModelNotFoundError({ providerID, modelID, suggestions });
}
```

`getSDK()` and `getLanguage()` lazily instantiate AI SDK provider instances and language models, caching them for reuse.

### Layer Boundary

The boundary is less clean than codex-rs or pi-agent because opencode's provider layer leaks AI SDK types (`streamText`, `StreamTextResult`, `LanguageModelV2`) into the session layer. `LLM.stream()` in `session/llm.ts` directly calls `streamText()` and the processor iterates AI SDK stream events. The "provider layer" is more of a configuration/transform layer around AI SDK than a standalone streaming abstraction.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Language/Runtime** | Rust (tokio) | TypeScript (Node) | TypeScript (Bun) |
| **Package Boundary** | Separate crate (`codex-api`) | Separate package (`packages/ai`) | Directory (`src/provider/`) |
| **Provider Contract** | Data struct (`Provider`) | Interface + registry (`ApiProvider`) | AI SDK wrapper + transforms |
| **Streaming Primitive** | `mpsc::Receiver<Result<ResponseEvent, ApiError>>` wrapped as `Stream` | Custom `EventStream<T, R>` (~88 lines) | AI SDK `StreamTextResult.fullStream` |
| **Event Types** | 11 variants in `ResponseEvent` | 12 variants in `AssistantMessageEvent` | 15+ AI SDK stream event types |
| **Transport Support** | SSE + WebSocket (both produce `ResponseStream`) | Provider-specific (SDK-managed) | AI SDK-managed |
| **Provider Registry** | None (single wire format) | `Map<string, RegisteredApiProvider>` | `BUNDLED_PROVIDERS` map + `CUSTOM_LOADERS` |
| **Multi-Provider** | All use OpenAI Responses API format | 9 KnownApi types, each with own provider impl | 20+ AI SDK provider packages |
| **Error Classification** | `ApiError` enum (10 variants) in provider crate | Errors surfaced as events, no classification | `ProviderError.parseAPICallError()` with patterns |
| **Retryable Detection** | In `ApiError` variants (`Retryable`, `RateLimit`, `ServerOverloaded`) | At agent loop level | `isRetryable` flag from error parser |
| **Context Overflow** | `ApiError::ContextWindowExceeded` | Not detected at provider level | 12 regex patterns in `OVERFLOW_PATTERNS` |
| **Token Counting** | `TokenUsage` from `Completed` event | `Usage` computed per provider with cost | AI SDK usage + `Session.getUsage()` mapper |
| **Cost Calculation** | Higher layer | In provider (using `Model.cost` rates) | In session layer (using `Model.cost` rates) |
| **Rate Limit Handling** | Header parsing (`x-codex-*`), event-based | `maxRetryDelayMs` option | Via AI SDK retry + `retry-after` headers |
| **Provider Quirks** | Azure detection helpers | `OpenAICompletionsCompat` config on Model | `ProviderTransform` (~955 lines of transforms) |
| **Cancellation** | `CancellationToken` | `AbortSignal` in `StreamOptions` | `AbortSignal` in `streamText()` |
| **Boundary Cleanliness** | Excellent (crate boundary) | Excellent (package boundary) | Moderate (AI SDK types leak across layers) |

---

## Synthesis

### Architectural Patterns

All three projects agree on the fundamental separation: provider logic should not know about conversation orchestration. However, they achieve this at different levels of abstraction:

1. **codex-rs: Transport-level abstraction.** The provider layer handles raw HTTP/WebSocket communication, SSE parsing, and event normalization. It produces a uniform event stream regardless of transport. The abstraction is at the byte-stream/protocol level.

2. **pi-agent: SDK-level abstraction with uniform events.** Each provider implementation wraps an SDK client (Anthropic, OpenAI, etc.) and maps SDK-specific events to uniform `AssistantMessageEvent` types. The abstraction is at the semantic level (text deltas, tool calls, thinking).

3. **opencode: Configuration/transform layer over AI SDK.** Rather than abstracting the streaming itself, opencode wraps the AI SDK with provider-specific configuration, message transforms, and error classification. The AI SDK provides the streaming primitive. The abstraction is at the compatibility/adaptation level.

### The Streaming Primitive Question

This is the most consequential design choice at L0:

- **codex-rs** uses an mpsc channel -- efficient for Rust's async model, handles backpressure naturally, but requires a separate producer task.
- **pi-agent** uses a custom `EventStream` class (~88 lines) -- a push/pull queue with async iteration. Elegant, lightweight, and framework-independent.
- **opencode** delegates to AI SDK's `StreamTextResult` -- no custom streaming primitive needed, but couples the entire stack to the AI SDK.

For Diligent, the pi-agent approach (custom `EventStream`) offers the best balance: it is small enough to own, flexible enough to wrap any provider SDK, and does not couple the codebase to a specific framework.

### Error Classification: Where Should It Live?

The projects disagree on where error classification belongs:

- **codex-rs**: Error classification in the provider crate (`ApiError` enum). Clear and complete.
- **pi-agent**: Errors surfaced as events; no classification at provider level. Higher layers decide.
- **opencode**: Error classification in `provider/error.ts` but retry logic in `session/retry.ts`.

The codex-rs and opencode approaches are stronger: the provider layer is best positioned to classify errors because it understands the raw HTTP response codes, headers, and error body formats. The agent loop should not need to parse HTTP error bodies to decide if an error is retryable.

**Recommendation**: Error classification (retryable, overflow, rate-limit) belongs in L0. Retry orchestration (backoff, attempt counting) belongs in L1.

### Token/Cost: Uniform vs Computed

- **codex-rs**: Provider delivers raw token counts; cost computed elsewhere.
- **pi-agent**: Provider computes cost using model rates.
- **opencode**: Provider delivers AI SDK usage; session layer computes cost.

Having the provider compute cost (pi-agent) is cleanest because the provider already has the model's cost rates and the raw usage data. This avoids duplicating cost calculation logic at higher layers.

### Provider-Specific Quirks: The Hard Problem

The biggest practical challenge is handling provider quirks. opencode's `ProviderTransform` at ~955 lines demonstrates the scale of the problem:
- Message normalization per provider
- Schema sanitization per provider
- Caching control per provider
- Temperature/topP/topK defaults per provider
- Tool call ID format per provider (Mistral)

pi-agent handles this with `OpenAICompletionsCompat` on the Model type -- a flat configuration struct checked within provider implementations. This is simpler but less comprehensive.

**Recommendation**: Start with pi-agent's approach (compat config on Model) and add transform functions as needed. The transforms should live in the provider layer, not leak into the agent loop.

### Existing Decision Validation

**D001 (Bun + TypeScript)**: Confirmed. Both pi-agent and opencode are TypeScript. Bun is opencode's runtime.

**D002 (Monorepo: packages/core + packages/cli)**: Confirmed. pi-agent's `ai` package separation is the gold standard for provider isolation.

**D003 (Roll own streaming, not ai-sdk)**: **Strongly confirmed.** opencode's deep AI SDK coupling (20+ provider packages, `ProviderTransform` at 955 lines, leaky abstraction boundaries) is a cautionary tale. pi-agent's custom `EventStream` + per-provider SDK wrapping gives more control with less coupling. codex-rs proves that custom streaming works well at scale.

**D007 (Custom EventStream)**: **Confirmed.** pi-agent's `EventStream<T, R>` is exactly the right primitive: ~88 lines, push/pull with async iteration, completion via `.result()` promise. The key insight is the dual-callback constructor (`isComplete`, `extractResult`) that makes it generic enough for both provider-level and agent-level event streams.

---

## Open Questions

### Q1: Should the provider layer include internal retry?

codex-rs has `RetryConfig` on the `Provider` struct (transport-level retry). pi-agent has `maxRetryDelayMs` (caps server-requested delays). opencode delegates retry to AI SDK (`maxRetries` parameter) and has separate application-level retry in `session/retry.ts`.

**Current decision (D010)**: Exponential backoff retry at the agent loop level. But should the provider layer also have transport-level retry (e.g., for transient connection failures), independent of the application-level retry?

### Q2: How many event types in the streaming primitive?

pi-agent has 12 `AssistantMessageEvent` types. codex-rs has 11 `ResponseEvent` types. AI SDK has 15+.

Should we include step-level events (AI SDK's `start-step`/`finish-step`) or keep it purely at the content level (pi-agent's text/thinking/toolcall triples)?

### Q3: Should the EventStream carry partial messages?

pi-agent's events carry the full `partial: AssistantMessage` on every delta event. This makes it easy for consumers to get the current state but means more allocation. codex-rs's events carry only the delta (e.g., `OutputTextDelta(String)`), requiring the consumer to accumulate state.

The pi-agent approach is simpler for consumers but creates more garbage. Is this acceptable for a TypeScript runtime?

### Q4: Provider registration: static vs dynamic?

pi-agent uses a Map-based registry with `registerApiProvider()`. codex-rs has no registry (single wire format). opencode has a static `BUNDLED_PROVIDERS` map.

For Diligent, should providers register at startup (like pi-agent) or be statically known? Dynamic registration enables plugins; static binding enables tree-shaking.

### Q5: How to handle the compat/transform problem at scale?

opencode's 955 lines of `ProviderTransform` is a warning. As we add providers, quirk handling will grow. Should transforms be:
- Per-provider functions (pi-agent style: localized in each provider impl)?
- A centralized transform layer (opencode style: `ProviderTransform` namespace)?
- Configuration-driven (pi-agent's `compat` on Model: declarative)?

---

## Decision Refinements

Based on this research, the following refinements to existing decisions are proposed:

### D003 Refinement: Provider Interface Shape

The provider contract should be a function signature (like pi-agent's `StreamFunction`), not a class or trait:

```typescript
type StreamFunction = (
    model: Model,
    context: StreamContext,  // systemPrompt, messages, tools
    options: StreamOptions,  // temperature, maxTokens, signal, etc.
) => EventStream<ProviderEvent, ProviderResult>;
```

Where `ProviderEvent` is a 12-type discriminated union (matching pi-agent's design) and `ProviderResult` includes the final message and usage.

### D007 Refinement: EventStream Design

Adopt pi-agent's `EventStream<T, R>` nearly verbatim, with one addition: an `error(err)` method for producer-side error reporting (pi-agent handles this via the `"error"` event type, which works but conflates stream errors with LLM errors).

### New: Error Classification in L0

Add a decision that error classification (retryable, overflow, rate-limit) is the responsibility of L0. Each provider implementation classifies errors from its SDK into a uniform `ProviderError` type. The agent loop (L1) only sees classified errors and decides on retry strategy.
