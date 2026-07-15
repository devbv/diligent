---
id: P074
status: done
created: 2026-07-14
completed: 2026-07-14
---

# P074: ChatGPT WebSocket streaming parity with Codex

## Goal

Bring Diligent's ChatGPT GPT-5.6 WebSocket Responses Lite path closer to the
Codex WebSocket behavior for long-running streams and provider error handling.

This is a handoff document for the next implementer. It covers two issues that
should be fixed together:

1. WebSocket send/receive/open paths currently have no Codex-style idle timeout.
2. WebSocket usage-limit and other HTTP-shaped failures can be flattened into a
   generic network error, especially during connection/open failure.

## User context

The user compared Diligent against `~/git/codex` and specifically called out
the Codex behavior in:

- `/Users/devbv/git/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs`

Important Codex behavior to mirror where practical:

- `ResponsesWebsocketClient::connect` applies the provider's
  `stream_idle_timeout` to the connection.
- `run_websocket_response_stream` wraps receive waits with
  `tokio::time::timeout(idle_timeout, ws_stream.next())`.
- `send_websocket_request` wraps send with the same idle timeout.
- Timeout, server close, and receive error become stream errors.
- `WsStream` replies to server Ping with Pong.
- There is no proactive client heartbeat ping.
- Wrapped text error events are parsed before normal Responses events.

The user additionally observed that while doing WebSocket work, usage-limit
cases appear to be getting treated as generic network errors. That observation
is valid for the current Diligent implementation in several connection-failure
paths.

## Current Diligent state

Primary files:

- `packages/core/src/llm/provider/chatgpt.ts`
- `packages/core/src/llm/provider/openai-sse.ts`
- `packages/core/test/llm/provider/openai-stream.test.ts`

The ChatGPT provider already has a GPT-5.6 WebSocket Responses Lite path:

- `createChatGPTStream(...)`
- `isGpt56Model(upstreamModelId)` selects WebSocket for GPT-5.6 family models.
- `createChatGPTWebSocketEvents(...)` opens
  `wss://chatgpt.com/backend-api/codex/responses`.
- The request is sent in the WebSocket `open` handler.
- Incoming WebSocket `message` events are parsed as JSON and pushed into an
  `AsyncEventQueue`.
- `handleResponsesAPIEvents(...)` consumes the queue and emits provider events.

Existing tests cover the high-level WebSocket route and a few error cases in
`openai-stream.test.ts`:

- GPT-5.6 uses WebSocket and Responses Lite.
- Legacy ChatGPT models stay on HTTP/SSE.
- Post-open close before `response.completed` becomes retryable via the generic
  `stream closed before response.completed` path.
- Top-level post-open `{ type: "error", status: 400, ... }` is surfaced.
- Abort terminates the fake socket.

## Gaps versus Codex

### 1. No WebSocket idle timeout

`createChatGPTWebSocketEvents(...)` currently has no timeout around:

- waiting for `open`
- sending the request frame
- waiting for the next message
- waiting for a terminal event (`response.completed` / `response.failed`)

If the socket connects but the server stalls, the provider stream can hang until
the outer caller aborts it. This differs from Codex, where each send and receive
wait is bounded by the provider stream idle timeout.

### 2. Server close loses detail

After a successful open, `handleClose(...)` currently calls `queue.end()` and
cleans up. The later `handleResponsesAPIEvents(...)` layer notices that no
`response.completed` arrived and emits:

```text
stream closed before response.completed
```

That is retryable, but it loses WebSocket close code and reason. Codex reports a
more direct WebSocket stream error such as server close before completion.

### 3. Usage-limit can collapse to network

Diligent only preserves usage-limit details if the server successfully opens the
socket and then sends a text message like:

```json
{
  "type": "error",
  "status": 429,
  "error": {
    "type": "usage_limit_reached",
    "message": "The usage limit has been reached"
  }
}
```

That path flows through `toChatGPTWebSocketError(...)` and becomes a user-facing
usage-limit message.

However, if the failure happens during WebSocket upgrade/open, the current
browser/Bun WebSocket API path usually exposes only `error` or pre-open `close`.
The implementation then emits one of these generic network errors:

```text
ChatGPT WebSocket connection failed
ChatGPT WebSocket connection closed before opening (...)
```

This can incorrectly make usage-limit/auth/HTTP-shaped provider failures look
retryable and network-related.

### 4. Wrapped error parsing is weaker than Codex

Codex parses wrapped WebSocket error text before normal Responses event parsing:

- `type: "error"`
- `status` or `status_code`
- `error.code`
- `error.message`
- `headers`

Relevant Codex tests in `responses_websocket.rs`:

- `parse_wrapped_websocket_error_event_maps_to_transport_http`
- `parse_wrapped_websocket_error_event_with_status_maps_invalid_request`
- `parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable`
- `parse_wrapped_websocket_error_event_without_status_is_not_mapped`

Diligent's `toChatGPTWebSocketError(...)` currently supports `status`,
`error.type`, and `error.message`, but does not support:

- `status_code` alias
- `error.code`
- preserving response headers
- special handling for `websocket_connection_limit_reached`

## Proposed implementation

### Timeout behavior

Add a WebSocket idle timeout for ChatGPT GPT-5.6 streams.

Suggested shape:

```ts
const CHATGPT_WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
```

Use one timer in `createChatGPTWebSocketEvents(...)` and reset it on meaningful
progress:

- after WebSocket `open`
- before/after successful request `send`
- after every valid `message`
- when the stream reaches a terminal event
- when abort/cleanup runs

On timeout, fail the queue/open promise with a retryable network `ProviderError`:

```text
ChatGPT WebSocket idle timeout waiting for response
```

Use distinct wording for open/send if useful:

- `ChatGPT WebSocket idle timeout waiting for connection`
- `ChatGPT WebSocket idle timeout sending request`
- `ChatGPT WebSocket idle timeout waiting for response`

Keep timeout errors retryable unless the request already emitted a completed tool
call. Retry suppression after completed tool calls is already handled at the
higher retry layer.

### Send timeout

`WebSocket.send(...)` is synchronous for the current API, so there is no direct
Promise to race like Codex does with Rust async send. Still handle two cases:

1. If `send(...)` throws, fail immediately with a retryable network error.
2. If the socket opens but no subsequent server event arrives, the receive idle
   timeout covers the practical stuck-send/stuck-server case.

If a future lower-level WebSocket client is introduced and exposes async send,
wrap that send with the same idle timeout.

### Close handling

Track whether a terminal Responses event has been seen inside
`createChatGPTWebSocketEvents(...)`:

- terminal success: `response.completed`
- terminal failure: `response.failed` or wrapped `type: "error"`

If `close` occurs after `open` but before a terminal event, fail instead of just
ending the queue:

```text
ChatGPT WebSocket closed before response.completed (1006: connection closed)
```

Use `ProviderError(..., "network", true)` for this close-before-terminal path.

### Wrapped error parsing

Replace or extend `toChatGPTWebSocketError(...)` into a small parser that mirrors
the Codex wrapped-error behavior where possible.

Parsing requirements:

- Accept `status` and `status_code`.
- Accept `error.type`, `error.code`, and `error.message`.
- Treat `error.code === "websocket_connection_limit_reached"` as retryable.
- Treat `429 + usage_limit_reached` as a user-facing usage-limit error, not
  network and not retryable.
- Treat generic `429` as `rate_limit`, not retryable.
- Treat `401`/`403` as `auth`, not retryable.
- Treat `>=500` as `server_error`, retryable.
- Preserve status on `ProviderError`.
- If headers matter later, add a `cause` object with headers/body because
  `ProviderError` does not currently have a first-class headers field.

Suggested detection:

```ts
const status =
  typeof payload.status === "number"
    ? payload.status
    : typeof payload.status_code === "number"
      ? payload.status_code
      : undefined;

const errorCode = typeof error?.code === "string" ? error.code : undefined;
const errorType = typeof error?.type === "string" ? error.type : undefined;
const isUsageLimit =
  errorType?.includes("usage_limit") ||
  errorCode?.includes("usage_limit") ||
  message.includes("usage_limit_reached") ||
  message.toLowerCase().includes("usage limit");
```

### Upgrade/open failure caveat

The current `WebSocket` constructor path may not expose HTTP upgrade response
status/body/headers on failure. If Bun's WebSocket API cannot surface that data,
then not all usage-limit failures can be perfectly classified from the current
transport.

Options if that becomes a blocker:

1. Use a lower-level WebSocket client that exposes handshake HTTP failures.
2. Add a diagnostic/preflight fallback only after a generic pre-open failure.
3. Keep generic network for truly opaque failures, but avoid retrying forever by
   making the retry policy aware of repeated pre-open failures.

Do not add proactive heartbeat pings unless there is evidence they are needed;
Codex does not send client heartbeats.

## Test plan

Add tests to `packages/core/test/llm/provider/openai-stream.test.ts` near the
existing `createChatGPTStream retry classification` suite.

Extend `FakeChatGPTWebSocket` as needed to support:

- delayed open
- open without response
- send throw
- post-open close with code/reason
- post-open wrapped error with `status_code`
- post-open wrapped error with `error.code`

Recommended tests:

1. **Idle timeout before open**
   - Fake socket never dispatches `open`.
   - Stream emits retryable network timeout error.
   - Socket is closed/terminated.

2. **Idle timeout after open while waiting for response**
   - Fake socket opens and records send but emits no messages.
   - Stream emits retryable network timeout error.

3. **Post-open close preserves close reason**
   - Fake socket opens, then closes with code/reason before completion.
   - Error message includes close code/reason.
   - Error is retryable network.

4. **Post-open usage limit is not network**
   - Emit wrapped error with `status: 429` and
     `error.type: "usage_limit_reached"`.
   - Error message is the user-facing usage-limit message.
   - Error is not retryable.
   - Error type is not `network`.

