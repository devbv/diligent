---
id: P080-HANDOFF
created: 2026-07-17
status: active
---

# P080 Hand-off: Core LLM Internal Refactoring After Boundary Stabilization

## Why this hand-off exists

The recent `packages/core` work closed the important package and ownership boundaries around provider contracts,
runtime presentation, image loading, public subpaths, and provider error diagnostics. Another facade, ownership pass, or
cross-provider framework would now add churn without addressing the next sources of risk.

The remaining high-value work is internal and behavioral:

1. remove divergent ChatGPT WebSocket lifecycle implementations;
2. make external-auth refresh part of request readiness instead of fire-and-forget work;
3. make OpenAI-family stream accumulation and finalization explicit;
4. split Anthropic message conversion into testable provider-local stages; and
5. remove a smaller amount of mechanical OpenAI-compatible transport duplication after the behavioral work is stable.

This document combines the findings from the current source audit, the latest tech-lead review, GitHub issues
[#295](https://github.com/overdare/diligent/issues/295),
[#296](https://github.com/overdare/diligent/issues/296),
[#307](https://github.com/overdare/diligent/issues/307), and
[#308](https://github.com/overdare/diligent/issues/308), and the verification baseline captured below.

## Current baseline

As of 2026-07-17:

- Branch: `main`
- HEAD: `d0e30bfb`
- LLM test command: `NO_COLOR=1 FORCE_COLOR=0 bun test packages/core/test/llm`
- Result: 291 tests passed, 0 failed, 819 expectations across 28 files
- The worktree already contains an untracked review document:
  `docs/review/2026-07-17-ad187437.md`

Preserve the existing review document and any other user-authored worktree changes. Do not reset, remove, or rewrite
them as part of this refactor.

## Direction locked by this hand-off

### Stop boundary redesign

The following areas are sufficiently settled and are not current refactoring targets:

- core/runtime ownership;
- public contract facades and package subpaths;
- protocol ownership of shared frontend data;
- runtime ownership of provider presentation and recovery intent;
- image-loader injection and persisted-path ownership;
- shared baseline provider error classification; and
- the public `StreamFunction`, `ProviderEvent`, and `convertMessages()` contracts.

### Refactor around temporal state and transformation stages

The next useful abstractions are small and internal:

- one ChatGPT WebSocket lifecycle implementation;
- one narrowly scoped OpenAI-family content accumulator; and
- pure Anthropic conversion stages.

Do not introduce provider inheritance, a generic provider framework, a cross-provider message converter, or a generic
WebSocket transport framework.

## Work item 1: unify scoped and unscoped ChatGPT WebSocket lifecycle

### Priority

P0. This is the first item because the duplication has already produced observable semantic drift in the path used by
normal agent turns.

### Current structure

`packages/core/src/llm/provider/chatgpt.ts` contains a one-shot WebSocket implementation:

- a private `AsyncEventQueue`;
- `createChatGPTWebSocketEvents()`;
- serialized asynchronous frame decoding through `messageWork`;
- connection/open/send/receive timeout handling;
- close-after-pending-decode ordering;
- debug frame summaries; and
- top-level WebSocket error classification through `toChatGPTWebSocketError()`.

`packages/core/src/llm/provider/chatgpt-websocket-session.ts` independently contains:

- another private `AsyncEventQueue`;
- a reusable `ChatGPTWebSocketSession`;
- connection establishment and reuse;
- active-exchange state;
- timeout and invalidation logic; and
- a separate message/close/error state machine.

`streamAssistantMessage()` always supplies a `StreamTurnScope`. Therefore ordinary agent turns select
`ChatGPTWebSocketSession`, while many existing WebSocket regression tests omit `turnScope` and exercise only the
one-shot implementation.

### Confirmed parity gaps

#### Delayed terminal decode versus close

The one-shot implementation chains close finalization behind `messageWork`. This was the behavior used to close
[#295](https://github.com/overdare/diligent/issues/295).

The reusable session installs a close listener that calls transport invalidation independently of its `messageWork`
chain. A delayed `Blob.text()` decode for `response.completed`, followed immediately by normal close, can therefore
invalidate the active exchange before the queued terminal frame is processed.

The existing delayed-terminal regression test does not pass a `turnScope`, so it does not protect the production
scoped path.

#### Top-level provider error classification

The one-shot implementation maps `payload.type === "error"` through `toChatGPTWebSocketError()`, preserving:

- status and `status_code` aliases;
- usage-limit detection and stable reason;
- authentication and rate-limit classification;
- connection-limit retryability; and
- upstream error code, type, and message details.

The reusable session currently turns the same payload into a generic non-retryable `unknown` provider error with the
message `ChatGPT WebSocket request failed`.

#### Connection-open timeout

The one-shot implementation starts an idle timer while waiting for the socket to open. The reusable session applies
its exchange timer only after a request has been sent. A socket that never reaches `open` can therefore remain pending
indefinitely in the scoped path.

#### Diagnostics

Frame byte counts and payload summaries live only in the one-shot implementation. Scoped requests bypass that debug
path.

### Target design

Use `ChatGPTWebSocketSession` as the single provider-local lifecycle engine.

- When `StreamTurnScope` is present, obtain and reuse the session from the scope.
- When no scope is present, create an ephemeral session, execute one exchange, and dispose it when the exchange ends.
- Move or inject the existing payload classifier and debug summarizer into the session implementation.
- Serialize close classification after all frames delivered before the close event have finished decoding.
- Apply the configured timeout to connection open, send, and response wait phases.
- Keep one physical socket single-flight; do not introduce multiplexing.
- Preserve the higher-level retry boundary in `withRetry()`; the session must not replay requests internally.

The public `createChatGPTStream()` and `ChatGPTStreamOptions` contracts should remain unchanged.

### Tests to add first

Add scoped variants that pass a real `createStreamTurnScope()` for:

1. delayed terminal `Blob` decode followed by close;
2. socket never opens;
3. close before `response.completed`, preserving close code and reason;
4. send throws;
5. top-level 401/403 error;
6. top-level generic 429;
7. top-level usage-limit error, including stable `usage_limit_reached` reason;
8. top-level connection-limit error;
9. transient `response.failed` behavior;
10. abort during open and abort during an active exchange;
11. sequential reuse after a successful exchange; and
12. socket disposal with the turn scope.

Keep transport regressions in `packages/core/test/llm/provider/openai-stream.test.ts` unless the session gains a
dedicated source-level test file. If a new test file is introduced, mirror the source path under
`packages/core/test/llm/provider/`.

### Issue handling

No open issue currently covers the combined scoped/unscoped parity and consolidation work.

- #295 is closed and records the correct invariant, but only the one-shot path is protected today.
- #296 is open and concerns preserving HTTP upgrade failure metadata; it does not cover lifecycle parity.

Preferred issue action: create a new issue titled `Unify scoped and unscoped ChatGPT WebSocket lifecycle`, reference
#295 as a regressed invariant, and make #296 depend on or target the unified connection boundary. Reopening #295 is
acceptable for the decode/close portion, but a new issue better captures the broader consolidation and error-parity
scope.

### Acceptance criteria

- Scoped and unscoped calls use the same WebSocket lifecycle implementation.
- A terminal frame delivered before close is decoded before close-before-terminal classification.
- Top-level provider errors have identical classification in scoped and unscoped calls.
- Connection open, send, and response wait phases cannot hang indefinitely.
- Successful sequential scoped requests reuse one socket.
- Abort, failure, and scope disposal release listeners, timers, queues, and sockets exactly once.
- No request replay or retry is added below `withRetry()`.
- Existing public provider contracts and emitted `ProviderEvent` behavior remain unchanged.

## Work item 2: await external-provider authentication readiness

### Priority

P0 correctness fix, kept separate from the WebSocket consolidation commit.

### Current behavior

`ProviderManager.createProxyStream()` calls external auth readiness as fire-and-forget work:

```ts
external.ensureFresh?.().catch(() => {});
return external.getStream()(model, context, options);
```

For ChatGPT, `ensureFresh()` can perform an asynchronous OAuth refresh, while `createChatGPTStream()` reads the current
token as it constructs request headers. A long-running process can therefore start a request with the stale token
while refresh is still in flight.

Refresh failures are also swallowed at this point, causing the provider request to proceed with stale credentials and
masking the actual refresh failure behind a later upstream authentication error.

External native compaction has the same readiness concern: `createCompactionRegistry()` returns
`getNativeCompaction()` without awaiting `ensureFresh()` before the compaction request.

### Target behavior

Authentication readiness is part of starting a provider operation.

- Await `ensureFresh()` before invoking the external stream function.
- Await `ensureFresh()` before invoking an external native compaction function.
- Propagate refresh failure as the operation error instead of swallowing it.
- Respect an already-aborted signal before opening the inner provider stream.
- Preserve the synchronous `StreamFunction` signature by returning an outer `EventStream` that proxies the inner stream
  after readiness completes.
- Track proxy work with `EventStream.setInnerWork()` so cleanup can wait for it.

Prefer one small internal deferred-stream helper in core over independent runtime wrappers. This keeps the existing
`ExternalProviderAuth` contract meaningful without changing its public shape.

### Tests to add first

Add focused `ProviderManager` tests proving that:

1. no provider request starts before `ensureFresh()` resolves;
2. the refreshed credential is the one observed by the stream;
3. a refresh rejection becomes the terminal stream error;
4. abort before readiness prevents the inner stream from starting;
5. concurrent calls share the binding's existing refresh lock rather than requiring manager-level locking; and
6. external native compaction also waits for readiness.

Add or strengthen runtime binding tests only where token replacement behavior itself is involved.

### Issue handling

No matching GitHub issue was found during this hand-off audit.

Suggested title: `Await external provider auth refresh before stream and native compaction requests`.

### Acceptance criteria

- External streams never start before their readiness hook resolves.
- External native compaction never starts before its readiness hook resolves.
- Refresh failures are not swallowed.
- Abort prevents deferred provider work from starting.
- Static API-key providers remain unchanged.
- No public provider contract change is required.

## Work item 3: GitHub issue #307, OpenAI-family stream lifecycle accumulator

### Issue

[#307: Extract a minimal OpenAI-family stream lifecycle accumulator](https://github.com/overdare/diligent/issues/307)
is open and correctly captures the next shared temporal seam.

### Current duplication

`openai-sse.ts` and `openai-compatible.ts` use different wire protocols but independently manage:

- text accumulation and `text_end` emission;
- thinking accumulation and `thinking_end` emission;
- fragmented tool-call arguments;
- tool-call start/end ordering;
- usage and stop reason;
- content-block ordering; and
- terminal `AssistantMessage` construction.

The shared behavior is temporal state, not wire decoding.

### Accumulator boundary

The accumulator may own:

- partial text and thinking buffers;
- active tool-call buffers;
- completed content blocks;
- exactly-once flush state; and
- construction of terminal content from already-normalized inputs.

The accumulator must not own:

- raw Responses or Chat Completions event decoding;
- provider-native web search/fetch normalization;
- completed-response fallback discovery;
- provider error or retry classification;
- WebSocket or HTTP/SSE transport framing; or
- provider-specific request construction.

### Important compatibility constraint

Malformed tool arguments currently have different fallback behavior:

- Responses produces an empty object;
- Chat Completions preserves the raw argument string under `_raw`.

#307 requires no emitted behavior change. Therefore the shared accumulator must not silently choose one parsing policy.
Keep argument parsing in the caller or make the fallback policy an explicit caller-supplied operation. Add direct tests
that lock both current behaviors before extraction.

Responses also receives authoritative `message_done` content in addition to text deltas. The accumulator must support
finalizing authoritative content without duplicating text accumulated from deltas.

### Tests to add first

Add a focused lifecycle test file for:

1. text-only transition and exactly one `text_end`;
2. thinking followed by text;
3. thinking without text;
4. fragmented tool arguments;
5. multiple interleaved tool calls;
6. malformed Responses arguments preserving the Responses fallback;
7. malformed Chat Completions arguments preserving `_raw`;
8. mixed text and tool calls;
9. authoritative message completion after text deltas without duplication;
10. usage-only trailing payload;
11. abort without terminal flush; and
12. repeated finalization attempts producing one terminal result.

Retain existing transport and provider-native web-tool regressions in their current test files.

### Recommended issue clarification

The current #307 body is sound. Add one comment or acceptance-criteria sentence stating:

> Preserve each wire path's existing malformed-tool-argument fallback; JSON parsing policy is not owned by the shared
> accumulator.

No other scope change is needed.

### Acceptance criteria

Use #307's existing acceptance criteria plus the malformed-argument compatibility constraint above.

## Work item 4: GitHub issue #308, Anthropic message conversion stages

### Issue

[#308: Decompose Anthropic message conversion into pure stages](https://github.com/overdare/diligent/issues/308) is
open and correctly scoped.

### Current policy mixture

`convertMessages()` currently combines:

- provider-native compaction prefix injection;
- user content and local-image materialization;
- assistant replay conversion;
- signed-thinking preservation and foreign-thinking filtering;
- Anthropic provider-native web block replay;
- tool-result conversion, image handling, and user-role coalescing; and
- final user cache-breakpoint placement.

`ensureAnthropicCompactionConversationEndsWithUser()` separately contains an empty conditional left over from earlier
normalization flow.

All of these policies belong to Anthropic. The problem is not ownership; it is that independent policies cannot be
tested or changed independently.

### Target stages

Preserve the exported `convertMessages()` function as the orchestration entrypoint and decompose its internals into
provider-local pure or narrowly effectful stages, for example:

1. build the optional compaction prefix;
2. convert one core message by role;
3. materialize and convert user image content;
4. append/coalesce Anthropic user-role blocks and tool results;
5. filter or convert assistant replay blocks; and
6. apply the last-user cache breakpoint.

The exact function names are not locked, but their policy boundaries should be visible and directly testable. A
narrowly named Anthropic-only sibling module is acceptable if `anthropic.ts` remains too large.

### Tests to add first

Use #308's acceptance criteria and explicitly cover:

1. compaction prefix before follow-up messages;
2. adjacent tool results coalescing into Anthropic user-role content;
3. tool results following an ordinary user message;
4. text-only tool result;
5. image-bearing tool result with and without text;
6. foreign provider-native blocks omitted during replay;
7. Anthropic provider-native blocks retained;
8. unsigned foreign thinking omitted;
9. signed Anthropic thinking retained;
10. cache breakpoint on the final block of the last user-role message;
11. cache breakpoint behavior after tool-result coalescing;
12. no user message producing an empty native-compaction conversation; and
13. trailing assistant messages removed for native compaction.

### Issue assessment

#308 is ready to implement without a scope rewrite. The final two native-compaction invariants above are useful
strengthening but do not require changing the issue's architectural intent.

### Acceptance criteria

Use #308 as written, with the additional requirement that native-compaction input normalization retains its current
no-user and trailing-assistant behavior.

## Work item 5: smaller OpenAI-compatible transport cleanup

### Priority

P2. Perform only after the lifecycle and conversion work above is stable.

### Current duplication

`vertex.ts` and `zai-coding-plan.ts` have near-identical implementations for:

- provider `EventStream` construction;
- OpenAI-compatible message and tool request construction;
- system-message insertion;
- max-token and temperature handling;
- authenticated `fetch()`;
- response-body error extraction;
- JSON-over-SSE parsing;
- delegation to `handleChatCompletionsEvents()`; and
- baseline error classification.

ChatGPT HTTP/SSE contains a third JSON-over-SSE parser with additional diagnostics.

OpenAI and ChatGPT native compaction also duplicate compact error-body truncation and JSON extraction helpers.

### Recommended extraction order

1. Extract and characterize one JSON SSE iterator that correctly handles chunk boundaries, CRLF, decoder flush, EOF,
   `[DONE]`, invalid JSON, and abort.
2. Allow ChatGPT to retain provider-local debug callbacks around decoded payloads.
3. Reuse the iterator from Vertex and z.ai.
4. Only then evaluate whether a small OpenAI-compatible request runner is still justified.
5. Extract native-compaction error-body helpers only if OpenAI and ChatGPT behavior can remain identical.

Do not start with a provider strategy registry or generic provider factory. The request-specific differences should
remain ordinary explicit callbacks or local code until a third stable consumer demonstrates identical semantics.

### Acceptance criteria

- The shared SSE iterator has direct transport-framing tests.
- Vertex, z.ai, and ChatGPT retain their existing request and error semantics.
- Invalid or partial SSE data does not create unhandled rejections.
- ChatGPT diagnostics remain provider-local.
- No public API or package export is added solely for this internal helper.

## GitHub issue map

| Issue | State | Relationship to this hand-off | Action |
|---|---|---|---|
| [#295](https://github.com/overdare/diligent/issues/295) | Closed | Records delayed-frame/close ordering, but current scoped session is not protected | Reference from the new WebSocket-unification issue or reopen for the narrow regression |
| [#296](https://github.com/overdare/diligent/issues/296) | Open | Preserves HTTP upgrade failure metadata | Implement against the unified ChatGPT WebSocket boundary, not only the one-shot path |
| [#307](https://github.com/overdare/diligent/issues/307) | Open | Minimal OpenAI-family lifecycle accumulator | Keep open; clarify malformed-argument compatibility |
| [#308](https://github.com/overdare/diligent/issues/308) | Open | Anthropic conversion stages | Ready to implement |
| New issue | Not registered | Scoped/unscoped ChatGPT WebSocket parity and consolidation | Register before implementation |
| New issue | Not registered | Await external auth readiness for stream and native compaction | Register before implementation |

## Recommended execution order

### Wave 0: characterize correctness gaps

1. Register the two missing issues.
2. Add scoped WebSocket parity tests.
3. Add external-auth readiness tests.

Do not change production behavior in the same commit that first characterizes each gap unless repository workflow
requires a single fix commit. The tests should clearly fail for the current reason before implementation.

### Wave 1: close correctness risks

1. Consolidate ChatGPT WebSocket lifecycle.
2. Await external auth readiness for streams and native compaction.
3. Re-run all ChatGPT, retry, compaction, and runtime auth tests.

### Wave 2: independent internal refactors

- Implement #308. It is independent of the OpenAI/ChatGPT stream work.
- Implement #307 after or separately from WebSocket consolidation, keeping transport code out of the accumulator.

Each issue should remain its own reviewable change.

### Wave 3: mechanical cleanup

Extract the shared JSON SSE iterator and reassess the remaining Vertex/z.ai duplication. Stop if the remaining code is
mostly provider-specific configuration.

## Verification commands

Run focused checks while developing:

```bash
bun test packages/core/test/llm/provider/openai-stream.test.ts
bun test packages/core/test/llm/provider/openai-compatible.test.ts
bun test packages/core/test/llm/provider/openai-web-tools.test.ts
bun test packages/core/test/llm/provider/native-compaction.test.ts
bun test packages/core/test/llm/provider/anthropic.test.ts
bun test packages/core/test/llm/provider/anthropic-web-tools.test.ts
bun test packages/runtime/test/auth/provider-auth.test.ts
bun test packages/core/test/llm/provider-manager.test.ts
```

Run the package-level LLM baseline after each work item:

```bash
NO_COLOR=1 FORCE_COLOR=0 bun test packages/core/test/llm
```

Run repository verification before hand-off or merge:

```bash
bun run typecheck
NO_COLOR=1 FORCE_COLOR=0 bun test
git diff --check
```

If full repository tests are too expensive during iteration, record exactly which focused suites passed and leave the
full command for the final verification step.

## Explicit non-goals

Do not use these work items to introduce:

- another public contract facade or wildcard export;
- a new core/runtime ownership split;
- a provider base class or inheritance hierarchy;
- a provider strategy registry spanning unrelated transports;
- a generic cross-provider WebSocket framework;
- reconnect or replay below `withRetry()`;
- a cross-provider message converter;
- another provider error-classification abstraction pass;
- a model-registry redesign;
- protocol, CLI, Web, or TUI behavior changes; or
- user-facing feature work.

If implementation requires any of the above, stop and reassess the local design before broadening scope.

## Completion definition

This hand-off is complete when:

1. scoped and unscoped ChatGPT WebSocket requests share one lifecycle implementation and parity tests;
2. external auth refresh is awaited for both streams and native compaction;
3. #307 is closed without changing wire decoding or emitted behavior;
4. #308 is closed with Anthropic policies preserved in provider-local stages;
5. any shared SSE utility is internal, characterized, and adopted by at least two current consumers;
6. all targeted tests, core LLM tests, typechecks, and full repository tests pass; and
7. durable implemented behavior is reflected in `ARCHITECTURE.md` or `docs/guide/` only if an existing documented
   invariant actually changes.

Until then, treat this file as implementation planning material rather than the source of truth for current behavior.
