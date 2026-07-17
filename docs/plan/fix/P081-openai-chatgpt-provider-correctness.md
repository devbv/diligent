---
id: P081
status: done
created: 2026-07-17
---

# P081: OpenAI and ChatGPT provider correctness fixes

## Goal

Fix six confirmed correctness gaps in the OpenAI and ChatGPT providers while
preserving the current provider architecture and public protocol contracts.

The comparison baseline is:

- Diligent: `f5803399` plus the working tree as reviewed on 2026-07-17
- Codex: `/Users/devbv-mini4/git/codex` at `315195492c`

This plan covers findings 2 through 7 from that comparison. Finding 1, the
ChatGPT GPT-5.6 WebSocket v2 request contract, is explicitly deferred.

## Scope

| Finding | Area | Required outcome |
|---------|------|------------------|
| 2 | ChatGPT OAuth refresh | Accept partial refresh responses and preserve valid prior token fields |
| 3 | OpenAI-family error mapping | Classify provider error codes before falling back to message heuristics |
| 4 | HTTP/SSE streaming | Bound stream inactivity after response headers for both OpenAI and ChatGPT |
| 5 | ChatGPT native compaction | Send the canonical `session-id` header |
| 6 | Responses incomplete events | Fail non-token-limit incomplete responses instead of reporting success |
| 7 | OpenAI request and compaction | Set `store: false` and stop masking generic HTTP 400 compaction failures |

### Explicitly deferred

The following WebSocket v2 parity work is not part of P081:

- the `OpenAI-Beta: responses_websockets=2026-02-06` handshake header
- per-request `client_metadata`
- Responses Lite metadata markers
- server turn-state capture and replay
- `previous_response_id`, input-delta, or prewarm behavior

That work must be planned and implemented separately from these fixes. P081
must not change the current WebSocket request contract while addressing the
shared Responses event classifier.

### Other non-goals

- No new Web or TUI feature or setting.
- No protocol schema change unless implementation proves that the existing
  `ProviderError` taxonomy cannot represent a required result.
- No general provider architecture rewrite.
- No dynamic OpenAI model catalog work.
- No cross-provider timeout policy change outside OpenAI and ChatGPT.

## Confirmed decisions

1. OAuth refresh responses are partial updates. Missing `id_token` or
   `refresh_token` fields retain the previous values.
2. Provider error codes are authoritative when present. Message matching is a
   compatibility fallback, not the primary classifier.
3. Stream timeout means idle timeout, not a maximum duration for a complete
   response. The deadline resets whenever the stream makes progress.
4. `response.incomplete` with `max_output_tokens` remains a successful partial
   result with `stopReason: "max_tokens"`.
5. Any other known or unknown incomplete reason is an error and must not emit a
   successful terminal `done` event.
6. Regular OpenAI Responses requests explicitly send `store: false`.
7. Native compaction treats HTTP 404 and 405 as unsupported. A generic HTTP 400
   remains a provider error unless its structured error code explicitly means
   that the compaction endpoint or operation is unsupported.

## Current behavior and failure modes

### 1. OAuth refresh assumes a full authorization response

`refreshChatGPTTokens()` passes its response to `buildOAuthTokens()`, whose
input requires `access_token`, `refresh_token`, and `id_token`. The builder
unconditionally parses `id_token` as a JWT. A valid refresh response that omits
an unchanged `id_token` therefore throws while calling `split()` on
`undefined`.

Codex accepts all three returned token fields as optional during refresh and
merges replacements over the previous token set.

### 2. Structured provider error codes are decoded but ignored

The Responses SSE parser retains `error.code`, but classification is currently
driven by status and message text. For example:

```json
{
  "code": "context_length_exceeded",
  "message": "Your input exceeds the context window of this model. Please adjust your input and try again."
}
```

is classified as an unknown non-retryable error. That prevents the agent from
entering its context-overflow compaction path. The same weakness affects rate
limits, quota exhaustion, policy rejection, and overload responses.

### 3. HTTP/SSE timeout ends after headers

