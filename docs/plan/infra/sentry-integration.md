# Sentry Integration Plan

Status: Phases 1–4 done. Verified end-to-end: sidecar `@sentry/bun` (DILIGENT-AGENT-1),
web `@sentry/react` (DILIGENT-AGENT-2), launcher Rust `sentry` crate (DILIGENT-LAUNCHER-1),
baked launcher DSN + release (DILIGENT-LAUNCHER-2, release `overdare-ai-agent@0.0.2-p4test`).
ONE MANUAL STEP LEFT: add the `SENTRY_AUTH_TOKEN` repo secret (scope: `project:releases`)
in GitHub Actions, or web source-map upload silently skips in release builds.

Launcher project: `diligent-launcher` (team `studio-agent`, ID 4511811624304640)
Launcher DSN: `https://3c882faa9bcc24fd661ec9ada0da88ab@o4507586380890112.ingest.us.sentry.io/4511811624304640`
Branch: `feat/sentry-integration`

Sentry: org `overdare`, project `diligent-agent` (team `studio-agent`, ID 4511811350560768)
DSN: `https://df4934a1d409febff5da85d23ed88b74@o4507586380890112.ingest.us.sentry.io/4511811350560768`
(DSNs are public identifiers, not secrets — safe to commit; delivered via `SENTRY_DSN` env for
now, inline as a build-time constant when wiring production delivery in Phase 4.)

## Goal

Error monitoring for the Overdare product deployment. Capture crashes and unhandled errors from
each runtime that executes on end-user machines, tied to the release version that shipped them.

Out of scope for the first pass: performance tracing, profiling, metrics, cron monitoring.
Errors first; add signals only when a concrete need appears.

## Process model → Sentry project mapping

Sentry projects are split per *deployment unit / version cycle*, not per repo, package, or SDK.
Library packages (`packages/core`, `runtime`, `protocol`, `logging`, ...) never get their own
project — their errors surface in whichever process loaded them. The sidecar server and the
React client ship together in one sidecar bundle under one version, so they share one project
(one DSN, two SDKs); events are separable via the automatic `sdk.name` tag
(`sentry.javascript.bun` vs `sentry.javascript.react`). The launcher self-updates on its own
version cycle (an old launcher can run a new sidecar), so it stays a separate project.

| Sentry project | SDKs | Processes | Covers |
|---|---|---|---|
| `diligent-agent` | `@sentry/bun` + `@sentry/react` (shared DSN) | Bun sidecar server (`apps/overdare-ai-agent/sidecar/src/server.ts`) + browser client (`sidecar/src/web`) | Agent loop, providers, tools, sessions, gateway (all of `packages/core` + `packages/runtime` in-process); React UI and WebSocket client failures |
| `diligent-launcher` | Rust `sentry` crate | Rust CLI binary (`apps/overdare-ai-agent/src`) | Panics, self-update failures, runtime bootstrap/spawn failures |

Not instrumented initially (add when usage justifies):

- `packages/cli` (TUI) — dev/internal client, same Bun SDK as sidecar if ever needed
- `apps/vscode-extension` — Node platform, later

## Phases

### Phase 1 — Sidecar server (highest value)

1. Create Sentry project `diligent-agent` (platform Bun — the platform picker only seeds setup
   docs; the project accepts both SDKs).
2. `bun add @sentry/bun` in `apps/overdare-ai-agent/sidecar`.
3. `Sentry.init()` at the top of `src/server.ts` (before runtime assembly):
   - `dsn` from env / build-time constant; **no-op when DSN is absent** so dev runs stay clean
   - `release` = sidecar version already used by the launcher manifest flow
   - `environment` from `DILIGENT_ENV` (prod / dev)
   - `sendDefaultPii: false`
4. `beforeSend` scrub: strip absolute user paths, prompt/message bodies, provider tokens.
   Error *diagnostics* go to Sentry; conversation *content* must not.
5. Verify: throw a test error, confirm the issue in Sentry with a readable local stack trace.

### Phase 2 — Web client (same project)

1. `@sentry/react` init in the client entry, reusing the `diligent-agent` DSN; delivered via the
   existing static-serve path (config endpoint or injected constant), same release/environment
   scheme as the server.
