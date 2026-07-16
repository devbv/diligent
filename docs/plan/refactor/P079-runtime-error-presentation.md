---
id: P079
status: implemented
created: 2026-07-16
---

# P079: Runtime-owned error presentation and recovery

## Goal

Remove client-specific recovery instructions from core errors and establish a
structured path from core diagnostics to runtime-owned user presentation and
client-specific recovery actions.

The completed boundary should be:

```text
core
  owns: error classification, stable reason, retryability, status, raw diagnostics
  knows nothing about: menus, slash commands, modals, top-left navigation

runtime
  owns: common user-facing message and semantic recovery intent
  knows: active provider/model and product terminology

protocol
  carries: diagnostics plus optional presentation and recovery action

Web and TUI
  render: the runtime message
  implement: the recovery intent using their own interaction model
```

This plan addresses the current core strings that instruct the user to use
`/provider` or a specific top-left UI menu. It also moves the existing Web-only
network-message normalization into the shared runtime path.

## Related plans

- P077 moves runtime policy out of the core agent loop.
- P078 removes runtime tool-name knowledge from core.
- P079 is independently implementable, but should be reviewed after those two
  plans so all three use the same ownership vocabulary.

## Current problem

Core currently produces UI-coupled messages, including:

```text
No authentication configured for <provider>. Use /provider <provider> to configure.
```

and:

```text
This conversation has exceeded the AI model's context limit. To continue,
open the menu in the top-left corner and start a new chat.
```

These strings assume a specific client:

- `/provider` is a TUI command and is not a Web interaction;
- a top-left menu is a Web layout detail and is not meaningful in headless or
  embedded clients;
- clients receive only a string, so they must parse classifications or repeat
  presentation rules to offer a useful action.

The repository already has most of the diagnostic transport:

- `ProviderErrorType` classifies rate limit, server, context, auth, network, and
  unknown failures;
- core serializes retryability, retry delay, status, and provider error type;
- protocol carries the same fields;
- Web already special-cases network errors and auth recovery;
- TUI displays the raw error text.

The missing pieces are a stable reason for cases within the same coarse type,
a runtime presentation mapper, and a protocol-level recovery intent.

## Proposed diagnostic contract

Keep `ProviderErrorType` as the coarse operational category and add an optional
stable reason for product mapping:

```typescript
export type ProviderErrorReason =
  | "credentials_missing"
  | "credentials_rejected"
  | "context_window_exceeded";

export interface SerializableError {
  message: string;
  name: string;
  stack?: string;
  code?: string; // upstream/provider code, retained for diagnostics
  providerErrorType?: ProviderErrorType;
  providerErrorReason?: ProviderErrorReason;
  isRetryable?: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}
```

Do not overload the existing `code` field. It currently carries upstream codes
such as `overloaded_error`; using it for Diligent recovery semantics would mix
two namespaces and break diagnostic consumers.

`ProviderError` gains the optional reason in a source-compatible way. The
implementation should prefer an options object for new construction while
retaining the positional constructor during this migration if changing all
callers at once creates unnecessary risk.

Core messages become UI-neutral diagnostics:

```text
No authentication is configured for <provider>.
The model context window was exceeded.
```

Core may retain provider-originated messages for logs and unknown-error
fallback, but it must not mention a product command, screen position, modal,
button, or client navigation path.

## Proposed presentation contract

Add a protocol-owned presentation type that extends, rather than replaces, the
serialized diagnostic:

```typescript
export const ErrorRecoverySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("configure_provider"),
    provider: ProviderNameSchema.optional(),
  }),
  z.object({ kind: z.literal("start_new_thread") }),
  z.object({ kind: z.literal("retry") }),
]);

export const ErrorPresentationSchema = z.object({
  message: z.string(),
  recovery: ErrorRecoverySchema.optional(),
});

export const ClientErrorSchema = SerializableErrorSchema.extend({
  presentation: ErrorPresentationSchema.optional(),
});
```

Core does not import or create `ErrorPresentation`. Runtime converts a core
`SerializableError` to `ClientError` at the core-to-runtime event boundary:

```typescript
const clientError = presentRuntimeError(coreError, {
  provider: activeModel.provider,
  operation: "agent_turn",
});
```

The original diagnostic fields remain available for logs, tests, telemetry,
and fallback. Clients render:

```typescript
const message = error.presentation?.message ?? error.message;
```

This fallback keeps older servers and unclassified errors compatible.

## Initial runtime mapping

