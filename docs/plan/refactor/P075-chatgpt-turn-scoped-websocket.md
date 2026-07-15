---
id: P075
status: backlog
created: 2026-07-14
---

# P075: Turn-scoped ChatGPT Responses WebSocket reuse

## Goal

Reuse one ChatGPT Responses WebSocket across all LLM sampling requests inside a
single user-visible turn, including tool continuations and provider retries,
without sharing turn-only routing state across user turns.

Keep WebSocket transport opt-in. After one failed reconnect, switch the
ChatGPT provider stream instance to HTTP/SSE instead of spending the full retry
budget repeatedly opening WebSockets.

## Prerequisites

- P074 ChatGPT GPT-5.6 WebSocket transport and error classification are complete.
- The existing Diligent retry wrapper remains the owner of retry delay, visible
  draft discard, and retry eligibility (D010).
- ChatGPT GPT-5.6 continues to default to HTTP/SSE in production runtime wiring.

## Confirmed decisions

1. **Reuse boundary:** one user-visible runtime turn, not one sampling request.
2. **Production enablement:** WebSocket remains opt-in.
3. **Fallback:** allow one WebSocket reconnect; after a second consecutive
   WebSocket transport failure, mark WebSocket unavailable for the current
   ChatGPT stream instance and use HTTP/SSE on the next outer retry attempt.
4. **Payload optimization:** do not add `previous_response_id` or input-delta
   compaction in this plan.
5. **Cross-turn pooling:** do not keep a physical socket warm after the runtime
   turn scope is disposed.

## Artifact

With WebSocket transport explicitly enabled, one user request that invokes a
tool uses a single physical connection:

```text
User turn starts
  → connect WebSocket #1
  → send response.create #1
  ← response.completed with tool call
  → run tool
  → send response.create #2 on WebSocket #1
  ← response.completed with final answer
  → close WebSocket #1 when the user turn finishes
```

If the connection fails:

```text
WebSocket #1 fails
  → Diligent outer retry waits
  → connect WebSocket #2 and retry the full logical request
WebSocket #2 fails
  → mark WebSocket disabled for this ChatGPT stream instance
  → Diligent outer retry uses HTTP/SSE
```

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| Core LLM lifecycle | Add an ephemeral, disposable stream turn scope shared by all sampling rounds in one user turn |
| Core agent loop | Thread the same scope through tool continuations, context-overflow recovery, and provider retries |
| ChatGPT provider | Split the current request-scoped WebSocket helper into a reusable turn session and per-request exchange |
| Runtime session orchestration | Create and dispose one scope around the outer `TurnOrchestrator.run()` call, including Stop-hook continuation |
| Runtime ChatGPT binding | Return one stable stream function so sticky HTTP fallback state has a defined lifetime |
| Tests | Assert connection counts, cleanup, retry reconnect, fallback, and turn isolation |

### What does NOT change

- No `previous_response_id` or incremental input-delta requests.
- No socket pooling across user turns.
- No session-wide idle socket cache.
- No preconnect or `generate: false` prewarm.
- No default enablement of ChatGPT GPT-5.6 WebSocket transport.
- No new Web/TUI setting or protocol method.
- No provider-independent stream chunk timeout.
- No replacement of Bun/global `WebSocket` with `ws` or another handshake client.
- No attempt to recover HTTP upgrade status/body when the WebSocket API does not
  expose it.
- No changes to OpenAI API-key, Anthropic, Gemini, Vertex, or z.ai transports.
- No persistence of the turn scope, WebSocket, or other non-serializable state
  in events, session JSONL, protocol payloads, or thread snapshots (D086).

## File Manifest

### packages/core/src/llm/

| File | Action | Description |
|------|--------|-------------|
| `turn-scope.ts` | CREATE | Generic ephemeral resource scope with idempotent async disposal and turn-wide routing state |
| `types.ts` | MODIFY | Add optional `turnScope` to `StreamOptions` |
| `index.ts` | MODIFY | Export turn-scope types and constructor |

