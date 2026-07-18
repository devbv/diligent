# P083: Move OVERDARE consent ownership out of runtime (handoff)

## Purpose

This handoff is for implementing consent decoupling in a separate worktree.

The desired boundary is stronger than an optional runtime consent capability:

- `packages/runtime` must not define, store, resolve, gate, or dispatch consent.
- `packages/protocol` must not include consent-specific methods or schemas.
- The Web host may own consent because the Web product is expected to move under OVERDARE ownership.
- The OVERDARE sidecar owns gateway state and the decision to transmit session records.
- Runtime continues to emit only the generic `EntryAppended` lifecycle hook.

## Decision summary

Consent is an OVERDARE product concern, not part of the Diligent agent runtime protocol.

The Web server intercepts the Web-owned `consent/set` request before it reaches `DiligentAppServer`. The Web client uses a Web-local consent contract. Runtime's existing opaque `getInitializeResult(): Record<string, unknown>` hook may carry initial consent state, but runtime must not import its type, inspect it, or branch on it.

The gateway transmitter gates itself using a shared sidecar `ConsentService`. Runtime invokes all registered `EntryAppended` hooks without applying a global consent rule.

```text
OVERDARE Web client
  |-- initialize --------------------------> DiligentAppServer
  |     (Web adds opaque consent metadata)       (consent-unaware)
  |
  `-- consent/set -------------------------> Web request router
                                                |
                                                `--> sidecar ConsentService

SessionPersistence
  `-- generic EntryAppended hook ----------> OVERDARE gateway provider
                                                |
                                                |-- ConsentService.isGranted()
                                                `-- POST /v1/records only if granted
```

## Non-goals

- Do not add a renamed optional consent interface to runtime.
- Do not add `supportsConsent` or equivalent to core protocol capabilities.
- Do not make all plugin hooks subject to an OVERDARE consent decision.
- Do not add consent UI to the TUI. The feature belongs to the packaged OVERDARE Web host, not generic Diligent clients.
- Do not redesign the gateway API, masking rules, batching, retry, or durable outbox.
- Do not change existing user-visible grant/withdraw semantics unless product requirements are updated separately.

## Current implementation

### Runtime and shared protocol leakage

Consent currently appears in generic layers:

- `packages/protocol/src/methods.ts`: `CONSENT_NOTICE_VERSION`, `DILIGENT_CLIENT_REQUEST_METHODS.CONSENT_SET`.
- `packages/protocol/src/client-requests.ts`: `ConsentStateSchema`, `ConsentSetParamsSchema`, optional `InitializeResponse.consent`, and consent request/response union members.
- `packages/runtime/src/config/consent.ts`: OVERDARE privacy-policy URLs, local defaults, and patching.
- `packages/runtime/src/config/schema.ts`: `DiligentConfig.consent`.
- `packages/runtime/src/config/writer.ts`: `saveGlobalConsent`.
- `packages/runtime/src/app-server/config-handlers.ts`: `ConsentConfigManager`, `handleConsentSet`.
- `packages/runtime/src/app-server/factory.ts`: optional gateway backend plus local `config.jsonc` fallback, privacy-policy refresh, and initialize payload.
- `packages/runtime/src/app-server/request-dispatcher.ts`: consent dispatch context and `consent/set` case.
- `packages/runtime/src/app-server/server.ts`: `DiligentAppServerConfig.consentConfig` and the global consent gate around every bundled `EntryAppended` hook.
- Runtime barrel exports and runtime consent/writer tests.

The critical architectural problem is the global gate in `DiligentAppServer.runEntryAppendedHooks()`. It makes an OVERDARE policy control all current and future bundled `EntryAppended` providers.

### Web ownership already exists partially

The Web client already owns the user experience in `FirstRunNoticeModal.tsx`, the AI data section of `ToolSettingsModal.tsx`, `use-consent-state.ts`, and consent bootstrap/rendering in `use-app-lifecycle.ts`, `use-app-state.ts`, and `App.tsx`.

The Web server currently receives `consentBackend` but passes it into runtime. P083 keeps the backend at the Web boundary instead.

### OVERDARE sidecar ownership already exists partially

- `apps/overdare-ai-agent/sidecar/src/tools/gateway/consent.ts` implements gateway GET/POST behavior and an in-memory status cache.
- `apps/overdare-ai-agent/sidecar/src/tools/gateway/index.ts` transmits records but currently relies on runtime to gate hook execution.
- `apps/overdare-ai-agent/sidecar/src/server.ts` creates and injects the gateway consent backend.

## Target contracts

### Web-local consent contract

Move schemas and types required by both Web client and Web server to `packages/web/src/shared/consent-protocol.ts`:

