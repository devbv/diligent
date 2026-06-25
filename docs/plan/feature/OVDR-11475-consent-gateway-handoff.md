# OVDR-11475 — AI-data Consent + diligent-gateway Transmission (Handoff)

Status: in progress on branch `feat/ovdr-11475-consent-gateway` (pushed). Implements
[OVDR-11475](https://overdare.atlassian.net/browse/OVDR-11475) §3.A (consent) and §B (collection, MVP).

## What's implemented

### §3.A Consent
- **First-run notice popup** (`packages/web/src/client/components/FirstRunNoticeModal.tsx`) — one-time, shown when `consent.noticeAcknowledged` is false. `[Get started]` acknowledges (sets `noticeAcknowledgedVersion`); it is **not** model-training consent.
- **Settings → "AI Data"** toggle in `ToolSettingsModal.tsx`: `serviceImprovement` (default **ON / opt-out**) + a "View Privacy Policy ›" link. The model-training toggle was dropped per scope.
- **Backend-owned state**: stored in `config.jsonc` under `consent`, surfaced via the `initialize` response, mutated through a new `consent/set` RPC. Resolver/patch in `packages/runtime/src/config/consent.ts`; protocol types in `packages/protocol/src/client-requests.ts` (`ConsentState`, `ConsentSetParams`).
- **Privacy-policy URL** is resolved dynamically: read `https://static.overdare.com/legal/privacy/en/latest.json` → `latestVersion` → `https://www.overdare.com/legal/privacy?version=<v>`. The static manifest URL is a constant (`PRIVACY_POLICY_LATEST_URL`); fetch is 3s-bounded + cached, awaited in `getInitializeResult`, falls back to the base URL on failure. Overridable via `config.consent.privacyPolicyUrl`.

### §B Collection (MVP)
- A per-append **`EntryAppended` plugin hook** (`mode:"async"`). Generic per-append signal lives in `SessionPersistence` (`packages/runtime/src/session/persistence.ts`), dispatched **off the write tick via `setImmediate`** so it never blocks the turn; the app-server (`server.ts` `runEntryAppendedHooks`) builds a `HookInput` and runs it through the hook runner.
- The transmitter is an OVERDARE sidecar `BundledToolProvider` at `apps/overdare-ai-agent/sidecar/src/tools/gateway/`:
  - `masking.ts` — simple regex 1st-pass secret masking (`secrets-2` match rules), walks string values.
  - `index.ts` — builds the gateway envelope and POSTs `/v1/records`.
- **Auth**: bearer is the **Creator Hub token** via Studio RPC `hub.token.read` (shared with bubo/analytics, cached). `DILIGENT_GATEWAY_TOKEN` is a local-dev override.
- **Gated on `serviceImprovement` consent** (runtime-level, live).
- Config/env: endpoint `DILIGENT_GATEWAY_URL` (default `http://127.0.0.1:8000`), `OVERDARE_PROJECT_ID`, `DILIGENT_GATEWAY_DEBUG=1` logs each POST.
- Gateway backend + client contract live in a separate repo `~/git/diligent-gateway` (`contract/` is the source of truth: `envelope.schema.json`, `masking-rules.json`, `CLIENT_INTEGRATION.md`).

Verified working end-to-end: popup + toggle + privacy link render; records transmit when consented.

## Branch / commits
`feat/ovdr-11475-consent-gateway` (on origin), 3 commits:
1. `feat(consent): AI-data consent + gateway session transmission`
2. `feat(gateway): authenticate with Creator Hub token like bubo`
3. `feat(consent): resolve privacy-policy URL from the latest-version manifest`

## Build / run / test (IMPORTANT — cross-machine setup)
The Rust agent `start` runs the **downloaded** runtime at `~/.overdare/updates/runtime/`, not your source. To test local changes you must update BOTH the backend binary and the served frontend:

```bash
# backend (runtime + sidecar bundled into the web-server binary)
bun run overdare-ai-agent:build-sidecar
cp apps/overdare-ai-agent/.diligent/diagnostics/diligent-web-server ~/.overdare/updates/runtime/diligent-web-server

# frontend (served from <binary-dir>/dist/client)
bun run --cwd packages/web build
rm -rf ~/.overdare/updates/runtime/dist/client && cp -R packages/web/dist/client ~/.overdare/updates/runtime/dist/client

# run (project id injected at runtime; token via Hub by default)
DILIGENT_GATEWAY_URL=https://diligent-gateway.ovdr.io OVERDARE_PROJECT_ID=<id> \
  cargo run --manifest-path apps/overdare-ai-agent/Cargo.toml -- start --cwd="$PWD" --web-server-port=3000
```
Then restart the agent + hard-refresh the browser (Cmd+Shift+R). Tests: `bun test packages/runtime/test/config packages/runtime/test/session apps/overdare-ai-agent/sidecar/test`; `bun run typecheck`; `bun run lint`.

> **Gotcha that cost time:** forgetting to rebuild/copy the **frontend** leaves a stale served bundle with no consent code → the popup silently never renders. Always update both.

## Open / next
- **PR not created** — `gh` CLI was unauthenticated. `gh auth login` then `gh pr create --base main`.
- Gateway MVP still lacks: durable disk outbox, `/v1/records:batch`, retry/backoff + 401/413/422/429 handling, `project_label` (git remote).
- If the popup doesn't reappear after re-test: a prior `[Get started]` saved `consent.noticeAcknowledgedVersion` in `~/.overdare/config.jsonc` — clear the `consent` block to retrigger.

## Notes / gotchas
- Unrelated working-tree changes exist and are intentionally **not** committed: `.diligent/**` skill/agent/knowledge deletions, `.overdare/`, `apps/overdare-ai-agent/.diligent/` build artifacts.
- Turn-start ~10s slowness observed during testing was the **studio-save `UserPromptSubmit` hook** (sync-awaited in `handleTurnStart`), not the gateway hook (which is async + off the write tick).
- `bun test` shares the module registry across files; the analytics module caches config at module scope. Gateway tests avoid touching `loadOverdareConfig` (env-override short-circuit); `consent.test` resets the privacy-URL cache in `afterEach`.
- Never `await` an un-timeout'd fetch in `getInitializeResult` — it blocks `initialize` and drops the consent payload (the privacy fetch is 3s-bounded for this reason).