2. Server vs browser events are distinguished by the automatic `sdk.name` tag — use it for
   filtering and alert rules; no manual component tagging needed.
3. Optional later: Session Replay (privacy-masked), once error-only proves useful.

### Phase 3 — Launcher (Rust)

1. Create project `diligent-launcher`, platform Rust.
2. `sentry` crate with `panic` integration in `apps/overdare-ai-agent`:
   - init guard held for the whole `main`; guard drop flushes pending events on exit
     (launcher is short-lived — explicit flush matters)
   - capture explicit failures: manifest fetch, download/extract, child-spawn errors
   - `release` = launcher version, `environment` from `--agent-env`
3. Sentry is sufficient here: the launcher is a thin bootstrap; we need crash/error reporting,
   not APM. No additional monitoring stack.

### Phase 4 — Production readability (done)

1. Production DSN delivery:
   - sidecar (`src/sentry.ts`): `diligent-agent` DSN inlined; applies only to
     launcher-managed runs (`DILIGENT_SERVER_VERSION` present). `SENTRY_DSN` env always
     wins when set; empty string is an explicit off-switch. Local `bun run` stays no-op.
   - web: inherits the server's resolved DSN via the index.html injection — no change.
   - launcher (`src/monitoring.rs` + `release.yml`): DSN and `LAUNCHER_VERSION` baked via
     `option_env!` on the CI cargo-build step. Local cargo builds have neither → disabled.
     Fixes the fixed-`0.0.1` release bug (Cargo.toml's version is not the launcher version);
     releases now report as `overdare-ai-agent@<ci-version>`.
2. Server stack traces: `bun build --compile --sourcemap` embeds the map in the sidecar
   binary, so runtime stacks (and Sentry events) point at original TypeScript sources.
   No upload needed for the server.
3. Web source maps: `@sentry/vite-plugin` in `vite.config.ts`, gated on
   `SENTRY_AUTH_TOKEN` + `SENTRY_RELEASE` (set by `release.yml` on the runtime-bundle
   build). Emits hidden maps, uploads, deletes maps from the shipped bundle.
   `SENTRY_RELEASE` = bare bundle version, matching the runtime-injected release.
4. `build-agent-exe.yml` (test builds) intentionally bakes nothing — test binaries
   must not report to production Sentry.

### Handled-error reporting (sidecar log sink)

The agent loop catches provider/tool/turn errors before they can crash the process, so
the SDK's global handlers never see them. Instead of sprinkling `captureException` through
`packages/runtime` (which must stay Sentry-unaware), the sidecar registers a Sentry
**log sink** (`createSentryLogSink` in `src/sentry.ts`, wired in `src/logging.ts`):
every server-side `logger.error` — `run_failed` (turn errors via `handleRunError`),
`persist_entry_failed`, `startup.failed`, `bootstrap.failed`, ... — becomes a Sentry event.

- Excluded: `parent.exited` (normal Studio-close shutdown), `process.uncaught_exception` /
  `process.unhandled_rejection` (SDK captures natively; sink would double-count).
- Warn allowlist: `agent_loop_hook_disabled` (silent product degradation).
- Only structured diagnostics are sent (scope, event, normalized error, session/turn IDs);
  the free-text log message and `fields` stay local — they may carry content.
- Issues group by fingerprint `scope + event + error.name`, not message variance.

## Constraints

- **Consent / privacy — decided**: Sentry telemetry is treated as **operational diagnostics
  outside the OVERDARE consent gate** (`ConsentService` is not consulted; error reports are
  always sent). In exchange, scrubbing is mandatory, not best-effort:
  - `sendDefaultPii: false` on every SDK
  - `beforeSend` strips prompt/message content, absolute user paths, and provider tokens
  - events carry error diagnostics only — never conversation content
  - the privacy policy must disclose crash/error reporting (product/legal follow-up)
- **Offline users**: SDKs drop events silently without network; acceptable, no queuing needed.
- **Compiled sidecar**: `@sentry/bun` is pure JS and safe under `bun build --compile`
  (unlike WASM-backed deps — see prior codec findings). Verify once in the packaged binary
  during Phase 1.

## Open questions

- One Sentry org/team naming convention? (`overdare` org assumed)