ChatGPT bounds the wait for response headers, then clears the timer before
reading the body. OpenAI's SDK request timeout similarly does not provide the
required per-event idle guarantee after `fetch()` has returned. A connected
server that never produces another SSE event can therefore stall indefinitely.

### 4. ChatGPT native compaction uses a non-canonical header

Normal ChatGPT requests send `session-id`, but native compaction sends
`session_id`. The current unit test asserts the incorrect spelling and must be
changed before the implementation.

### 5. Non-token-limit incomplete responses look successful

`response.incomplete` currently reaches a successful terminal state for all
reasons. `content_filter`, for example, emits `done` with an error-like stop
reason but does not emit a `ProviderError`. The agent loop can treat an empty or
blocked response as a completed assistant turn.

### 6. OpenAI request persistence and compaction fallback are too broad

The regular OpenAI Responses body leaves `store` unspecified, while the
ChatGPT body already enforces `store: false`. Native OpenAI compaction also
converts every HTTP 400 into `unsupported`, hiding malformed requests,
authentication-adjacent errors, and provider diagnostics.

## Implementation tasks

Implement in the following order. Each task starts by changing or adding the
tests that demonstrate the intended behavior.

### Task 0: Restore a clean provider-auth test baseline

**File:** `packages/runtime/test/auth/provider-auth.test.ts`

Repair the mock SSE fixture that contains consecutive `data:` lines without an
empty line between events. The standards-compliant event parser correctly
combines those lines into one event, so the fixture does not currently reach a
terminal response.

Requirements:

- Separate independent SSE events with `\n\n`.
- Do not loosen the production parser to accommodate the invalid fixture.
- Confirm the focused baseline passes before starting behavior changes.

### Task 1: Merge partial ChatGPT OAuth refresh responses

**Files:**

- `packages/core/src/auth/chatgpt-oauth/refresh.ts`
- `packages/core/src/auth/chatgpt-oauth/token-exchange.ts`
- `packages/core/test/auth/chatgpt-oauth/refresh.test.ts`
- `packages/core/test/auth/chatgpt-oauth/token-exchange.test.ts`
- `packages/runtime/test/auth/provider-auth.test.ts`

Separate the full authorization-code exchange shape from the partial refresh
response shape. Do not weaken validation for the initial code exchange.

Refresh requirements:

- Validate that the response body is an object before reading fields.
- Accept optional `access_token`, `refresh_token`, and `id_token` fields.
- Reject present token fields that are not non-empty strings.
- Merge returned fields over the previously stored token set.
- Require the merged result to contain a usable access token.
- Preserve the previous refresh token when the response omits it.
- Preserve the previous ID token and account metadata when the response omits
  `id_token`.
- Recompute account metadata only when a replacement JWT is present and valid.
- Compute expiry from a valid returned `expires_in`; otherwise preserve the
  existing expiry rather than inventing a new one.
- Persist and publish refreshed tokens only after a valid merged result exists.

Required tests:

- access token only
- access token plus expiry, without ID or refresh token
- rotated refresh token
- replacement ID token and refreshed account metadata
- omitted access token with a still-valid prior access token
- malformed returned token field
- malformed replacement ID token
- failed refresh does not overwrite stored credentials

### Task 2: Add a shared code-first OpenAI error classifier

**Files:**

- `packages/core/src/llm/provider/openai/sse.ts`
- `packages/core/src/llm/provider/openai/responses.ts`
- `packages/core/src/llm/provider/openai/index.ts`
- `packages/core/src/llm/provider/openai/shared.ts`
- `packages/core/test/llm/provider/openai/errors.test.ts`
- `packages/core/test/llm/provider/chatgpt/responses-stream.test.ts`
- `packages/core/test/llm/provider/chatgpt/retry-classification.test.ts`

Create one classifier used by both SDK-thrown OpenAI errors and Responses
stream failures. Its inputs should include status, structured code, message,
and cause where available.

Classification order:

1. structured provider code
2. HTTP status
3. message compatibility patterns
4. unknown fallback

At minimum, cover:

| Provider code or family | Diligent behavior |
|-------------------------|-------------------|
| `context_length_exceeded` | `ContextWindowExceeded`, non-retryable at provider layer so the agent can compact |
| `rate_limit_exceeded` | rate-limit error, retryable when the response represents transient throttling |
| `insufficient_quota`, usage-limit codes | `UsageLimitReached`, non-retryable |
| `server_error`, `overloaded` | server/network class, retryable |
| `invalid_prompt`, `bio_policy` | preserve code and message, non-retryable |
| authentication codes or HTTP 401/403 | rejected credentials, non-retryable |

Requirements:

- Preserve the original provider code, status, and cause for diagnostics.
- Retain message heuristics for providers or proxies that omit a code.
- Recognize the exact `context_length_exceeded` sample above.
- Keep quota exhaustion distinct from transient rate limiting.
- Parse a provider-supplied retry delay when the existing error contract can
  carry it; otherwise preserve it in the cause without adding a protocol field.
- Avoid duplicating classification logic between HTTP and SSE paths.

Required tests assert both the final error category and retryability. Include a
focused agent-level assertion if existing coverage does not prove that a coded
context error reaches the compaction recovery branch.

### Task 3: Add HTTP/SSE stream idle timeouts

**Files:**

- `packages/core/src/llm/provider/chatgpt/http-sse.ts`
- `packages/core/src/llm/provider/chatgpt/index.ts`
- `packages/core/src/llm/provider/openai/index.ts`
- `packages/core/src/llm/provider/openai/shared.ts`
- `packages/core/test/llm/provider/chatgpt/http-sse.test.ts`
- `packages/core/test/llm/provider/chatgpt/http-transport.test.ts`
- `packages/core/test/llm/provider/openai/client-options.test.ts`
- `packages/core/test/llm/provider/openai/stream-timeout.test.ts` (create if no
  existing test file provides a natural home)

Add a reusable idle-timeout wrapper at the async-iterator or body-reader
boundary. Header timeout and stream idle timeout are separate configuration
values. `AbortSignal` remains a runtime option, not configuration.

Requirements:

- Start the idle timer while waiting for the next body chunk or SDK stream
  event.
- Reset the timer after every successfully received chunk or event.
- Do not impose a total-response deadline while progress continues.
- On idle timeout, cancel or abort the upstream reader/request and emit a
  retryable network `ProviderError`.
- Preserve caller abort semantics; a caller abort must not be rewritten as an
  idle timeout.
- Clear timers and abort listeners on success, failure, and cancellation.
- Avoid abandoned rejecting promises or unhandled reader errors after a timeout.
- Keep the existing ChatGPT response-header timeout behavior.
- Do not modify the WebSocket timeout or request contract in this task.

Tests should use short injected timeout values and fake delayed streams. Do not
wait on production-duration timers.

### Task 4: Correct the ChatGPT compaction session header

**Files:**

- `packages/core/src/llm/provider/chatgpt/native-compaction.ts`
- `packages/core/test/llm/provider/native-compaction.test.ts`

First change the test to require `session-id` and reject `session_id`, then fix
the implementation. Prefer a shared ChatGPT header constant or helper if it can
be introduced without coupling compaction to transport-specific code.

Required assertions:

- a provided session ID appears exactly as `session-id`
- `session_id` is absent
- requests without a session ID send neither spelling

### Task 5: Make incomplete response handling explicit

**Files:**

- `packages/core/src/llm/provider/openai/sse.ts`
- `packages/core/src/llm/provider/openai/content-accumulator.ts`
- `packages/core/test/llm/provider/chatgpt/responses-stream.test.ts`
- `packages/core/test/llm/provider/chatgpt/http-transport.test.ts`
- `packages/core/test/llm/provider/openai/content-accumulator.test.ts`

Apply these terminal semantics:

| Incomplete reason | Terminal result |
|-------------------|-----------------|
| `max_output_tokens` | preserve usage and partial content, then emit `done` with `stopReason: "max_tokens"` |
| `content_filter` | emit a non-retryable provider error; do not emit `done` |
| missing or unknown reason | emit a non-retryable provider error; do not emit `done` |

Requirements:

- Preserve usage emitted with the incomplete response before termination.
- Include the incomplete reason in the diagnostic cause or message.
- Ensure the content accumulator cannot append a successful `done` event after
  an incomplete error.
