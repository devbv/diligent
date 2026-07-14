# Structured Logging

Diligent uses `@diligent/logging` for first-party production diagnostics. The package is a dependency-free leaf so core, runtime, and host applications can share one record contract without reversing package dependencies.

## Record ownership

The emitter creates one `LogRecord` with:

- a UTC `timestamp` generated once at emission time,
- a stable `scope` and machine-oriented `event`,
- a human-readable `message`,
- optional `sessionId`, `threadId`, `turnId`, and component context,
- structured fields and normalized error information.

Use child loggers to attach immutable context at composition boundaries:

```ts
const threadLogger = logger.child({ sessionId, threadId });

threadLogger.warn("retry_scheduled", {
  message: "[llm:retry] retrying provider request",
  fields: { attempt, delayMs },
});
```

Do not recover correlation data by parsing `message`. Do not use a process-global current session because hosts may run concurrent sessions.

## Sink ownership

The common package owns the record contract, console formatting, level filtering, and fanout. Hosts own product-specific sinks:

- local processes use the console sink,
- stdio transports route diagnostics to stderr so stdout remains machine-readable,
- OVERDARE maps the original record timestamp to `event_ts` and `sessionId` to `session_id`,
- browser diagnostics stay local unless a separate telemetry decision explicitly enables transport.

Sink failures must never change agent control flow. Remote and file sinks should be non-blocking and bounded.

## Output boundaries

Not every `console.*` call is a diagnostic log. Keep these outside the structured logger:

- CLI command results, version output, and prompts,
- TUI rendering and status text,
- JSON-RPC or MCP protocol frames,
- build-script progress output,
- third-party and plugin console output.

Compatibility console interception may remain at host boundaries to capture unconverted or third-party output. Structured console writes are marked so a host can avoid forwarding the same record twice.

## Sensitive data

Never log API keys, OAuth tokens, full prompts, raw provider requests, arbitrary tool output, or user file contents by default. Error normalization makes values serializable; domain and product sinks remain responsible for masking sensitive fields before remote transmission.
