# Sentry Monitoring

How error monitoring is built, when events are sent, and exactly what data leaves the
machine. Built in [#360](https://github.com/overdare/diligent/pull/360) (SDK integration)
and [#361](https://github.com/overdare/diligent/pull/361) (structured-log sink).
The original rollout plan lives in `docs/plan/infra/sentry-integration.md`.

## Projects and processes

Sentry projects are split by **deployment unit / version cycle**, not by repo or package
(org `overdare`, region `us.sentry.io`):

| Sentry project | SDKs | Process | Init code |
|---|---|---|---|
| `diligent-agent` | `@sentry/bun` + `@sentry/react` (shared DSN) | Bun sidecar server + browser client | `sidecar/src/sentry.ts`, `sidecar/src/web/client/sentry.ts` |
| `diligent-launcher` | Rust `sentry` crate | Rust launcher binary | `apps/overdare-ai-agent/src/monitoring.rs` |

The sidecar server and the React client ship in one bundle under one version, so they
share one project; events are separable via the automatic `sdk.name` tag. The launcher
self-updates on its own cycle (an old launcher can run a new sidecar), so it is a
separate project.

`packages/core` / `packages/runtime` never get a project: they are libraries running
inside whichever process loaded them, and they must stay Sentry-unaware (they are also
consumed by the CLI/TUI and the VS Code extension, which do not ship Sentry).

## When is an event sent?

The rule that explains everything: **Sentry's automatic capture only sees errors whose
propagation never stops.** A `try/catch`, a React error boundary, or a `.catch()` makes
an error "handled" and invisible to the SDK. Diligent deliberately catches almost
everything (the agent must not crash because one turn failed), so there are three
capture channels:

### 1. SDK global handlers — crashes

Enabled by `Sentry.init()` in each process. Fire only when nothing caught the error:

- Sidecar: `uncaughtException`, `unhandledRejection` (process-level)
- Browser: `window.onerror`, `window.onunhandledrejection` (there are currently no React
  error boundaries, so render errors escape to `window.onerror` and are captured)
- Launcher: Rust panics — the panic hook chains a synchronous 2s flush because the
  release profile builds with `panic = "abort"` (no unwinding → the init guard's
  Drop-flush would never run)

### 2. Structured-log sink — handled-but-reportable failures (TS only)

The agent loop catches provider/tool/turn errors (`turn-orchestrator.ts`
`handleRunError`) and the web client catches RPC/UI failures — none of that can reach
channel 1. Every such site already calls `logger.error`, and `@diligent/logging` sinks
are **host-owned**, so the sidecar registers a Sentry sink at that single gateway:

```
any logger.error / allowlisted logger.warn
  → LogRecord { level, scope, event, error, sessionId, turnId, message, fields }
    → default sink (fanout)
        ├─ console sink
        ├─ gateway system-log sink   (server only)
        └─ Sentry sink               ← createSentryLogSink()
```

- Implementation (shared by both SDKs behind a structural facade):
  `sidecar/src/web/shared/sentry-config.ts`
- Server wiring: `sidecar/src/logging.ts` (`configureSidecarLogging`, called from
  `server.ts` and `mcp-server.ts`)
- Client wiring: `sidecar/src/web/client/sentry.ts` (only when Sentry is enabled)

Filtering (`shouldReportLogRecord`):

- `error` level → reported, **except** `parent.exited` (normal Studio-close shutdown)
  and `process.uncaught_exception` / `process.unhandled_rejection` (channel 1 already
  captures those natively; the sink would double-count).
- `warn` level → only the allowlist: `agent_loop_hook_disabled` (silent product
  degradation with no error-level path).
- everything else → never.

Notable emitters: `run_failed` (all turn failures converge here),
`persist_entry_failed`, `startup.failed`, `bootstrap.failed`, `oauth.login_failed`
(server); `thread.open_failed`, `message.send_failed`, `toast.error`, ... (client).
Tool-execution errors are intentionally NOT reported: they return to the model as tool
results (the agent is expected to see and recover from them); only failures that
escalate to a failed turn surface via `run_failed`.

### 3. Explicit captures — launcher (Rust)

The launcher has no log pipeline, so `monitoring.rs` captures explicitly:

- every fatal `CliError` before exit (all non-zero exit codes of the P077 contract),
  tagged `exit_code`
- `init fallback` as a warning — the only signal that field updates are silently
  failing (the fallback swallows the error and exits 0)

## What data is in an event?

### Included

| Data | Source | Example |
|---|---|---|
| `tags.log_scope`, `tags.log_event` | sink | `session.turn-orchestrator`, `run_failed` |
| `tags.session_id`, `tags.turn_id` | sink (when present) | opaque IDs, cross-reference with `.{ns}/sessions/` |
| `tags.provider_error_type`, `tags.provider_error_reason`, `tags.status_code`, `tags.retryable`, `tags.error_code`, `tags.provider_request_id` | sink (from `fields.serializedError`) | `invalid_request`, `400`, `req_011...` — provider failure triage without reading messages |
| `tags.provider`, `tags.model_id`, `tags.tool_count`, `tags.entry_count` | sink (from `fields.runContext`) | `anthropic`, `claude-...`, turn size at failure |
| `tags.overdare_project_id`, `tags.hub_domain` | init (launcher-injected env) | opaque project ID / hub domain for slicing issues per project |
| `fingerprint` | sink | `[scope, event, error.name]` (+ `providerErrorType`, `statusCode` when `fields.serializedError` carries them) — groups issues by log site and failure kind, not message variance |
| exception (name, message, stack) | sink / SDK | reconstructed from the normalized error |
| `release` | init | bare bundle version (`DILIGENT_SERVER_VERSION`); launcher: `overdare-ai-agent@<ci-version>` |
| `environment` | init | `prod` / `dev` — the runtime release channel (`--agent-env` → `DILIGENT_ENV`) |
| `tags.no_alert` | init (test runs only) | `"true"` when `SENTRY_TEST` was set |
| `tags.exit_code` | launcher | CLI exit-code contract value |
| SDK ambient context | SDK | OS/runtime versions; browser adds page URL, user agent, locale |

### Excluded (by design — privacy policy)

Telemetry is operational diagnostics outside the OVERDARE consent gate, so scrubbing is
mandatory, not best-effort:

- **Conversation content, prompts, tool outputs — never.** The sink does not read the
  free-text `LogRecord.message` or `fields`; only the structured parts are sent.
- **Breadcrumbs — all dropped** (`beforeBreadcrumb: () => null`): console crumbs may
  echo thread content.
- **Home directory paths** — `beforeSend` rewrites the home dir to `~` across the whole
  event (TS), `scrub_home` does the same for launcher messages (Rust).
- **User IP** — `sendDefaultPii: false` everywhere (`infer_ip: never`).

## Enablement gates (when is Sentry ON?)

Designed so that local development can never report accidentally:

| Process | ON when | OFF when |
|---|---|---|
| Sidecar | `SENTRY_DSN` env set (non-empty), OR launcher-managed run (`DILIGENT_SERVER_VERSION` present → inlined DSN) | plain `bun run` / `make dev-*` (no version env); `SENTRY_DSN=""` is an explicit off-switch |
| Browser | server injected `window.__DILIGENT_SENTRY__` into index.html | Vite dev mode (server never injects), or server had no DSN |
| Launcher | runtime `SENTRY_DSN` env, else compile-time `option_env!("SENTRY_DSN")` baked by `release.yml` | local cargo builds (nothing baked); `build-agent-exe.yml` test builds intentionally bake nothing |

DSNs are public write-only identifiers, not secrets — safe to inline in code and CI.

`environment` comes from the runtime channel, so events labeled `dev` are **deployed
dev-channel builds**, never local development (which is structurally off).

## Readable production stack traces

- **Server**: `bun build --compile --sourcemap` embeds the map in the sidecar binary —
  runtime stacks point at original TypeScript. No upload involved.
- **Web**: `@sentry/vite-plugin` uploads hidden source maps during the CI release build,
  gated on `SENTRY_AUTH_TOKEN` (repo secret, scope `project:releases`) +
  `SENTRY_RELEASE` (bare bundle version — must equal the runtime-injected release).
  Maps are deleted from the shipped bundle after upload. Without the secret the upload
  silently skips; releases are otherwise unaffected.
- **Launcher**: native Rust stacks, no maps needed.

## Alerts

Slack channel `#alert-studio-agent`, one multi-project issue-alert rule:

- **When**: new issue · resolved→unresolved regression · issue escalates (Sentry's
  baseline-aware spike detection)
- **If**: `no_alert != true`
- **Then**: Slack notification with tags `environment, release`

Grouping means repeated occurrences of a known issue stay quiet; only new issues,
regressions, and escalations ping.

## Testing

- `SENTRY_TEST=1` marks the whole run as a manual test in all three SDKs: events still
  record in Sentry, but carry `no_alert:true` so the Slack rule skips them.
- Browser E2E hook: when the run is a test run, the client exposes
  `window.__diligentSentrySinkTest()` to push one record through the installed sink
  chain (real triggers are UI-guarded and hard to force from automation). Not present
  outside test mode.
- Automated tests: `sidecar/test/sentry-config.test.ts` (index.html injection),
  `sidecar/test/sentry-log-sink.test.ts` (reporting decision),
  `sidecar/test/sentry-sink-pipeline.test.ts` (logger → fanout → sink → SDK facade),
  `monitoring.rs` scrub test.
- Manual smoke:
  ```bash
  SENTRY_TEST=1 SENTRY_DSN="<dsn>" DILIGENT_SERVER_VERSION=0.0.0-test \
    bun run apps/overdare-ai-agent/sidecar/src/server.ts --cwd /tmp/somewhere
  ```
  Caution: with user-global provider auth present, real turns can run — use harmless
  prompts.

## Adding a new reportable failure

In sidecar or client code, log it — no Sentry import needed:

```ts
} catch (error) {
  logger.error("mytool.fetch_failed", { message: "...", error });
}
```

The record reaches console, gateway logs, and Sentry (tagged, fingerprinted, scrubbed)
through the existing pipeline. Never put error content in the event name; never rely on
`message`/`fields` reaching Sentry (they intentionally do not). In `packages/runtime`
or `packages/core`, do exactly the same — those layers must not import Sentry; the
host-owned sink picks their records up automatically.