| Diagnostic | Common runtime message | Recovery intent |
|------------|------------------------|-----------------|
| `auth / credentials_missing` | Connect the selected provider to continue. | `configure_provider` |
| `auth / credentials_rejected` | The provider rejected the saved credentials. Reconnect to continue. | `configure_provider` |
| `context_overflow / context_window_exceeded` | This conversation is too long for the selected model. Start a new chat to continue. | `start_new_thread` |
| `network` | A network problem occurred. Please try again. | `retry` when safe |
| `server_error` | The provider is temporarily unavailable. Please try again. | `retry` when safe |
| `rate_limit` | The provider rate limit was reached. Please try again later. | no immediate action by default |
| `unknown` | No presentation override; use diagnostic message. | none |

The mapper may include a provider display name when the active provider is
known. It must derive that name from runtime/provider metadata rather than
parsing the diagnostic message.

`retry` is a semantic suggestion, not automatic replay. Clients must not repeat
a potentially mutating turn without explicit user action. Runtime should omit
the action when the failed operation cannot be safely retried through the
existing turn API.

## Planning decisions

1. **Core errors are diagnostic:** core never names `/provider`, a modal, a
   button, a screen corner, or a client route.
2. **Runtime owns common wording:** Web, TUI, non-interactive CLI, and future
   clients receive the same base user message.
3. **Clients own interaction:** protocol carries a semantic action; each client
   decides whether that means a button, picker, slash-command hint, or plain
   text.
4. **Diagnostics are preserved:** presentation is additive and never replaces
   raw error metadata in logs or persisted session errors.
5. **Stable reason is separate from upstream code:** `providerErrorReason` is a
   Diligent-owned closed set; `code` remains provider-owned diagnostic data.
6. **Unknown errors remain visible:** runtime does not mask unclassified errors
   with a generic message unless there is a privacy/security reason.
7. **No string parsing:** recovery mapping uses typed fields and active runtime
   context, not regexes over `message`.
8. **No automatic recovery:** actions require user initiation.
9. **Both frontend clients ship together:** Web and TUI handle every initial
   recovery kind before the protocol field is considered supported.
10. **Protocol remains backward compatible:** `presentation` and the new reason
    field are optional; clients fall back to `message`.

## Scope

### What changes

| Area | Change |
|------|--------|
| Core provider errors | Add stable reason and remove UI-specific instructions |
| Core serialization | Preserve the reason alongside existing diagnostics |
| Runtime | Add common presentation/recovery mapper at outbound event boundaries |
| Protocol | Add optional presentation and typed recovery union |
| Session errors | Continue persisting raw diagnostics; do not persist client layout decisions |
| Web | Consume presentation and implement semantic actions |
| TUI | Consume presentation and render/execute equivalent recovery actions |
| Non-interactive CLI | Print common message plus a textual recovery hint when available |
| Tests/docs | Cover cross-client parity and core boundary rules |

### What does not change

- No localization framework.
- No telemetry backend or remote error reporting.
- No automatic credential reset, provider switch, new-thread creation, or turn
  replay.
- No parsing or redaction redesign for arbitrary upstream provider messages.
- No general RPC error taxonomy for every app-server request.
- No change to retry policy inside core provider streaming.
- No new Web-only or TUI-only error class.
- No removal of raw diagnostic fields from protocol or session JSONL.
- No P078 tool-advertisement changes.

## Ownership details

### Core

Core determines facts required for programmatic handling:

- coarse provider error type;
- stable reason where core can know it reliably;
- retryability and delay;
- status and upstream error code;
- raw diagnostic message and cause for logs.

Core must not determine how a user reaches provider settings or creates a new
thread.

### Runtime

Runtime combines the core error with product context:

- active provider and model;
- operation type (`agent_turn`, compaction, configuration, and so on);
- whether an explicit retry is safe;
- provider display metadata.

It returns an optional presentation. The mapper is pure and deterministic so
it can be unit tested without a server or client.

### Protocol

Protocol owns the serializable recovery vocabulary. Recovery values describe
intent, not UI implementation. New action kinds require both Web and TUI
consumer updates and protocol compatibility tests.

### Web

Web uses the presentation message in the existing active error banner.

- `configure_provider` opens Provider Settings, focused on the specified
  provider when present;
- `start_new_thread` offers the existing new-thread action;
- `retry` offers an explicit retry control wired to the existing turn path.

The current `providerErrorType === "auth"` UI branch and Web-only network
message normalizer become compatibility fallback only, then are removed after
the runtime field is guaranteed for current-server events.

### TUI and non-interactive CLI

TUI renders the runtime message in the error item.

- `configure_provider` offers or invokes the existing provider picker for an
  explicit user selection; the text fallback mentions `/provider set <name>`;
- `start_new_thread` offers the existing `/new` flow;
- `retry` offers resubmission only after explicit confirmation/input.

Non-interactive mode cannot open an interactive picker. It prints the common
message and a client-owned command hint derived from the recovery intent.

## Event and persistence flow

The target path is:

```text
ProviderError
  -> core SerializableError
  -> runtime logs and persists raw diagnostic
  -> runtime presentRuntimeError(error, active context)
  -> protocol ClientError with optional presentation
  -> Web/TUI render and offer action
```

Runtime must map both error delivery paths:

1. `AgentEvent` error notifications emitted during a turn;
2. top-level app-server `ERROR` notifications created by request/turn handlers.

Introduce one shared runtime helper for both paths. Do not let individual
handlers hand-author presentation strings.

Session `ErrorEntry` continues storing the core `SerializableError`. This keeps
JSONL independent of current UI wording and avoids a session version bump.
Hydration does not resurrect old transient error banners today; P079 preserves
that behavior.

## Implementation plan

### Task 0: Establish a green baseline

- Run core provider/error serialization tests.
- Run runtime session, app-server, notification, Web error-banner, and TUI
  reducer tests.
- Record pre-existing failures before behavioral edits.

### Task 1: Write contract tests first

Add tests proving:

1. core missing-auth and context-overflow messages contain no `/provider`,
   menu, modal, screen-position, or client-navigation instruction;
2. missing credentials and rejected credentials have distinct stable reasons;
3. upstream `code` survives independently from `providerErrorReason`;
4. runtime maps each initial diagnostic row to the expected presentation;
5. unknown errors fall back to the raw message;
6. Web and TUI consume the same presentation but implement client-specific
   controls/hints;
7. older errors without presentation still render correctly.

### Task 2: Add stable core reasons

- Add `ProviderErrorReason` to core LLM types.
- Extend `ProviderError` and `SerializableError` additively.
- Update `toSerializableError()` to preserve the reason.
- Mark provider-manager missing auth as `credentials_missing`.
- Mark provider 401/403 responses as `credentials_rejected` where reliable.
- Mark all normalized context-overflow errors as
  `context_window_exceeded`.
- Preserve current `ProviderErrorType`, retry, status, cause, and upstream-code
  behavior.

### Task 3: Remove UI language from core

- Replace the provider-manager `/provider` instruction with a diagnostic-only
  message.
- Replace `CONTEXT_OVERFLOW_ERROR_MESSAGE` with UI-neutral wording, or rename it
  to make its diagnostic role explicit.
- Search all core source and examples for commands, menus, buttons, modals,
  routes, and screen-location guidance.
- Add a boundary test or lint-like source assertion for the known regressions
  without trying to ban ordinary words globally.

### Task 4: Add protocol presentation types

- Add `ErrorRecoverySchema`, `ErrorPresentationSchema`, and `ClientErrorSchema`.
- Add optional `providerErrorReason` to the diagnostic schema.
- Use `ClientErrorSchema` for Agent error events and server `ERROR`
  notifications.
- Preserve `SerializableErrorSchema` for raw/internal diagnostic contexts where
  presentation is not required.
- Export inferred types through existing protocol barrels.
- Add old/new JSON compatibility tests.

### Task 5: Add the runtime mapper

- Create a focused runtime module such as
  `src/errors/presentation.ts`.
- Accept raw error plus explicit context; do not reach into global mutable
  config.
- Return the original fields plus optional presentation.
- Centralize provider display-name lookup.
- Apply the mapper before outbound Agent error events and server `ERROR`
  notifications.
- Persist and log the raw diagnostic rather than presentation-only text.
- Ensure child-agent errors use their active model/provider context.

### Task 6: Update Web

- Replace `getUserFacingErrorMessage()` with presentation-first fallback.
- Store the typed recovery intent in `ActiveErrorState`.
- Refactor `ErrorBanner` to branch on recovery kind rather than
  `providerErrorType`.
- Implement provider settings, new-thread, and explicit retry controls using
  existing app operations.
- Keep old-server fallback for auth and network classifications during the
  compatibility window.
- Add component and reducer tests for all recovery kinds.

### Task 7: Update TUI and non-interactive output

- Carry the presentation/recovery fields through the TUI event reducer.
- Render presentation messages rather than raw diagnostics when available.
- Add client-owned hints/actions for provider configuration, new session, and
  retry.
- Ensure actions require explicit input and do not run while a turn remains
  busy.
- Make non-interactive output deterministic and useful without ANSI-only UI.
- Add reducer, command integration, and runner tests.

### Task 8: Cover non-Agent server errors

- Route app-server handler errors through the same runtime presentation helper
  where context is available.
- Keep hook-blocked and validation failures unchanged unless they have a typed
  mapping.
- Avoid constructing a presentation for unknown errors merely to satisfy a
  type; optional means optional.
- Verify JSON-RPC error responses remain separate from user-visible runtime
  notifications unless explicitly mapped.

### Task 9: Verify and document

- Run core, runtime, protocol, Web, CLI, and e2e suites.
- Run typecheck and lint.
- Manually verify missing credentials, rejected credentials, forced network
  failure, and exhausted context in both Web and TUI.