### packages/core/src/llm/provider/

| File | Action | Description |
|------|--------|-------------|
| `chatgpt-websocket-session.ts` | CREATE | Reusable physical connection and serialized per-request exchange implementation |
| `chatgpt.ts` | MODIFY | Acquire the turn session from `StreamOptions`, retain one-shot fallback, and implement one-reconnect HTTP fallback state |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | MODIFY | Add `AgentPromptOptions.turnScope` |
| `agent.ts` | MODIFY | Accept a supplied scope or create/dispose a prompt-local fallback scope |
| `loop.ts` | MODIFY | Carry one scope through all sampling rounds in the agent loop |
| `assistant.ts` | MODIFY | Stop creating sampling-local turn state and pass the shared scope to `StreamOptions` |
| `index.ts` | MODIFY | Export `AgentPromptOptions` if required by runtime typing |

### packages/core/src/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | MODIFY | Export public turn-scope contracts through `@diligent/core` |

### packages/runtime/src/session/

| File | Action | Description |
|------|--------|-------------|
| `turn-orchestrator.ts` | MODIFY | Own one scope around the full protocol turn and share it with Stop-hook reruns |

### packages/runtime/src/auth/

| File | Action | Description |
|------|--------|-------------|
| `provider-auth.ts` | MODIFY | Construct one stable ChatGPT stream function per OAuth binding without enabling WebSocket by default |

### packages/core/test/llm/

| File | Action | Description |
|------|--------|-------------|
| `turn-scope.test.ts` | CREATE | Resource reuse, idempotent disposal, and disposal failure behavior |

### packages/core/test/llm/provider/

| File | Action | Description |
|------|--------|-------------|
| `chatgpt-websocket-session.test.ts` | CREATE | Connection/session state-machine tests with fake sockets |
| `openai-stream.test.ts` | MODIFY | ChatGPT provider integration tests for scope reuse, retry reconnect, and HTTP fallback |

### packages/core/test/agent/

| File | Action | Description |
|------|--------|-------------|
| `agent.test.ts` | MODIFY | Prompt-local scope ownership, supplied-scope ownership, and separate prompt isolation |
| `loop.test.ts` | MODIFY | Tool continuation sampling receives the same turn scope |
| `loop-retry.test.ts` | MODIFY | Retry attempts retain the same logical scope while failed sockets are replaced |

### packages/runtime/test/session/

| File | Action | Description |
|------|--------|-------------|
| `manager.test.ts` | MODIFY | Runtime turn disposal on success, error, abort, and Stop-hook continuation |

### packages/runtime/test/auth/

| File | Action | Description |
|------|--------|-------------|
| `provider-auth.test.ts` | MODIFY | Stable ChatGPT stream identity and refreshed-token visibility on reconnect |

## Implementation Tasks

### Task 1: Add an ephemeral stream turn scope

**Files:** `packages/core/src/llm/turn-scope.ts`,
`packages/core/src/llm/types.ts`, `packages/core/src/llm/index.ts`,
`packages/core/src/index.ts`, `packages/core/test/llm/turn-scope.test.ts`

**Decisions:** D003, D008, D086

Add a generic scope that providers can use without exposing ChatGPT-specific
state to runtime:

```typescript
export interface StreamTurnResource<T> {
  value: T;
  dispose: () => void | Promise<void>;
}

export interface StreamTurnScope {
  readonly turnStateRef: { value: string | undefined };

  getOrCreate<T>(
    key: symbol,
    create: () => StreamTurnResource<T>,
  ): T;

  dispose(): Promise<void>;
}

export function createStreamTurnScope(): StreamTurnScope;
```

Implementation requirements:

- `getOrCreate()` returns the same value for the same symbol.
- Different provider symbols cannot collide.
- `dispose()` runs registered disposers in reverse creation order.
- Disposal is idempotent and safe when called concurrently.
- A failed disposer does not skip later disposers; aggregate or log failures
  after all cleanup attempts.
- Calling `getOrCreate()` after disposal throws.
- `turnStateRef` is allocated once per scope and is never serialized.

Extend `StreamOptions`:

```typescript
export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  effort?: ThinkingEffort;
  turnStateRef?: { value: string | undefined };
  turnScope?: StreamTurnScope;
}
```

Keep `turnStateRef` temporarily for provider/direct-call compatibility. The
agent path will pass both values from the same scope.

**Verify:** `bun test packages/core/test/llm/turn-scope.test.ts`

### Task 2: Thread the scope through one complete agent prompt

**Files:** `packages/core/src/agent/types.ts`,
`packages/core/src/agent/agent.ts`, `packages/core/src/agent/loop.ts`,
`packages/core/src/agent/assistant.ts`, `packages/core/src/agent/index.ts`,
`packages/core/test/agent/agent.test.ts`,
`packages/core/test/agent/loop.test.ts`,
`packages/core/test/agent/loop-retry.test.ts`

**Decisions:** D008, D009, D010

Preserve the existing `Agent.prompt(message, signal)` API while adding optional
turn lifecycle arguments:

```typescript
export interface AgentPromptOptions {
  turnScope?: StreamTurnScope;
}

async prompt(
  userMessage: Message,
  signal?: AbortSignal,
  options?: AgentPromptOptions,
): Promise<Message[]>;
```

Rules:

- If `options.turnScope` is supplied, Agent borrows it and must not dispose it.
- Otherwise Agent creates one scope for that `prompt()` and disposes it in
  `finally` after the full agent loop ends.
- Never store the active scope on the cached Agent instance.
- Add the scope to `LoopRuntime` and `LoopRequest` once, outside the sampling
  `while` loop.
- Every `streamAssistantMessage()` call receives the same scope.
- Context-overflow compaction and retry retain the same scope.
- `withRetry()` already reuses the same `StreamOptions` object for all attempts;
  no retry API change is needed.

Replace the sampling-local ref in `assistant.ts`:

```typescript
const providerStream = runtime.providerStream(request.config.model, context, {
  signal: request.signal,
  effort: request.config.effort,
  sessionId: request.sessionId,
  maxTokens: resolveMaxTokens(request.config.model),
  turnStateRef: request.turnScope.turnStateRef,
  turnScope: request.turnScope,
});
```

Tests must prove:

- tool call sampling and final-answer sampling observe the same scope identity;
- outer retry attempts observe the same scope identity;
- two separate `Agent.prompt()` calls do not share fallback scopes;
- supplied scopes remain undisposed when `Agent.prompt()` returns;
- prompt-local scopes dispose on success, provider failure, and abort.

**Verify:**

```bash
bun test packages/core/test/agent/agent.test.ts \
  packages/core/test/agent/loop.test.ts \
  packages/core/test/agent/loop-retry.test.ts
```

### Task 3: Build a reusable, serialized WebSocket turn session

**Files:** `packages/core/src/llm/provider/chatgpt-websocket-session.ts`,
`packages/core/test/llm/provider/chatgpt-websocket-session.test.ts`

**Decisions:** D007, D009

Move physical socket ownership out of the current per-request helper.

Suggested contracts:

```typescript
export interface ChatGPTWebSocketSessionOptions {
  createSocket: (url: string, headers: Record<string, string>) => WebSocket;
  resolveHeaders: () => Promise<Record<string, string>>;
  idleTimeoutMs: number;
}

export interface ChatGPTWebSocketExchange {
  events: AsyncIterable<Record<string, unknown>>;
  completed: Promise<void>;
}

export class ChatGPTWebSocketTurnSession {
  constructor(options: ChatGPTWebSocketSessionOptions);

  streamRequest(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): ChatGPTWebSocketExchange;

  dispose(): Promise<void>;
}
```

