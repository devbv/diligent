# DiligentAppServer E2E

Deterministic end-to-end tests for `DiligentAppServer` through its JSON-RPC boundary.

## System Boundary

For this suite, the system under test is `DiligentAppServer`, not an entire Diligent product host.
A typical scenario crosses these layers:

```text
RpcClientSession
  -> JSON-RPC request handling
  -> DiligentAppServer
  -> session/runtime orchestration
  -> core agent loop
  -> tools, plugins, collaboration, and filesystem persistence
  -> JSON-RPC response or notification
```

The suite keeps external and client-specific boundaries deterministic:

- Provider output is supplied by fake `StreamFunction` implementations; no provider credentials or network calls are required.
- Most scenarios use an in-memory RPC peer. `websocket-transport.test.ts` additionally exercises the shared production WebSocket peer through a real Bun WebSocket.
- Runtime configuration is assembled explicitly for each scenario instead of loading user or machine configuration.
- Web React UI, TUI rendering, CLI child-process stdio, production host startup, Rust launcher behavior, packaging, and live-model behavior are outside this package's boundary.

A test belongs here when it enters `DiligentAppServer` through JSON-RPC and asserts an observable response,
notification, persisted state, or external effect after traversing the app-server stack. Package-local unit,
contract, and lower-layer integration tests belong under that package's `test/` directory.

## Test Files

| File | DiligentAppServer behavior |
|---|---|
| `custom-agents.test.ts` | Custom-agent spawning and per-spawn tool restrictions |
| `knowledge.test.ts` | Knowledge CRUD and filesystem persistence |
| `mode-and-config.test.ts` | Mode, effort, and tool-availability changes |
| `multi-connection.test.ts` | Subscription fanout, unsubscribe isolation, and disconnect cleanup over in-memory peers |
| `plugin-hooks.test.ts` | Plugin hook blocking, context injection, errors, and stop-hook re-entry |
| `protocol-lifecycle.test.ts` | Initialization, thread lifecycle, validation, and errors |
| `provider-native-blocks.test.ts` | Provider-native block propagation and persistence from the provider seam |
| `session-resume.test.ts` | Filesystem persistence, resume, recent-thread lookup, and list previews |
| `server-requests.test.ts` | Approval and user-input server request round trips |
| `steering.test.ts` | Active-turn steering injection and pending-steer management |
| `turn-execution.test.ts` | Turn notifications, interruption, tool execution, concurrency guards, persistence, and multi-turn context |
| `websocket-transport.test.ts` | Real WebSocket serialization, lifecycle, notifications, and bidirectional server requests |

## Run

```bash
bun run test:e2e
bun test packages/e2e/app-server/turn-execution.test.ts
```

Live-model behavior and model-owned decisions belong to `@diligent/evals`.