- Preserve the current successful behavior for `max_output_tokens`.
- Apply the same event semantics to OpenAI and ChatGPT because they share the
  Responses event parser.

### Task 6: Make OpenAI storage and compaction failures precise

**Files:**

- `packages/core/src/llm/provider/openai/index.ts`
- `packages/core/src/llm/provider/openai/native-compaction.ts`
- `packages/core/test/llm/provider/openai/client-options.test.ts`
- `packages/core/test/llm/provider/native-compaction.test.ts`

Request requirements:

- Send `store: false` explicitly in regular OpenAI Responses requests.
- Assert the field in the captured request body so behavior does not depend on
  OpenAI or proxy defaults.

Compaction requirements:

- Return `unsupported` for HTTP 404 and 405.
- Return `unsupported` for HTTP 400 only when a structured, allowlisted error
  code unambiguously indicates that compaction is unsupported.
- Throw a detailed provider error for all other HTTP 400 responses.
- Preserve structured error code and message in the thrown error.
- Keep custom OpenAI-compatible base URLs supported.

Required tests:

- request body contains `store: false`
- 404 and 405 use fallback behavior
- generic 400 is thrown
- structured invalid-request 400 preserves diagnostics
- an allowlisted unsupported-operation code falls back, if such a code is
  confirmed from a real provider response; do not invent an allowlist entry
  only to satisfy the test

## File manifest

| Area | Files |
|------|-------|
| OAuth | `packages/core/src/auth/chatgpt-oauth/{refresh,token-exchange}.ts` and mirrored tests |
| Shared Responses errors | `packages/core/src/llm/provider/openai/{sse,responses,shared,index}.ts` and provider tests |
| HTTP/SSE timeout | ChatGPT `http-sse.ts` and `index.ts`, OpenAI `index.ts`/shared helper, timeout tests |
| Native compaction | OpenAI and ChatGPT `native-compaction.ts`, shared provider compaction test |
| Runtime credential binding | `packages/runtime/test/auth/provider-auth.test.ts`; runtime source only if merging cannot stay in core |

Keep new tests under package-level `test/` directories and mirror the source
layout. No test belongs under `src/**/__tests__/`.

## Acceptance criteria

- A partial ChatGPT refresh response cannot erase unchanged credentials or
  crash because `id_token` is absent.
- A coded context-window error triggers the existing context-overflow recovery
  path.
- Quota, throttling, overload, authentication, and policy errors have stable
  retryability based on code before message text.
- A stalled OpenAI or ChatGPT HTTP/SSE body terminates with a retryable timeout
  error, while an indefinitely long but active stream continues.
- ChatGPT native compaction sends `session-id`, never `session_id`.
- Only `max_output_tokens` incomplete responses complete successfully.
- OpenAI Responses requests explicitly send `store: false`.
- Generic OpenAI compaction HTTP 400 responses surface their diagnostics and do
  not silently fall back.
- No P081 change adds WebSocket v2 metadata, turn-state replay, or handshake
  behavior.
- Typecheck and all focused tests pass.

## Verification

Run focused tests after each task, then finish with:

```bash
bun test packages/core/test/auth/chatgpt-oauth \
  packages/core/test/llm/provider/chatgpt \
  packages/core/test/llm/provider/openai \
  packages/core/test/llm/provider/native-compaction.test.ts \
  packages/runtime/test/auth/provider-auth.test.ts

bun run typecheck
git diff --check
```

Before implementation, the focused test command has one known fixture failure
in `packages/runtime/test/auth/provider-auth.test.ts`. Task 0 must remove that
baseline failure without changing production parsing.

## Delivery sequence

1. Repair the invalid SSE fixture and establish a green baseline.
2. Implement OAuth merging independently from provider streaming changes.
3. Land the shared error classifier before incomplete-event handling so both
   paths use one terminal error policy.
4. Add idle timeouts and verify cleanup/abort behavior.
5. Apply the two small native compaction corrections.
6. Run the full focused suite, typecheck, and diff validation.

If a task reveals a required public protocol change, stop and revise this plan
before expanding scope. None is expected for the confirmed fixes.
