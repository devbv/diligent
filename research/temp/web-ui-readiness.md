# Web UI Readiness Assessment

Evaluation of when to introduce a web UI and how the current architecture aligns with codex-rs's app-server pattern.

**Date**: 2026-02-25
**Status**: Reference document — no action items yet

---

## 1. Timing Verdict

**Start after Phase 3 (minimum), ideally after Phase 4.**

The current codebase (Phase 2 complete) lacks critical infrastructure that a web UI depends on. Building it now would mean maintaining two frontends through heavy API churn in Phase 3–4.

### Missing Prerequisites

| Prerequisite | Phase | Why Web UI Needs It |
|---|---|---|
| Session persistence | 3 | Browser refresh loses entire conversation without it |
| Config system (JSONC + hierarchy) | 3 | No way to configure API keys, model, etc. from UI |
| Context compaction | 3 | Long conversations hit context overflow — more frequent in web |
| Approval system (bidirectional) | 4 | File writes/deletes execute without user confirmation — security risk |
| Slash commands | 4 | Web UI would need to re-implement all of them |

### Recommended Timeline

```
Phase 3 (Config & Session)  ← API surface stabilizes
    ↓
Phase 4 (Approval & UX)     ← safe for remote use
    ↓
Web UI start                 ← optimal entry point
```

---

## 2. codex-rs App-Server Architecture (Reference)

codex-rs's `app-server` crate is a **JSON-RPC 2.0 server** that wraps the core agent loop and exposes it over **stdio** or **WebSocket** transports. It serves VS Code extensions and other rich frontends.

### Architecture

```
Frontend (VS Code, etc.)
    |  JSON-RPC 2.0 (stdio:// or ws://IP:PORT)
    v
app-server-protocol   ← wire types, V1/V2 definitions, TS type generation
app-server            ← transport, routing, session management, event translation
    |
    v
codex-core            ← agent loop, tools, sandboxing, MCP
```

### Key Design Choices

- **JSON-RPC 2.0**: Bidirectional — server can send requests TO client (approval prompts)
- **Transport-agnostic**: `TransportEvent` enum unifies stdio and WebSocket; core logic is identical
- **Decoupled event loops**: Processor task + outbound router task communicate via channels, no shared mutable state
- **50+ event types**: `item/started` → `item/delta` (N) → `item/completed` → `turn/completed`
- **Thread lifecycle**: `thread/start`, `thread/resume`, `thread/fork`, `thread/rollback`
- **RAII guards**: `ThreadWatchActiveGuard` ensures pending request counters are always decremented
- **Dual API versioning**: V1/V2 coexistence with experimental feature gating

### API Surface Summary

| Category | Methods |
|---|---|
| Thread lifecycle | `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/rollback` |
| Turns | `turn/start` (triggers agent loop, streams events back) |
| Config | `config/read`, `config/write`, `config/batchWrite`, `config/requirements/read` |
| Auth | API key login, ChatGPT OAuth flow, token refresh |
| Notifications | `item/started`, `item/delta`, `item/completed`, `turn/completed`, `thread/status` |
| Approvals | `item/command/approval`, `item/fileChange/approval`, `item/userInput/request` |

### Data Flow

```
Client → JSON-RPC request → Transport → MessageProcessor
    → CodexMessageProcessor → core agent loop
    → codex_protocol events (50+)
    → bespoke_event_handling (translate to V1/V2 notifications)
    → OutgoingMessageSender → Transport → Client
```

---

## 3. Alignment Gap Analysis

### Already Aligned

| Aspect | codex-rs | diligent | Notes |
|---|---|---|---|
| Core/UI separation | `core` ↔ `app-server` crates | `@diligent/core` ↔ `@diligent/cli` | Fundamental principle shared |
| Event-driven communication | `Event` enum → frontend | `AgentEvent` union → TUI | Stream pattern identical |
| Tool interface | `ToolHandler` trait + `ToolInvocation` | `Tool` interface + `ToolContext` | Equivalent abstraction |
| Type serializability | `#[ts(export)]` for TS codegen | Zod → JSON Schema | Both can generate frontend types |
| D046 strategy | TUI uses direct calls; app-server is separate | Same strategy adopted | Intentional deferral |

### Gaps (Ordered by Priority)

| # | Gap | codex-rs | diligent now | When to Close |
|---|---|---|---|---|
| 1 | **Protocol layer** | JSON-RPC 2.0 (bidirectional, request/response correlation) | None | Web UI start |
| 2 | **Event granularity** | 50+ types with `ThreadItem` abstraction (message, command, file edit, reasoning — all unified as "items") | 15 `AgentEvent` types | Phase 3–4 (gradual expansion) |
| 3 | **Bidirectional approval** | Server→client JSON-RPC requests; agent loop blocks waiting for response | `ctx.ask()` auto-approve stub | Phase 4 |
| 4 | **Thread/session model** | `ThreadManager` (create/resume/fork/rollback, persistence) | In-memory array only | Phase 3 |
| 5 | **Transport abstraction** | `TransportEvent` enum (stdio/ws unified) | None | Web UI start |
| 6 | **Connection management** | Multi-connection, subscriptions, broadcast, backpressure (`-32001` on full queue) | N/A (single process) | Web UI start |
| 7 | **Init handshake** | `initialize` → `initialized` sequence with capability negotiation | None | Web UI start |
| 8 | **API versioning** | V1/V2 dual support, experimental feature gating | None | Post-MVP |

### Structural Differences (Intentional)

These are not gaps to close — they are deliberate divergences:

- **Language**: Rust (tokio, mpsc channels, RwLock) vs. TypeScript (Bun, async iterators, EventStream)
- **Event count**: ~15 events (pi-agent model) vs. 50+ (codex-rs model) — D004 decision
- **Session storage**: JSONL files (D006) vs. in-memory — different persistence strategy
- **Concurrency model**: Sequential tool execution (D015) vs. RwLock parallel — deferred

---

## 4. Phase 3 Design Recommendations

When designing Phase 3, align these concepts with codex-rs to reduce future gap:

1. **Introduce Thread abstraction**: Map to codex-rs's `thread/start`, `thread/resume`, `thread/fork`. Even if only used by TUI initially, having the abstraction makes the server layer trivial later.

2. **Expand AgentEvent toward item model**: Consider adding `item_started`/`item_completed` wrapper events that group related events. This doesn't require 50+ types — just the structural pattern.

3. **Design `ctx.ask()` for async response**: Phase 4 approval needs the server→client request pattern. Design the interface in Phase 3 (even if not implemented) so session persistence can record approval decisions.

4. **Keep serialization in mind**: Every new type should be JSON-serializable. Avoid closures or non-serializable state in event payloads.

---

## 5. Web UI Package Blueprint (Future Reference)

When the time comes, create `packages/server` following this structure:

```
packages/server/
  src/
    transport.ts        ← stdio/WebSocket abstraction (TransportEvent enum)
    protocol.ts         ← JSON-RPC 2.0 message types
    router.ts           ← Method dispatch (thread/*, turn/*, config/*)
    event-bridge.ts     ← AgentEvent → client notifications
    thread-manager.ts   ← Multi-thread lifecycle, subscription management
    approval-bridge.ts  ← Bidirectional approval request/response
    index.ts            ← Server entry point
```

Dependencies: `@diligent/core` (workspace), WebSocket library (e.g. `ws` or Bun native)

This mirrors codex-rs's app-server crate organization adapted for TypeScript/Bun.