5. **`status_code` alias works**
   - Emit wrapped error with `status_code: 429`.
   - It is classified like `status: 429`.

6. **WebSocket connection limit is retryable**
   - Emit wrapped error with
     `error.code: "websocket_connection_limit_reached"`.
   - Error is retryable even if the status is 400.

7. **Generic 429 remains rate-limit/non-retryable**
   - Emit wrapped error with status 429 but no usage-limit marker.
   - Classify as `rate_limit`, not retryable.

Run targeted tests first:

```bash
bun test packages/core/test/llm/provider/openai-stream.test.ts
```

Then run core typecheck or full repository validation as appropriate:

```bash
bun run typecheck
bun run lint
```

## Acceptance criteria

- ChatGPT GPT-5.6 WebSocket streams cannot hang indefinitely while opening,
  sending, or waiting for events.
- Close-before-completion errors include WebSocket close code/reason when
  available.
- Post-open wrapped WebSocket usage-limit errors are not reported as network
  errors and are not retried.
- `status_code` alias and `websocket_connection_limit_reached` are covered by
  tests.
- Opaque upgrade/open errors are documented as transport limitations if the
  current WebSocket API cannot expose HTTP response details.
- Existing HTTP/SSE ChatGPT behavior for non-GPT-5.6 models is unchanged.

## Implementation notes

- Implemented in `packages/core/src/llm/provider/chatgpt.ts` with a 300s
  WebSocket idle timeout for open/send/receive phases.
- `packages/web/src/server/index.ts` already has `websocket.idleTimeout: 240`,
  but that is for the browser-to-Diligent-server inbound WebSocket. The P074 fix
  is for the separate Diligent-server-to-ChatGPT outbound WebSocket stream.
- The web client's `HEARTBEAT_METHOD = "ping"` is an application-level JSON-RPC
  keepalive for that inbound WebSocket, not a WebSocket protocol Ping control
  frame. The current Bun/browser-style outbound `WebSocket` interface used for
  ChatGPT does not expose raw Ping control frames to application code. Diligent
  therefore relies on the runtime's WebSocket implementation for protocol-level
  Ping/Pong handling rather than adding an application heartbeat. This matches
  the "no proactive client ping" part of Codex, but manual Pong logic would
  require a lower-level WebSocket transport if the runtime ever proves
  insufficient.
- Added focused coverage in
  `packages/core/test/llm/provider/openai-stream.test.ts` for open timeout,
  receive timeout, send throw, close-before-completion detail, usage-limit
  classification, `status_code`, and `websocket_connection_limit_reached`.
- Follow-up review found that asynchronous message decoding could race a socket
  close. Close finalization is now serialized behind pending message work, with
  regression coverage for a delayed terminal Blob payload followed immediately
  by a normal close. This resolves GitHub issue #295.
- HTTP upgrade status/body/header preservation remains tracked separately in
  GitHub issue #296. Bun 1.3.10's browser-style outbound `WebSocket` API does not
  expose upgrade response metadata, and no handshake-capable WebSocket client is
  currently installed. Satisfying that issue therefore requires a deliberate
  provider-scoped transport dependency or lower-level handshake implementation,
  rather than another wrapper around the existing constructor.
- Set `DILIGENT_DEBUG_CHATGPT_WEBSOCKET=1` to print outbound/inbound frame sizes,
  concise event summaries, and open/close/error/timeout lifecycle lines. Text,
  ArrayBuffer, and typed-array frames are summarized in the message callback;
  Blob frames log `pending_decode` immediately and a second `decoded` line after
  conversion. Delta content and request bodies are not printed.

Example:

```text
[llm:chatgpt-ws] state=open
[llm:chatgpt-ws] -> bytes=1842 response.create model=gpt-5.6-luna inputItems=4
[llm:chatgpt-ws] <- bytes=92 response.output_text.delta deltaChars=18
[llm:chatgpt-ws] <- bytes=147 response.completed status=completed in=123 out=45
[llm:chatgpt-ws] state=close code=1000 reason=none pendingDecode=0
```

## Gotchas

- `handleResponsesAPIEvents(...)` already emits retryable
  `stream closed before response.completed` if an iterable ends before a
  terminal event. Once close-before-terminal is handled inside
  `createChatGPTWebSocketEvents(...)`, avoid double-emitting errors.
- `AsyncEventQueue.fail(...)` rejects pending `next()` calls; make sure cleanup
  removes listeners and clears timers exactly once.
- Do not classify usage-limit as `rate_limit` if the product wants the friendlier
  "AI usage limit reached" copy. The current HTTP ChatGPT path uses that copy
  for `usage_limit_reached`.
- Do not make all 429 retryable. Existing ChatGPT HTTP tests assert generic 429
  is not retried.
- Do not introduce client heartbeat pings as part of this fix. The Codex
  reference only replies to server Ping with Pong.

## Related knowledge

Persistent backlog entry:

- `backlog.chatgpt-websocket-idle-timeout`
