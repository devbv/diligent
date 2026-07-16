# Session lifecycle

This guide describes the current runtime-owned session/thread lifecycle in Diligent.

## Core model

Sessions are project-local and persist under `.diligent/sessions/` as append-only JSONL.

- First line: session header (`type: "session"`, `version`, `id`, `cwd`, optional `parentSession` and child metadata)
- Remaining lines: ordered session entries

In protocol/client surfaces, session IDs are exposed as thread IDs.

## What is persisted

Current persisted entry families include:

- message entries (user/assistant/tool_result)
- model changes (`model_change`)
- mode changes (`mode_change`)
- effort changes (`effort_change`)
- compaction entries (`compaction`)
- optional thread naming (`session_info`)

Runtime can reconstruct multiple views from the same file:

- **context view** for future model calls
- **transcript/snapshot view** for UI rendering

Runtime message entries may be marked `visibility: "internal"` with an opaque `source`. Internal
messages stay replayable in provider context and in the append-only parent chain, but are excluded
from transcripts, snapshots, previews, and visible message counts. Older untagged reminder
messages remain visible because only explicit entry metadata controls visibility.

## Starting and resuming threads

### `thread/start`

- Creates a new session file and returns `{ threadId }`
- Emits `thread/started`
- Sets the started thread as active in runtime
- Updates the requesting connection's `currentThreadId`

Defaults on start:

- `mode` defaults to `default` when omitted
- `cwd` and `mode` can be injected from connection defaults
- effort is initialized from latest effort for the cwd (fallback `medium`)

### `thread/resume`

Params must include either:

- `threadId`, or
- `mostRecent: true`

Behavior:

1. If target thread is already loaded in memory, runtime reuses it.
2. Otherwise runtime searches known cwd session directories, loads the session, and reconstructs state.
3. On success, emits `thread/resumed` with `restoredMessages` and returns `{ found: true, threadId, context }`.
4. On miss, returns `{ found: false }`.

Resume is a runtime operation (not frontend-local reconstruction).

On resume, runtime also repairs orphaned assistant tool calls by appending synthetic `[Cancelled]` tool results when needed.

## Active thread resolution and implicit threadId

For thread-scoped methods (`turn/start`, `turn/interrupt`, `turn/steer`, `thread/read`, `thread/compact/start`, etc.), if `threadId` is omitted:

1. request default uses connection `currentThreadId`
2. runtime fallback uses server `activeThreadId`

If neither exists, runtime returns `No active thread`.

## Listing threads

`thread/list` returns `{ data: SessionSummary[] }` sorted by `modified` descending.

`SessionSummary` fields:

- `id` (session/thread ID)
- `path`
- `cwd`
- `name?`
- `created`
- `modified`
- `messageCount`
- `firstUserMessage?`
- `parentSession?`

Notes:

- child sessions are excluded unless `includeChildren: true`
- runtime default limit is 100; protocol schema caps `limit` at 500

## Reading thread state

`thread/read` returns a runtime-built snapshot:

- `cwd`
- `items`
- `errors?`
- `hasFollowUp`
- `entryCount`
- `isRunning`
- `currentEffort`
- `currentModel?`
- `totalCost?`

Important behavior:

- if thread is idle, runtime can reconcile memory from disk before producing the snapshot
- `items` are built from transcript entries (`userMessage`, `agentMessage`, `toolCall`, `compaction`)
- live collaboration status can be overlaid onto persisted snapshot items
- `errors` are runtime in-memory errors, not a persisted session entry family

## Turn lifecycle hooks into thread lifecycle

`turn/start` drives thread busy/idle transitions:

1. runtime marks thread busy and emits `thread/status/changed` (`busy`)
2. emits `turn/started`
3. runs turn
4. emits `turn/completed` or `turn/interrupted`
5. emits `thread/status/changed` (`idle`)

Related operations:

- `turn/interrupt`: aborts only when a turn is currently running
- `turn/steer`: queues steering in session manager for a subsequent run boundary

## Lifecycle hook modes

Diligent has two hook tiers. The shell/plugin hooks below are coarse external lifecycle hooks and
may perform asynchronous I/O. Separately, trusted bundled product code can register synchronous
`AgentLoopHook` factories through `BundledToolProvider`. Runtime creates fresh hook instances per
main or child Agent; these hooks can observe sampling-loop phases and return structured internal
user-context injections, but cannot run tools, mutate Agent history directly, or cross the client
protocol. A throwing loop hook is logged and disabled for that Agent without failing the turn.
The built-in main-Agent plan reminder is enabled by default with a six-turn cadence. Set
`planReminderIntervalTurns` to `0` to disable it or to another non-negative integer to tune the
cadence.

Shell lifecycle hooks support two execution modes:

- `mode: "sync"` (default): runtime waits for the hook result before continuing. Sync hooks can block the turn or return `additionalContext`. The default timeout is 10 seconds unless `timeout` is set.
- `mode: "async"`: runtime starts the hook and immediately continues the turn. Async hook output is ignored and cannot block or inject context.

Current hook events:

- `UserPromptSubmit`: runs after the user submits a prompt and before the agent turn starts.
- `Stop`: runs after a successful turn completion.

## Manual compaction

`thread/compact/start` is explicit user-triggered compaction.

- rejected while a turn is running
- marks thread busy and emits `thread/status/changed` (`busy`)
- emits `thread/compaction/started`
- runs compaction and emits `thread/compacted`
- always returns thread to idle with `thread/status/changed` (`idle`)

On failure, runtime emits `error` and still restores idle status.

## Deleting threads

`thread/delete`:

- rejects deletion of currently running in-memory thread
- removes session file from disk (across known cwd session roots)
- removes in-memory runtime state for that thread
- clears active thread when deleting the active one
- returns `{ deleted: boolean }`

## Subscription and notification fanout

Thread lifecycle notifications are runtime-owned and shared by all clients.

- `thread/subscribe` registers a connection-level subscription to a thread
- `thread/unsubscribe` removes that subscription
- when subscribers exist, thread-scoped notifications fan out to subscribers
- if no subscriber exists, notifications fall back to broadcast

This keeps Web/TUI/Desktop aligned on the same thread state machine.

## Key code paths

- `packages/runtime/src/app-server/server.ts`
- `packages/runtime/src/app-server/thread-handlers.ts`
- `packages/runtime/src/app-server/thread-read-builder.ts`
- `packages/runtime/src/session/manager.ts`
- `packages/runtime/src/session/persistence.ts`
- `packages/runtime/src/session/types.ts`
- `packages/protocol/src/methods.ts`
- `packages/protocol/src/client-requests.ts`
- `packages/protocol/src/server-notifications.ts`
- `packages/protocol/src/data-model.ts`
- `packages/e2e/protocol-lifecycle.test.ts`
- `packages/e2e/session-resume.test.ts`
