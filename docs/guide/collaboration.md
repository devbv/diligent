# Collaboration

This guide describes the current collaboration model in Diligent.

## Verified contract

Collaboration lets the main agent delegate work to child agents and then coordinate with them through runtime-managed tools.

The collaboration tool set is:

- `spawn_agent`
- `wait`
- `send_input`
- `close_agent`

These tools are runtime features, not frontend-local behavior.

In the shared protocol and frontend-facing data model, collaboration currently exposes:

- dedicated collaboration begin/end event pairs
- child-thread-aware message and tool events via `childThreadId` and `nickname`
- explicit child status values: `pending`, `running`, `completed`, `errored`, `shutdown`
- child references and wait-status payloads that clients can render directly

The runtime owns these semantics and publishes them through the shared protocol so Web, TUI, and Desktop stay aligned.

## Tool contracts

### `spawn_agent`

`spawn_agent` starts a child agent session and returns immediately with `thread_id` and `nickname`.

Current parameters are:

- `message`: full worker brief for the child
- `description?`: short status label
- `agent_type?`: built-in or custom agent role name
- `resume_id?`: existing child session to resume
- `allow_nested_agents?`: explicit opt-in for nested delegation
- `allowed_tools?`: optional child-tool allow-list that can only narrow access

Important current behavior:

- Spawn is non-blocking.
- The runtime emits `collab_spawn_begin`, then an early `collab_spawn_end` with status `running` once the child has been registered.
- The child may later finish successfully or fail independently of the initial spawn result.
- Nested delegation is disabled by default unless explicitly enabled for the spawned child.
- The parent cannot override the child model class per spawn. A custom role's configured `model_class` wins; otherwise the child inherits the parent model class.
- Child tool access is filtered from the parent-visible tool set; nested collaboration tools remain excluded unless nested delegation was explicitly enabled.

### `wait`

`wait` blocks until all specified child agents complete or timeout expires.

Current parameters are:

- `ids`: one or more child thread IDs
- `timeout_ms?`: clamped to the runtime range of 60,000 ms to 3,600,000 ms, with a default of 900,000 ms

`wait` returns:

- per-agent final or current status
- a `timed_out` flag
- a human-readable summary list derived from child status

If some children are still running when the timeout or abort signal fires, the result preserves their current status rather than inventing a final one.

### `send_input`

`send_input` injects steering text into a running child agent.

Current parameters are:

- `id`: child thread ID
- `message`: steering prompt

This does not interrupt the child immediately. It queues steering through the child session manager so the child incorporates it on the next turn boundary.

### `close_agent`

`close_agent` aborts a child and waits for it to settle.

Current parameters are:

- `id`: child thread ID

The returned payload reports the child thread ID, nickname, and the final status observed before the registry marks that child as `shutdown` for future reference.

## Waiting, interaction, and closing

- `wait` collects completion status from one or more child agents
- `send_input` sends steering input to a running child agent
- `close_agent` aborts or closes a child session and reports final status

The current collaboration model is asynchronous: a child can keep running after spawn, and the parent can later wait on it, steer it, or close it.

## Child session model and persistence

Child sessions are normal runtime sessions with extra metadata.

When the runtime spawns a child, it creates a session with:

- `parentSession` pointing at the parent session ID
- persisted child metadata such as `nickname` and optional `description`

In practice this means the runtime can distinguish child sessions from top-level sessions and associate them with the parent conversation.

Because session IDs are exposed to clients as thread IDs, the child session ID is the canonical child `thread_id` returned by collaboration tools.

## Collaboration events and notifications

Collaboration has dedicated begin/end event pairs rather than only generic tool output.

Current protocol/runtime surfaces include collaboration event families for:

- spawn begin/end
- wait begin/end
- interaction begin/end
- close begin/end

These are surfaced to clients as collaboration-aware agent events and notifications.

Current event details that matter to client behavior:

- `collab_spawn_end` includes `childThreadId`, `nickname`, optional `description`, the original prompt, and the child status
- `collab_wait_end` reports child statuses and timeout information
- `collab_interaction_begin` / `collab_interaction_end` model `send_input`
- `collab_close_end` reports the child status and message observed before the registry moves that agent into `shutdown`

In addition to collab boundary events, child turns reuse normal runtime events such as `turn_start`, `message_start`, `message_delta`, `message_end`, `tool_start`, `tool_update`, and `tool_end`, annotated with `childThreadId` and `nickname`.

That lets clients render child progress with the same event vocabulary they already use for the main agent.

## Resume behavior

On resume, runtime restores historical child-agent references from prior collaboration results back into the live agent registry.

That means resumed sessions can retain awareness of previously spawned children instead of treating the past collaboration state as plain dead transcript text.

Currently, this restoration is driven by historical successful `spawn_agent` tool results that include `thread_id` and `nickname`.

## Thread reads and live overlays

Thread read views can overlay current collaboration state onto the persisted transcript.

This allows clients to reflect live child-agent status even when the underlying persisted history was created in a previous run.

Current read behavior overlays live state onto:

- spawn items, filling in current child status and message
- wait items, updating each referenced child entry and clearing stale timeout presentation once all tracked children have completed

This is runtime-owned snapshot building, not frontend-only patch-up logic.

## Current limits and practical notes

- Nested subagents are off by default
- Collaboration semantics are runtime-owned and shared across clients
- Child status and timeout behavior are explicit parts of the collaboration result contract
- Child agents are retained in the registry after completion so later reads, waits, and resume overlays can still reference them
- `thread/list` excludes child sessions by default unless the caller explicitly asks to include them
- Child approvals and child user-input requests are routed upward through the parent runtime hooks rather than handled as a separate frontend-only mechanism

## Change checklist

1. Check whether the change affects runtime collaboration semantics, not just one client.
2. Update `@diligent/protocol` first if a frontend-visible event or payload shape changes.
3. Update runtime registry/session behavior next.
4. Update both Web and TUI rendering when collaboration UI-visible state changes.
5. Add or update tests in the owning layer, especially runtime and any affected client reducers.

## Key code paths

- `packages/runtime/src/collab/spawn-agent.ts`
- `packages/runtime/src/collab/wait.ts`
- `packages/runtime/src/collab/send-input.ts`
- `packages/runtime/src/collab/close-agent.ts`
- `packages/runtime/src/collab/registry.ts`
- `packages/runtime/src/collab/types.ts`
- `packages/runtime/src/agent/agent-types.ts`
- `packages/runtime/src/session/manager.ts`
- `packages/runtime/src/session/persistence.ts`
- `packages/runtime/src/session/types.ts`
- `packages/runtime/src/app-server/server.ts`
- `packages/runtime/src/app-server/thread-read-builder.ts`
- `packages/runtime/src/agent-event.ts`
- `packages/protocol/src/data-model.ts`
- `packages/protocol/src/server-notifications.ts`