The exact return type may continue using the existing queue abstraction, but
the state machine must obey these rules:

1. Connect lazily on the first request.
2. Resolve current OAuth headers on every physical connect/reconnect.
3. Permit exactly one active response on a socket.
4. Hold exclusivity from `response.create` send until the response terminal.
5. `response.completed` ends only the current exchange and keeps the socket open.
6. `response.failed` and wrapped `type: "error"` fail the exchange and invalidate
   the physical socket.
7. Close-before-completion, idle timeout, send failure, decode failure, and
   abort fail the exchange and invalidate the physical socket.
8. Drain serialized Blob/message decode work before a later request becomes
   active, preserving the P074 close/decode race fix.
9. Scope disposal closes a healthy idle socket with code `1000` and terminates
   an active or ambiguous socket.
10. Every cleanup path is idempotent.

Do not multiplex Responses requests. If a second request arrives while one is
active, either queue it behind the first terminal or reject it as an invariant
violation. Rejecting is simpler and sufficient because the agent loop is
sequential.

**Verify:**

```bash
bun test packages/core/test/llm/provider/chatgpt-websocket-session.test.ts
```

### Task 4: Integrate reuse and one-reconnect HTTP fallback

**Files:** `packages/core/src/llm/provider/chatgpt.ts`,
`packages/core/test/llm/provider/openai-stream.test.ts`

**Decisions:** D003, D010

Use a module-local symbol so each turn scope owns at most one ChatGPT WebSocket
session per ChatGPT stream instance:

```typescript
const CHATGPT_WEBSOCKET_TURN_SESSION = Symbol("chatgpt-websocket-turn-session");

interface ChatGPTTransportState {
  websocketDisabled: boolean;
}
```

`createChatGPTStream()` should create one stable `ChatGPTTransportState` in its
closure. It must remain HTTP/SSE by default unless
`useWebSocketForGpt56 === true`.

When WebSocket is selected:

- acquire `ChatGPTWebSocketTurnSession` through `options.turnScope.getOrCreate()`;
- use the current one-request behavior only when no scope is supplied;
- send the full Responses Lite request on every sampling round;
- do not send `previous_response_id`;
- preserve `options.turnStateRef` across sampling rounds.

Fallback state machine:

```typescript
type TurnWebSocketState = {
  consecutiveTransportFailures: number;
};
```

1. First WebSocket transport failure:
   - invalidate the physical socket;
   - increment the turn failure count;
   - emit the existing retryable `ProviderError`;
   - outer `withRetry()` applies backoff and calls the provider again.
2. Retry reconnects with a new physical socket and sends the full request.
3. Second consecutive WebSocket transport failure:
   - invalidate the physical socket;
   - set `transportState.websocketDisabled = true`;
   - emit a retryable error indicating that the next attempt will use HTTP.
4. The next outer retry uses HTTP/SSE and sends the full logical request.
5. A successful WebSocket `response.completed` resets the turn's consecutive
   transport failure count.
6. Provider errors that are not transport failures, including auth, usage limit,
   generic 429, invalid request, and context overflow, do not consume the
   WebSocket reconnect budget and do not trigger HTTP fallback.

If an upgrade failure exposes an explicit unsupported status such as `426`, set
`websocketDisabled` immediately. Opaque pre-open failures use the same two-
failure budget because the current WebSocket API cannot reliably expose the
handshake response.

Tests must assert physical factory calls and sent frames, not only final events:

- two sequential sampling calls in one scope: one socket, two
  `response.create` frames;
- first `response.completed` does not call `close()`;
- separate scopes create separate sockets;
- no-scope direct call remains one-shot and closes after completion;
- first transport failure reconnects on outer retry;
- second transport failure makes the following attempt use HTTP/SSE;
- successful completion resets the consecutive failure count;
- usage-limit and auth errors do not fall back through the transport budget;
- abort invalidates the socket and prevents reuse;
- scope disposal closes exactly once.

