# @diligent/e2e

End-to-end tests that run the full agent stack via the JSON-RPC protocol.

## Test Files

| File | What it tests |
|---|---|
| `turn-execution.test.ts` | Tool execution, approval, interruption |
| `session-resume.test.ts` | Session persistence, resume, compaction |
| `protocol-lifecycle.test.ts` | Initialize, thread lifecycle, disconnect |
| `mode-and-config.test.ts` | Plan/execute mode switching, config changes |
| `multi-connection.test.ts` | Multiple concurrent WebSocket clients |

## Run

```bash
bun test                        # All tests
bun test turn-execution.test.ts # Single file
```

Tests use helpers in `helpers/` to start a real app server and communicate over the protocol.
They are deterministic and do not require provider API credentials. Live-model behavior belongs to
`@diligent/evals`.