- Update architecture and frontend protocol guidance with the diagnostic /
  presentation / interaction split.

## Expected file changes

| Package | Likely files |
|---------|--------------|
| core | `src/llm/types.ts`, `src/llm/provider-manager.ts`, provider normalizers, `src/agent/util/errors.ts` |
| core tests | provider error tests, serialization tests, agent error-event tests |
| runtime | new error presentation module, session turn orchestration, app-server emission paths, runtime event types |
| runtime tests | presentation mapper, session persistence, notification/app-server tests |
| protocol | data model, server notifications, barrels, compatibility tests |
| web | user-facing error helper, thread store, error banner, app action wiring |
| cli | thread event reducer, chat/error rendering, command/action wiring, non-interactive runner |
| docs | architecture/error extension guidance and this plan |

## Acceptance criteria

1. Core source contains no `/provider` recovery instruction.
2. Core context-overflow errors contain no menu or screen-location instruction.
3. Missing and rejected credentials are distinguishable without parsing text.
4. Upstream error codes remain intact and separate from Diligent reasons.
5. Runtime produces a common presentation for auth, context, network, server,
   and rate-limit classifications.
6. Unknown errors retain a readable raw fallback.
7. Protocol recovery actions are semantic and optional.
8. Web actions operate through existing provider/new-thread/retry paths.
9. TUI provides equivalent actions or command hints through existing paths.
10. Non-interactive CLI output remains actionable without UI assumptions from
    core.
11. Session JSONL stores raw diagnostics and requires no version bump.
12. Older server/client payloads without presentation remain readable.
13. No recovery action executes automatically.
14. Core, runtime, protocol, Web, CLI, and e2e tests, typecheck, and lint pass.

## Testing strategy

| Category | What to test |
|----------|--------------|
| Core unit | Reason assignment, UI-neutral messages, serialization |
| Provider normalization | 401/403, context overflow, upstream code retention |
| Runtime unit | Pure mapping table and context-sensitive actions |
| Runtime integration | Both Agent event and top-level ERROR notification paths |
| Persistence | Raw error round trip without presentation dependency |
| Protocol | Optional fields, discriminated action parsing, old payloads |
| Web | Presentation-first banner and three action kinds |
| TUI | Presentation-first item, command hints/actions, busy-state safety |
| Non-interactive | Stable stderr text and exit behavior |
| Manual/e2e | Auth, context, network, and retry recovery in both clients |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Presentation replaces diagnostics | Logs and debugging lose provider detail | Additive `presentation`; persist/log raw fields |
| Runtime misses one emission path | Some errors still show raw/UI-coupled text | Shared mapper and tests for both notification paths |
| Reason duplicates upstream code | Ambiguous namespace and unstable mapping | Separate `providerErrorReason` field |
| Clients auto-run recovery | Duplicate writes or unwanted navigation | Explicit user action only |
| Web and TUI drift | Shared protocol no longer means shared behavior | Parity matrix and paired acceptance tests |
| Provider context is lost | Configure action targets wrong provider | Pass active model/provider explicitly to mapper |
| Unknown errors are over-normalized | Actionable details disappear | No presentation override for unknown by default |
| Protocol type widens core dependency | Core starts importing protocol UI types | Construct presentation only in runtime |

## Rollout

Keep commits separable by responsibility:

1. core reasons and UI-neutral diagnostics;
2. protocol additive presentation schema;
3. runtime mapper and outbound event wiring;
4. Web presentation/actions;
5. TUI and non-interactive presentation/actions;
6. compatibility cleanup and documentation.

During the compatibility window:

- new clients use `presentation` when present and fall back to `message`;
- Web retains its current auth/network fallback for older servers;
- TUI retains raw-message fallback;
- runtime never assumes all connected clients understand recovery actions.

Remove client-side classification fallbacks only after the supported server and
client versions guarantee runtime presentation.

## Deferred follow-ups

1. Localization keys and parameterized messages if Diligent adopts multiple UI
   languages.
2. Redaction and privacy policy for arbitrary provider diagnostic messages.
3. Structured presentation for tool, validation, hook, MCP, and filesystem
   errors after their taxonomies stabilize.
4. Multiple recovery choices on one error; P079 permits at most one primary
   action.
5. Automatic retry countdowns for rate limits; P079 keeps recovery explicit.
6. Persisted/resumable error banners if product requirements change.
7. Telemetry correlation IDs and support bundles.

## Decisions referenced

| ID | Summary | Where used |
|----|---------|------------|
| D010 | Retry uses an explicit retryable error classification | Runtime maps typed diagnostics, not strings |
| D086 | Core/consumer boundary data remains serializable | Reasons and presentation are data-only |