**Verify:**

```bash
bun test packages/core/test/llm/provider/openai-stream.test.ts \
  packages/core/test/llm/provider/chatgpt-websocket-session.test.ts
```

### Task 5: Make runtime own the user-turn scope

**Files:** `packages/runtime/src/session/turn-orchestrator.ts`,
`packages/runtime/test/session/manager.test.ts`

**Decisions:** D008, D009, D086

Create the scope in the outer `TurnOrchestrator.run()` method, not in
`runInternal()`:

```typescript
async run(userMessage: Message, opts?: { signal?: AbortSignal }): Promise<void> {
  const turnScope = createStreamTurnScope();
  try {
    await this.runInternal(userMessage, { ...opts, turnScope }, false);
  } finally {
    await turnScope.dispose();
  }
}
```

Extend the private run options and pass the scope into:

```typescript
await agent.prompt(userMessage, signal, { turnScope });
```

This placement guarantees:

- all tool-driven sampling rounds share the scope;
- Stop-hook `continueWith` recursion shares the scope;
- provider errors handled inside `runInternal()` still dispose the scope;
- interruption disposes before `SessionManager.run()` resolves;
- root and collaboration child turns use the same lifecycle path;
- a later user turn receives a new scope.

Do not put the scope in `ThreadRuntime`, `SessionState`, staged entries, or
events.

Tests should register a fake disposable resource from a custom stream and prove
exactly-once disposal for:

- normal completion;
- provider failure;
- abort;
- Stop-hook continuation;
- two sequential user turns using distinct scopes.

**Verify:** `bun test packages/runtime/test/session/manager.test.ts`

### Task 6: Stabilize the ChatGPT OAuth stream binding

**Files:** `packages/runtime/src/auth/provider-auth.ts`,
`packages/runtime/test/auth/provider-auth.test.ts`

**Decisions:** D003

Construct the ChatGPT stream once per OAuth binding:

```typescript
const stream = createChatGPTStream(() => oauthTokens!);

const auth: ExternalProviderAuth = {
  // ...
  getStream: () => stream,
  // ...
};
```

Do not pass `useWebSocketForGpt56: true`; runtime behavior remains HTTP/SSE by
default.

This gives the provider transport fallback flag a stable lifetime when a future
opt-in path supplies WebSocket options, while the token getter still observes
refreshed mutable tokens on every reconnect.

Tests should prove:

- repeated `getStream()` calls return the same stream function;
- `setTokens()` and token refresh remain visible to later physical connections;
- WebSocket remains disabled by default.

**Verify:** `bun test packages/runtime/test/auth/provider-auth.test.ts`

### Task 7: Run regression and manual verification

**Files:** no additional production files

Run:

```bash
bun test ./packages/core/test
bun test ./packages/runtime/test
bun run lint
bun run typecheck
```

Manual opt-in verification should use a real ChatGPT GPT-5.6 OAuth session and
debug WebSocket logging:

```bash
DILIGENT_DEBUG_CHATGPT_WEBSOCKET=1 bun run <host-command>
```

Verify from logs that one user turn containing at least one tool call shows:

- one WebSocket connection/open event;
- two or more `response.create` sends;
- no normal socket close between tool continuation samples;
- one normal close when the runtime turn completes.

Then simulate or force connection failure and verify:

- first failure reconnects once;
- second failure causes the next retry to use HTTP/SSE;
- the user turn completes or surfaces the final HTTP error normally.

## Acceptance Criteria

1. Two sequential ChatGPT WebSocket sampling requests in one runtime turn use
   one physical WebSocket connection.
2. `response.completed` ends the current provider event stream without closing
   a healthy turn-owned socket.
3. A tool-call continuation sends the next full `response.create` only after the
   prior response is terminal.