```ts
import { z } from "zod";

export const WEB_CONSENT_SET_METHOD = "consent/set";

export const ConsentStateSchema = z.object({
  noticeAcknowledged: z.boolean(),
  serviceImprovement: z.boolean(),
  privacyPolicyUrl: z.string(),
});
export type ConsentState = z.infer<typeof ConsentStateSchema>;

export const ConsentSetParamsSchema = z.object({
  noticeAcknowledged: z.boolean().optional(),
  serviceImprovement: z.boolean().optional(),
});
export type ConsentSetParams = z.infer<typeof ConsentSetParamsSchema>;
```

The method name may remain `consent/set` for wire compatibility. It is no longer a Diligent protocol method merely because the Web host recognizes it.

Define the server dependency in the Web server layer:

```ts
export interface WebConsentBackend {
  get(): ConsentState;
  refresh?(): Promise<void>;
  set(params: ConsentSetParams): ConsentState | Promise<ConsentState>;
}
```

The browser's `WebRpcClient.requestRaw()` supports method strings outside the shared Diligent protocol. `useConsentState` calls `requestRaw`, validates with `ConsentStateSchema`, and stores the parsed state.

### Web request routing

`DiligentAppServer.handleRequest()` validates against the closed `DiligentClientRequestSchema`, so Web must consume `consent/set` before delivery to the app server.

At the WebSocket peer boundary in `packages/web/src/server/index.ts`:

1. Parse the JSON-RPC envelope as today.
2. If the method is `consent/set`, validate params with the Web-local schema.
3. Call the Web-owned backend and send a JSON-RPC result/error response.
4. Forward every non-Web method to the existing app-server peer unchanged.

Prefer a small Web-level request router or filtered peer wrapper over adding a custom runtime request hook.

Routing invariants:

- Only explicitly registered Web methods are intercepted.
- Core method names cannot be shadowed accidentally.
- Invalid consent params return `-32602`.
- A missing consent backend returns `-32601`.
- Backend errors use the same JSON-RPC error shape as other requests.
- Notifications and server responses continue to reach the existing app server.

The router may initially be consent-specific. A generic `webRequestHandlers` map is acceptable if it remains in `packages/web` and runtime stays unaware.

### Initialize state

Keep initial rendering behavior through Web's `getInitializeResult` override:

- Refresh the Web consent backend with the existing bounded behavior.
- Include `consent: backend.get()` only when a backend exists.
- Type the extended initialize result in Web as `InitializeResponse & { consent?: ConsentState }`.
- Remove consent from the shared `InitializeResponseSchema`.

Runtime may merge this value through its existing opaque initialize-result record. It must not import the Web type or inspect the `consent` key. A Web-only `consent/get` request is valid but not required.

### Sidecar ConsentService

Replace runtime's `ConsentConfigManager` with a sidecar-owned service:

```ts
export interface ConsentService {
  get(): ConsentState;
  refresh(): Promise<void>;
  set(params: ConsentSetParams): Promise<ConsentState>;
  isGranted(): boolean;
}
```

`createGatewayConsentService()` preserves current gateway behavior:

- Initial status is `none`.
- `GET /v1/consent` resolves `granted | withdrawn | none`.
- `POST /v1/consent` changes remote state.
- No token or initial refresh failure leaves transmission disabled.
- The last known state remains available after later transient refresh failures.
- `noticeAcknowledged: true` keeps its current grant mapping.
- `serviceImprovement` explicitly controls grant/withdraw when present.
- Privacy-policy version lookup remains timeout-bounded and cached.

Move OVERDARE privacy-policy URL constants and cache from runtime into this service or a sibling sidecar module.

### Product-owned transmission gate

Create one `ConsentService` in `apps/overdare-ai-agent/sidecar/src/server.ts` and share it with the Web backend and gateway provider:

```ts
const consentService = createGatewayConsentService();

await createWebServer({
  consentBackend: consentService,
  bundledToolProviders: createStudioBundledToolProviders({
    ...options,
    canTransmitRecords: () => consentService.isGranted(),
  }),
});
```

The gateway provider must fail closed and check at execution time:

```ts
const onEntryAppended: PluginHookFn = async (input) => {
  if (!canTransmitRecords()) return { blocked: false };

  const token = await resolveToken();
  if (!token || !canTransmitRecords()) return { blocked: false };

  await postRecord(input, projectId, userId, token);
  return { blocked: false };
};
```

The second check handles withdrawal during asynchronous token resolution. Aborting an already in-flight POST is out of scope.

Runtime's generic `EntryAppended` hook and asynchronous scheduling remain. Only the consent-specific pre-filter in `runEntryAppendedHooks()` is removed.

### Legacy local config compatibility

Because `DiligentConfigSchema` is strict, deleting `consent` without handling existing files can discard an otherwise valid config layer.

Before loading runtime config, the Web server performs a one-time, best-effort migration removing only the obsolete top-level `consent` subtree from global and project config files:

- Preserve comments and unrelated keys.
- Use `jsonc-parser` edits instead of parsing and rewriting as JSON.
- Do nothing when the file or key is absent.
- Log a warning and continue if migration fails.
- Cover the configured storage namespace's global config and `<cwd>/<project-dir>/config.jsonc`.
- Never copy local consent into the gateway; the gateway is the packaged product source of truth.

Keep this migration in Web/OVERDARE-owned code. Do not retain a deprecated consent field in runtime.

## Implementation sequence

Follow the repository rule to strengthen tests before behavior changes where practical.

1. **Establish sidecar gating tests.** Strengthen `gateway.test.ts` and `gateway-consent.test.ts`: none and withdrawn do not call `/v1/records`; granted calls once; withdrawal during token resolution prevents POST; GET/POST mapping remains unchanged. Refactor to `ConsentService`, inject `canTransmitRecords`, and update assembly.
2. **Move the client/server contract to Web.** Add Web-local schemas/types and update the client consent/lifecycle/state/components without changing UI behavior or copy.
3. **Add Web-level request interception.** Web owns `consentBackend`, initialization, and `consent/set`; it no longer passes consent into `createAppServerConfig`. Add focused Web tests for interception and unchanged forwarding of a core request.
4. **Migrate obsolete local config.** Add and test the Web-owned JSONC migration for comments, unrelated keys, missing files, absent consent, and both global/project paths. Run it before `loadRuntimeConfig()`.
5. **Remove runtime and protocol knowledge.** Remove consent-specific protocol, config, app-server, factory, dispatcher, barrel exports, and tests. Make `runEntryAppendedHooks()` invoke all hooks without reading consent while preserving off-write-tick fire-and-forget behavior.
6. **Update architecture documentation.** Document Web-owned product RPC interception, sidecar/Web consent ownership, and the explicit exception to the shared Web/TUI protocol rule. Add a P083 pointer to `OVDR-11475-consent-gateway-handoff.md`.

## Expected file changes

Delete or remove consent sections from runtime config/schema/writer, runtime app-server config/factory/handlers/dispatcher/server/barrels/tests, and protocol methods/client request schemas.

Add or substantially modify:

- Web-local consent protocol module.
- Web request interception in `packages/web/src/server/index.ts` or an adjacent module.
- Web legacy config migration and tests.
- Sidecar `ConsentService`.
- Gateway provider predicate injection and tests.
- Sidecar server/provider assembly.
- Web client imports and Web-local initialize typing.
- Architecture and prior handoff documentation.

## Verification

Run focused tests during implementation, then:

```sh
bun test packages/web/test
bun test packages/runtime/test/config packages/runtime/test/app-server packages/runtime/test/session
bun test apps/overdare-ai-agent/sidecar/test/tools
bun run typecheck
bun run lint
bun run --cwd packages/web build
bun run overdare-ai-agent:build-sidecar
```

Manual packaged checks:

- Gateway status `none` shows the first-run notice.
- Accepting updates the gateway and enables later record transmission.
- Turning service improvement off withdraws and stops new transmission without restart.
- Refresh/reconnect reflects gateway state.
- Missing token or unavailable consent endpoint never enables transmission.
- Unrelated `EntryAppended` providers run when OVERDARE consent is absent or withdrawn.
- Generic runtime/TUI startup has no consent UI, state, config, or RPC method.
- Legacy config retains all unrelated settings after Web migration.

## Definition of done

- `rg -n "consent|Consent|CONSENT" packages/runtime packages/protocol` returns no product consent implementation or contract references. Incidental prose about unrelated third-party authorization is acceptable.
- Direct `consent/set` requests never reach `DiligentAppServer`.
- Web consent behavior remains user-visible and gateway-backed.
- The gateway provider, not runtime, owns fail-closed transmission.
- Runtime invokes generic `EntryAppended` hooks without an OVERDARE policy gate.
- Existing local consent config cannot invalidate unrelated settings.
- Focused tests, typecheck, lint, Web build, and sidecar build pass.

## Primary risks

- **Fail-open transmission:** add and test the provider gate before removing the runtime gate.
- **Double JSON-RPC responses:** the Web router must consume Web requests and forward only unmatched methods.
- **Config layer loss:** remove legacy `consent` before strict schema validation.
- **Stale state during async work:** check consent again after token resolution.
- **Stale packaged frontend:** rebuild both Web and sidecar artifacts.
- **Dependency inversion:** Web must not import sidecar; sidecar implements and injects the Web-owned backend.

## References

- Original feature handoff: `docs/plan/feature/OVDR-11475-consent-gateway-handoff.md`
- Product runtime composition: `apps/overdare-ai-agent/sidecar/src/server.ts`
- Gateway consent implementation: `apps/overdare-ai-agent/sidecar/src/tools/gateway/consent.ts`
- Gateway record hook: `apps/overdare-ai-agent/sidecar/src/tools/gateway/index.ts`
- Web host: `packages/web/src/server/index.ts`
- Core request validation and generic hook dispatch: `packages/runtime/src/app-server/server.ts`