4. No two Responses requests are active concurrently on one socket.
5. A transport failure invalidates the physical socket while retaining the
   logical turn session for retry.
6. One failed reconnect is allowed; after a second consecutive WebSocket
   transport failure, the next outer retry uses HTTP/SSE.
7. Auth, usage-limit, generic 429, invalid-request, and context-overflow errors
   do not consume the transport fallback budget.
8. User abort immediately terminates the active socket and the outer scope still
   disposes exactly once.
9. Stop-hook continuation shares the same turn scope.
10. A new user turn never receives the previous turn's `turnStateRef` or socket.
11. Direct core callers without a supplied scope retain leak-free one-request
    behavior.
12. ChatGPT GPT-5.6 WebSocket remains opt-in in runtime production wiring.
13. No non-serializable turn/session object appears in events, persistence, or
    protocol data.
14. Core and runtime full tests, lint, and typecheck pass.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Turn-scope allocation and disposal | Fake resources and concurrent/idempotent disposal tests |
| Unit | WebSocket session state machine | Fake socket with explicit open/message/close/error control |
| Unit | Provider fallback classification | Fake WebSocket failures plus mocked HTTP/SSE fetch |
| Agent integration | Scope identity across tools and retries | Custom stream function recording `StreamOptions.turnScope` |
| Runtime integration | User-turn ownership and Stop-hook recursion | SessionManager tests with disposable fake resources |
| Auth integration | Stable stream and refreshed token lookup | ChatGPT OAuth binding tests |
| Manual | Real GPT-5.6 tool turn and fallback | Debug WebSocket logs with explicit opt-in |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Late events from request N reach request N+1 | Corrupted response routing | One active request invariant; drain decode work; reconnect on any ambiguous terminal |
| `response.completed` races with close/abort/dispose | False retry or leaked socket | Idempotent state transition with terminal flag before queue completion |
| Failed socket is reused by outer retry | Repeated immediate failures | Invalidate physical socket on every transport/protocol failure; reconnect lazily |
| WebSocket fallback triggers on provider errors | Auth/quota errors are hidden by HTTP retries | Count only classified transport failures |
| Stop-hook recursion creates multiple scopes | Socket closes between logical continuations | Scope is owned only by outer `TurnOrchestrator.run()` |
| Cached Agent leaks turn state | Cross-user-turn routing contamination | Pass scope as call state; never store it on Agent fields |
| Token expires before reconnect | Reconnect uses stale authorization | Resolve current tokens/headers on each physical connect |
| Direct core caller leaks a socket | Process retains idle connection | Agent-owned fallback scope and no-scope one-request provider fallback |
| Scope leaks into persisted data | Serialization/protocol failure | Keep scope only in call options and assert event serialization remains unchanged |
| Runtime behavior changes unexpectedly | WebSocket failures affect all users | Do not enable WebSocket by default in this plan |

## Deferred follow-ups

The following optimizations require separate plans after turn-scoped reuse is
stable:

1. `previous_response_id` plus input-delta compaction.
2. Parking one healthy socket between user turns.
3. Session-level socket pooling with concurrent-turn checkout.
4. `generate: false` prewarm.
5. A public provider configuration for WebSocket enablement and fallback
   thresholds.
6. A lower-level WebSocket client that exposes failed upgrade HTTP responses.

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D003 | Providers remain behind the common `StreamFunction` abstraction | Generic turn scope and ChatGPT-only implementation |
| D007 | Provider and agent streaming use custom async-iterable EventStream | Per-request exchange remains an async event source |
| D008 | Per-turn immutable context is separated from mutable session state | Runtime turn owns ephemeral provider resources |
| D009 | AbortSignal propagates cancellation through the stack | Active exchange termination and scope disposal |
| D010 | Diligent owns classified exponential retry | One reconnect and HTTP fallback occur through outer retry attempts |
| D086 | Core/consumer boundary data must remain serializable | Turn scope is call-only and never emitted or persisted |
