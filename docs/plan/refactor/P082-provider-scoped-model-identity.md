---
id: P082
status: implemented
created: 2026-07-18
---

# P082: Provider-scoped model identity and catalog

## Goal

Replace the repository-wide assumption that a model ID is globally unique with
an explicit provider-scoped identity:

```typescript
interface ModelRef {
  provider: ProviderName;
  modelId: string;
}
```

The completed boundary should be:

```text
model catalog
  indexes: provider -> modelId -> model card
  permits: the same modelId under different providers
  rejects: unknown cards and provider inference from modelId prefixes

core/runtime
  carry: ModelRef or a resolved Model containing ModelRef
  compare: provider and modelId together
  dispatch: by the explicit provider

protocol/session/config
  serialize: { provider, modelId }
  never encode: provider identity into a synthetic modelId

Web/TUI/VS Code
  consume: the shared ModelRef contract
  use: client-local scalar keys only where a UI control requires one
```

This allows OpenAI API, ChatGPT subscription, and a future provider such as
Amazon Bedrock to expose the same provider-native model ID without renaming the
model to preserve global uniqueness.

## Confirmed requirements

1. Model identity is the pair `(provider, modelId)` everywhere it affects
   selection, dispatch, persistence, or presentation.
2. The catalog is provider-scoped: `provider -> modelId -> model card`.
3. The protocol change is intentionally breaking, but `protocolVersion`
   remains the fixed marker `1`. There is no version-1/version-2 wire adapter.
4. Unknown models do not receive inferred or default capabilities. A model must
   have an explicit model card before it can be selected or executed.
5. The canonical textual selector is `<provider>/<model-id>`.
6. An unqualified `<model-id>` is accepted only when it resolves to exactly one
   available model. Ambiguous input must instruct the user to qualify it.
7. Web, TUI, and VS Code ship with the protocol change in the same change set.

Requirement 3 follows D096: the marker remains `1`, protocol negotiation is not
introduced, and all in-repository clients are updated together.

## Related plans and decisions

- `ARCHITECTURE.md` defines the shared-protocol/thin-client rule.
- D003 keeps provider calls behind the common stream abstraction.
- D033/D034 define config precedence and merge behavior.
- D086 requires core/consumer data and session entries to remain JSON
  serializable.
- D095 keeps debug-viewer session DTOs local rather than importing runtime
  session types.
- D096 explicitly allows breaking protocol changes while keeping
  `protocolVersion: 1` fixed.
- P066 introduced Vertex as a distinct provider and documents its deployment
  model mapping.

## Current problem

The current catalog is a flat `MODEL_CARDS` array. `resolveModel(modelId)` does
an exact global search, then a global alias search, then infers the provider and
capabilities from string prefixes. An otherwise unknown string ultimately
receives an Anthropic-shaped fallback card.

This design makes a bare model ID perform three unrelated jobs:

1. catalog lookup key;
2. provider/auth routing key;
3. upstream provider model identifier.

The collision is already visible in the ChatGPT provider. ChatGPT cards use
synthetic IDs such as `chatgpt-5.5` so they do not collide with OpenAI's
`gpt-5.5`. The ChatGPT stream and native compaction path then convert the
synthetic ID back to the upstream `gpt-*` identifier immediately before the
request.

The flat-ID assumption has spread beyond the catalog:

- protocol model selections and current-model snapshots are strings;
- assistant messages record only a string model ID;
- runtime thread state, running-turn snapshots, and per-cwd caches store only
  model IDs;
- model changes compare only model IDs, so switching providers while keeping
  the same model ID can be missed;
- historical cost calculation resolves an assistant message by ID alone;
- model-class membership stores some entries in a global model-ID map;
- collaboration passes a child model ID through paths that later resolve it
  without provider context;
- Web and TUI picker values use model ID as a scalar identity;
- config persists one string and therefore cannot represent a collision.

Changing only the catalog container would leave these paths ambiguous. The
identity type must cross every boundary where a model is selected or restored.

## Terminology

### Provider

`provider` identifies the transport, authentication strategy, endpoint family,
and provider-specific behavior used to execute a request. It is not necessarily
the organization that created the model.

For example, a Bedrock-hosted Claude card would have `provider: "bedrock"` and
may separately use `ownedBy: "anthropic"`.

### Model ID

`modelId` is unique only within a provider. It should be the provider-facing
identifier unless a provider has an existing deployment mapping for reasons
other than global uniqueness.

P082 removes the ChatGPT `chatgpt-*` prefix because it exists solely to avoid a
global collision. P082 does not remove Vertex's deployment mapping or rename
its existing Diligent model ID; Vertex's `modelMap` addresses endpoint/deployment
translation and remains a separate concern.

### Model reference

`ModelRef` is the minimal serializable identity:

```typescript
export const ModelRefSchema = z.object({
  provider: ProviderNameSchema,
  modelId: z.string().min(1),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;
```

### Resolved model and model card

A resolved `Model`/`ModelCard` includes `ModelRef` plus explicit capabilities
and metadata. No code may construct an executable model by guessing
capabilities from `modelId`.

## Target core contract

### Model types

Rename the current `Model.id` and `ModelInfo.id` fields to `modelId` so the
identity vocabulary is consistent across core, protocol, runtime, and clients.
The final types should not retain `id` as a second canonical model field.

```typescript
export interface Model extends ModelRef {
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  cacheReadCostPer1M?: number;
  cacheWriteCostPer1M?: number;
  supportsThinking: boolean;
  supportedEfforts?: ThinkingEffort[];
  supportsVision?: boolean;
  supportsAdaptiveThinking?: boolean;
  supportsXhighEffort?: boolean;
  thinkingBudgets?: ThinkingBudgets;
}

export interface ModelCard extends Model {
  schemaVersion: typeof MODEL_CARD_SCHEMA_VERSION;
  aliases?: string[];
  display?: string;
  description?: string;
  ownedBy?: string;
  // Existing metadata remains.
}
```

### Catalog definition

Use a provider-scoped definition as the source of truth. A readonly object is
preferred for declaration and snapshots; lookup code may build private nested
`Map` indexes.

```typescript
export const MODEL_CATALOG = defineModelCatalog({
  openai: {
    "gpt-5.5": {
      display: "GPT-5.5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      // ...
    },
  },
  chatgpt: {
    "gpt-5.5": {
      display: "GPT-5.5",
      contextWindow: 300_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      // ...
    },
  },
  // Other providers remain provider-scoped.
});
```

The definition helper attaches `provider`, `modelId`, and `schemaVersion` to
each returned card. It must validate:

- a canonical model ID is unique within one provider;
- an alias does not collide with another canonical ID or alias within that
  provider;
- the same canonical ID or alias may exist under different providers;
- every provider policy and model-class entry points to an existing card.

Do not expose a mutable nested map. Replace consumer access to `MODEL_CARDS`
with focused APIs:

```typescript
resolveModel(ref: ModelRef): ModelCard;
findModel(ref: ModelRef): ModelCard | undefined;
listModels(provider?: ProviderName): ModelCard[];
sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean;
getDefaultModelRef(provider: ProviderName): ModelRef;
```

`resolveModel` is strict. It throws a typed unknown-model error containing the
requested reference. It has no bare-string overload in the final state.

### Alias resolution

Aliases are provider-local. Resolution always starts from an explicit
provider:

```typescript
resolveModel({ provider: "chatgpt", modelId: "gpt-5.6" });
```

The returned card contains the canonical `modelId`, for example
`gpt-5.6-sol`. A provider-qualified textual selector may use an alias, but the
protocol and persistence layers always receive the canonical reference.

### Provider defaults and model classes

Provider default policy may continue storing a model ID under a provider key,
because the provider is already explicit in that map. Its public API returns a
`ModelRef`:

```typescript
getDefaultModelRef(provider): ModelRef;
```

Model-class policy must not keep a global `Map<string, ModelClass>`. Convert
class membership to provider-scoped entries, for example:

```typescript
interface ModelClassDefinition {
  id: ModelClass;
  defaultEffort: ThinkingEffort;
  defaultModelIds: Partial<Record<ProviderName, string>>;
  additionalModelIds?: Partial<Record<ProviderName, readonly string[]>>;
}
```

Class lookup uses the full reference. This allows OpenAI and ChatGPT to share
`gpt-5.6-sol` while assigning or changing class membership independently.

### Agent and provider boundary

Core `Agent` and `RuntimeAgent` constructors and `setModel()` should accept a
resolved `Model`, not `string | Model`. Resolution occurs before agent
construction. This prevents the agent layer from reintroducing bare-ID
provider inference.

`ProviderManager.createProxyStream()` continues dispatching on
`model.provider`. Provider adapters receive `model.modelId` as their upstream
identifier.

The ChatGPT stream and native-compaction adapters must delete
`resolveChatGPTModelId()`. ChatGPT cards become:

```text
chatgpt/gpt-5.5
chatgpt/gpt-5.6-sol
chatgpt/gpt-5.6-terra
chatgpt/gpt-5.6-luna
```

OpenAI retains the same model IDs under the `openai` provider.

## Target protocol contract

Add `ModelRefSchema` to the shared protocol data model and use it directly in
every model-selection field.

| Contract | Current | Target |
|----------|---------|--------|
| `ModelInfo` identity | `{ id, provider }` | `{ modelId, provider }` |
| `InitializeResponse.currentModel` | `string` | `ModelRef` |
| `ThreadStartParams.model` | `string` | `ModelRef` |
| `ThreadReadResponse.currentModel` | `string` | `ModelRef` |
| `TurnStartParams.model` | `string` | `ModelRef` |
| `ConfigSetParams.model` | `string` | `ModelRef` |
| `ConfigSetResponse.model` | `string` | `ModelRef` |
| `AssistantMessage.model` | `string` | `ModelRef` |

`ModelInfo.provider` must use `ProviderNameSchema`, not an unconstrained
string. Add provider-local `aliases` to `ModelInfo` so Web and TUI can retain
alias selection without importing or independently rebuilding the core
catalog.

Example initialize payload:

```json
{
  "protocolVersion": 1,
  "currentModel": {
    "provider": "chatgpt",
    "modelId": "gpt-5.5"
  },
  "availableModels": [
    {
      "provider": "openai",
      "modelId": "gpt-5.5",
      "display": "GPT-5.5",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "supportsThinking": true
    },
    {
      "provider": "chatgpt",
      "modelId": "gpt-5.5",
      "display": "GPT-5.5",
      "contextWindow": 300000,
      "maxOutputTokens": 128000,
      "supportsThinking": true
    }
  ]
}
```

This is an in-place breaking contract change. Do not add unions such as
`z.union([z.string(), ModelRefSchema])` to protocol request/response schemas.
Legacy compatibility belongs only at persisted config and session read
boundaries.

Keep initialize request validation and response output at
`protocolVersion: 1`, consistent with D096.

## Runtime state and dispatch

Replace ID-only state with `ModelRef`:

```typescript
interface ThreadRuntime {
  model: ModelRef;
  runningModelSnapshot?: ModelRef;
  // Existing fields remain.
}
```

The same replacement applies to:

- `CreateAgentArgs`;
- app-server default/current model state;
- `ModelConfig` callbacks;
- per-cwd last-used model caches;
- thread start/read/resume helpers;
- turn overrides;
- collaboration dependencies and child-stop metadata where internal;
- current-model lookups in session context.

Never compare model references with `===` or compare only `modelId`. Use
`sameModelRef()`.

At turn start, a change from `openai/gpt-5.5` to
`chatgpt/gpt-5.5` must:

1. append a model-change entry;
2. update the thread's current model;
3. clear the cached agent;
4. rebuild provider-specific tools and native compaction;
5. dispatch through ChatGPT authentication rather than OpenAI authentication.

Runtime provider resolution should read `runtime.model.provider` or the
resolved agent model. Delete fallbacks that call `resolveModel(modelId)` merely
to recover a provider.

## Config contract and migration

### New stored form

Persist model selection as an object:

```json
{
  "model": {
    "provider": "chatgpt",
    "modelId": "gpt-5.5"
  }
}
```

The runtime-facing normalized `DiligentConfig` type should expose only
`ModelRef`. A separate stored/legacy input schema may accept the old string
form during loading.

Treat `model` as an atomic config field during global/project merge. The
existing recursive object merge must not combine `provider` from one layer
with `modelId` from another layer.

`saveGlobalModel()` accepts a `ModelRef` and writes the whole object in one
JSONC edit while preserving unrelated comments and formatting.

Update the OVERDARE bootstrap config and provider-auth guide examples to the
new object form.

### Legacy string normalization

Create one runtime-owned migration adapter, for example
`packages/runtime/src/model/legacy-model-ref.ts`. It may understand known
pre-P082 Diligent storage syntax, but it must never create a model card or infer
capabilities.

The ownership boundary is intentional:

- core catalog and provider code accept only canonical `ModelRef` values;
- ChatGPT streaming and compaction never know that `chatgpt-*` IDs existed;
- runtime config/session readers call the adapter for persisted legacy data;
- protocol requests and new client input do not pass through the legacy
  adapter;
- the adapter output is validated against the strict core catalog before use.

The adapter performs the old synthetic split explicitly. For example,
`chatgpt-5.5` becomes `{ provider: "chatgpt", modelId: "gpt-5.5" }` before
strict catalog resolution.

| Legacy value | Canonical reference |
|--------------|---------------------|
| `gpt-5.5` | `openai/gpt-5.5` |
| `gpt-5.6-sol` | `openai/gpt-5.6-sol` |
| `chatgpt-5.5` | `chatgpt/gpt-5.5` |
| `chatgpt-5.6-sol` | `chatgpt/gpt-5.6-sol` |
| `chatgpt-5.6-terra` | `chatgpt/gpt-5.6-terra` |
| `chatgpt-5.6-luna` | `chatgpt/gpt-5.6-luna` |
| Existing non-colliding canonical IDs | Their historical provider/card |

Known legacy aliases may resolve only when they map deterministically to an
explicit card. An unknown value, or a legacy alias that has become ambiguous,
is a configuration error. It must not receive a fabricated model with default
capabilities.

Preserve the existing auth policy after successful resolution: if the selected
known provider is unavailable and the runtime currently falls back to a
configured provider default, that behavior may remain. Unknown-card handling
must happen before auth fallback so invalid configuration is not disguised as
an authentication choice.

## Session and assistant-message migration

`ModelChangeEntry` already stores `provider` and `modelId`; retain those fields
and normalize old ChatGPT synthetic IDs when entries are read. New entries use
canonical provider-native IDs.

Change new assistant messages to store:

```json
{
  "role": "assistant",
  "model": {
    "provider": "chatgpt",
    "modelId": "gpt-5.5"
  }
}
```

Increment `SESSION_VERSION` for newly created session files. Continue reading
older versions. Do not rewrite existing JSONL files in place.

The session read boundary must accept legacy assistant `model: string` values
and return normalized in-memory messages:

1. normalize all legacy model-change entries to canonical references;
2. build the entry parent index and find the nearest model-change ancestor for
   each legacy assistant message, memoizing results so branched sessions do not
   inherit model state from an unrelated append order;
3. use that provider-aware ancestor context when available;
4. otherwise use the deterministic legacy resolver for known pre-P082 IDs;
5. never synthesize capabilities for an unknown model;
6. surface a clear resume/read diagnostic when an old model cannot be mapped.

An older resumed file may therefore contain old string messages followed by
new object messages. The current reader must normalize each entry rather than
assuming one message shape from the header alone. Backward readability by an
older Diligent binary is not required.

Historical cost calculation must resolve each assistant message's full
`ModelRef`. It must not use the thread's latest model for older messages, since
a thread may switch provider or model between turns.

Per D095, debug-viewer adds local legacy/current DTOs and parsing guards. It
must not import runtime session types to make the migration easier.

## Text selector and client behavior

### Selector grammar

Canonical syntax:

```text
<provider>/<model-id-or-alias>
```

Split on the first `/` only. The remainder belongs to the model identifier and
may itself contain `/`, which is important for gateway, Bedrock, or deployment
IDs.

Resolution rules:

1. A recognized provider prefix scopes exact-ID and alias lookup to that
   provider.
2. An unqualified exact ID or alias is searched across currently selectable
   cards.
3. Exactly one canonical result succeeds.
4. No results produce `Unknown model: <input>`.
5. Multiple results produce an ambiguity error listing qualified candidates.
6. Clients send the canonical `ModelRef`, never the user's alias text.

Examples:

```text
/model chatgpt/gpt-5.5       # deterministic
/model openai/gpt-5.5        # deterministic
/model gpt-5.5               # rejected when both are selectable
/model claude-sonnet-4-6     # accepted when unique
```

The Web slash command should follow the same grammar as the TUI command so the
shared product behavior does not drift.

### TUI

- Group picker entries by provider as today.
- Make picker selection and selected-index matching provider-aware.
- Pass `ModelRef` through command context, config manager, thread start, and
  turn start.
- Show a qualified selector in ambiguity errors and status surfaces where two
  visible cards share a model ID.
- Preserve current provider-auth onboarding behavior; this plan changes model
  identity, not the provider setup flow.
- Stop resolving a selected model later from a bare picker string.

### Web

- Store `currentModel` and its ref as `ModelRef`, not `string`.
- Find model metadata with both provider and model ID.
- Use a client-local scalar option key only for the generic `<Select>` control.
  Build the key from a known option and map it back through the option list;
  never send or persist the encoded key.
- Continue grouping options by provider.
- Ensure draft/reset/session hydration compares full references.
- Apply the shared selector behavior to the Web `/model` command.

### VS Code

The extension does not currently expose full model selection, but it consumes
initialize and thread-read protocol types. Update initialization, stored
available models, fixtures, and any conversation metadata rendering. Do not
introduce an extension-only model contract.

## Scope

### What changes

| Area | Change |
|------|--------|
| Protocol | Add `ModelRef`; replace model string fields in place |
| Core catalog | Replace flat global-ID lookup with provider-scoped catalog/indexes |
| Core model API | Rename `id` to `modelId`; make resolution strict and provider-aware |
| Provider policies | Return and compare full references |
| ChatGPT | Use canonical `gpt-*` IDs and remove reverse translation |
| Agent | Accept resolved models rather than model strings |
| Runtime | Carry `ModelRef` through thread, turn, cache, factory, and collab state |
| Config | Store object form; normalize known legacy strings; merge atomically |
| Session | Persist provider-aware assistant messages and normalize legacy entries |
| Cost | Resolve the exact provider/model card used by each assistant message |
| Web | Provider-aware state, selection, hydration, and slash command |
| TUI | Provider-aware picker, status, command, and RPC payloads |
| VS Code | Consume the changed shared protocol types |
| Debug viewer | Parse legacy and current model identities with local DTOs |
| Evals/e2e | Make profiles and fixtures explicitly provider-aware |
| Docs | Update current architecture/guides after implementation |

### What does not change

- No Amazon Bedrock provider implementation in P082.
- No remote model discovery or dynamic catalog endpoint.
- No arbitrary/custom model capability inference.
- No implicit `unknown -> anthropic` fallback.
- No protocol version negotiation or `protocolVersion: 2` marker.
- No concurrent support for old and new wire request/response shapes.
- No in-place rewrite of existing session JSONL files.
- No provider auth storage or OAuth flow redesign.
- No removal of Vertex deployment `modelMap` behavior.
- No plugin SDK model-selection API expansion.
- No change to model pricing or capability values except where the provider
  identity correction requires separate cards.

## Planning decisions

1. **Composite identity is a value object:** use `ModelRef`; do not pass
   provider and model ID as unrelated optional arguments.
2. **Provider is transport identity:** model ownership remains metadata.
3. **Catalog keys are provider-local:** duplicate IDs across providers are
   valid and covered by tests.
4. **Capabilities are explicit:** only registered cards can be resolved for
   execution.
5. **No prefix inference in steady state:** string-prefix logic is limited to
   a named legacy migration adapter.
6. **No bare-string core overload:** the final `resolveModel` API requires a
   `ModelRef`.
7. **Canonical IDs reach providers:** ChatGPT no longer edits model IDs before
   streaming or compaction.
8. **Protocol breaks in place:** all clients update together while the marker
   remains `1` per D096.
9. **Persistence compatibility is narrower than wire compatibility:** old
   config and sessions remain readable when deterministically mappable.
10. **Unknown legacy values fail explicitly:** migration never invents a card.
11. **Config model selection is atomic:** config layer merging cannot create a
    hybrid reference.
12. **UI scalar keys are adapters:** encoded picker values never become domain
    identifiers.
13. **Qualified selector is canonical:** unqualified selection is convenience
    only and requires uniqueness.
14. **Full-ref comparison is centralized:** no ad hoc provider/model equality
    checks across clients and runtime.
15. **All current clients are in scope:** Web and TUI receive full behavior;
    VS Code receives protocol compatibility.

## Implementation plan

### Task 0: Establish a green baseline

- Run focused model registry, provider policy, ChatGPT transport/compaction,
  runtime app-server/session/collab, protocol, TUI model command, Web model
  selection, VS Code, debug-viewer, and e2e tests.
- Run `bun run typecheck`.
- Record unrelated pre-existing failures before behavioral edits.

### Task 1: Write collision and strictness tests first

Add failing tests proving:

1. `openai/gpt-5.5` and `chatgpt/gpt-5.5` coexist and resolve to distinct
   cards;
2. duplicate IDs across providers are accepted, while duplicate IDs or aliases
   within one provider are rejected;
3. an unknown `ModelRef` fails and receives no fallback capability values;
4. aliases resolve only within the requested provider;
5. default and model-class policies preserve provider identity;
6. ChatGPT sends `gpt-5.5`/`gpt-5.6-*` unchanged for streaming and native
   compaction;
7. switching provider with the same model ID rebuilds the runtime agent and
   appends a model change;
8. child agents inherit and resolve the parent's provider correctly;
9. historical costs use the assistant message's exact provider card;
10. protocol schemas require `ModelRef` and reject bare string model fields;
11. Web and TUI can select two visible cards with the same model ID;
12. config migration maps known legacy ChatGPT IDs and rejects unknown values;
13. a project config model object atomically replaces the global model object;
14. old session messages normalize without rewriting the file;
15. qualified/unqualified selector behavior is identical in Web and TUI.

### Task 2: Add the shared identity schema and helpers

- Add `packages/protocol/src/model-ref.ts` and export
  `ModelRefSchema`/`ModelRef` from `@diligent/protocol`.
- Add JSON round-trip tests.
- Add `sameModelRef()` and a diagnostic formatter such as
  `formatModelRef(ref) -> "provider/modelId"` beside the shared model-ref data
  contract so core, runtime, and clients use the same equality semantics and
  diagnostic spelling.
- Keep parsing of slash-command text client-owned; protocol remains a schema
  and data-model package.
- Change `ModelInfoSchema` to use `modelId`, `ProviderNameSchema`, and
  provider-local `aliases`.

At this stage, adding `ModelRef` may be source-additive. Do not flip existing
wire fields until runtime and clients are ready in the same change series.

### Task 3: Replace the core catalog and resolution API

- Rewrite `packages/core/src/llm/models.ts` around the provider-scoped catalog.
- Rename `Model.id`/`ModelInfo.id` to `modelId`.
- Add private exact and alias indexes by provider.
- Replace `MODEL_CARDS` consumer filtering with `listModels()`.
- Replace `resolveModel(string)` with strict `resolveModel(ModelRef)`.
- Add a typed unknown-model error suitable for runtime invalid-params mapping.
- Remove every steady-state provider-prefix inference branch and the unknown
  Anthropic fallback.
- Export only the focused registry APIs through `model-registry`.
- Keep model cards immutable from consumer code.

### Task 4: Convert provider defaults, classes, and thinking helpers

- Replace `getDefaultModelId()` public use with `getDefaultModelRef()`.
- Make model-class additional membership provider-scoped.
- Key class lookup by full reference.
- Update thinking-effort helpers and `findModelInfo()` to accept/compare
  `ModelRef`.
- Add policy integrity tests that every referenced provider/model pair exists.
- Update eval profiles to call `resolveModel({ provider, modelId })`; retain
  their explicit provider field or replace the pair with `ModelRef`, but never
  resolve the model string independently.

### Task 5: Remove synthetic ChatGPT IDs

- Rename ChatGPT catalog keys and provider-local aliases to canonical `gpt-*`
  IDs.
- Remove `resolveChatGPTModelId()` from the stream implementation.
- Remove the duplicate helper from ChatGPT native compaction.
- Pass `model.modelId` directly to HTTP/SSE, WebSocket, and compaction request
  builders.
- Update GPT-5.6 transport-selection checks for canonical IDs.
- Strengthen provider tests to inspect the exact outbound model value.
- Leave OpenAI behavior unchanged; identical IDs are distinguished by the
  resolved model's provider.

### Task 6: Make core Agent construction strict

- Change `Agent` and `RuntimeAgent` constructors to accept a resolved `Model`.
- Change `setModel()` similarly.
- Update core tests and helpers to define explicit test models or resolve a
  `ModelRef` first.
- Ensure retry, compaction, tool exposure, loop hooks, and cost code retain the
  full resolved model.
- Remove imports of `resolveModel` from Agent internals.

### Task 7: Normalize config input and output

- Add the runtime-only legacy model adapter under a focused runtime model or
  migration module.
- Keep all `chatgpt-*` compatibility mappings in that adapter and its tests;
  do not add them as core catalog aliases.
- Split stored/legacy model input from normalized runtime config typing.
- Accept structural object form and known legacy strings at the file-read
  boundary only.
- Normalize to canonical `ModelRef` before returning `DiligentConfig` to
  runtime consumers.
- Treat `model` as atomic in `mergeConfig()`.
- Change `resolveRuntimeModel()` to accept a normalized reference.
- Reject unknown cards before configured-provider fallback.
- Change `saveGlobalModel()` to write the full reference.
- Update config writer/loader/schema tests, bootstrap config, and guide
  examples.

### Task 8: Convert runtime thread and turn state

- Rename `ThreadRuntime.modelId` to `model` and store `ModelRef`.
- Rename `runningModelIdSnapshot` to `runningModelSnapshot`.
- Convert app-server current/default model state and per-cwd caches.
- Convert `CreateAgentArgs`, `ModelConfig`, factory callbacks, thread handlers,
  turn handlers, session handlers, and request dispatcher.
- Validate catalog membership for `thread/start`, `turn/start`, and
  `config/set` references.
- Compare references with `sameModelRef()`.
- Resolve a card once at the factory boundary and pass the resolved object to
  the agent.
- Derive provider/auth/compaction from the explicit reference rather than
  re-resolving an ID.
- Map unknown model errors to JSON-RPC invalid params with the qualified
  selector in the message.

### Task 9: Convert collaboration and hook context

- Change `CollabToolDeps.modelId` to `model: ModelRef` or a resolved `Model`.
- Preserve the full model through registry updates and nested child tools.
- Pass `childModel` itself to `RuntimeAgent` rather than `childModel.modelId`.
- Make class routing resolve within the parent provider.
- Keep external Stop hook fields as separate canonical `provider` and `model`
  strings unless a hook-contract change is independently required; together
  they are already unambiguous.
- Add a regression where parent and another provider share the same model ID.

### Task 10: Migrate assistant messages and session reads

- Change protocol/core assistant-message creation to store `ModelRef`.
- Increment `SESSION_VERSION` for new files.
- Add legacy raw-message parsing and normalization in the session persistence
  boundary.
- Normalize old ChatGPT model-change IDs through the runtime migration adapter,
  using the entry's explicit provider when present.
- Update context building to stop inferring current provider from a bare
  assistant model string.
- Preserve mixed legacy/current entries when appending to an older resumed
  file.
- Update thread-read and transcript cost builders to resolve the message's full
  reference.
- Add resume, compaction, branching, reconciliation, and cost regression tests.

### Task 11: Flip the protocol fields in place

- Replace every tabled model field with `ModelRefSchema`.
- Keep `protocolVersion` request validation and response output at `1`.
- Update request/response unions and exported inferred types.
- Update protocol fixtures and JSON-RPC round-trip tests.
- Do not accept string fields on the wire.
- Update runtime notification/event serialization affected through
  `AssistantMessageSchema`.

This task and the three client tasks must land together so the repository does
not ship an out-of-sync server/client pair.

### Task 12: Update Web

- Convert provider-manager state and refs to `ModelRef`.
- Replace ID-only `find()`/`some()` checks with full-ref helpers.
- Convert initialize, thread hydration, draft reset, send, follow-up, steering,
  and config-set payloads.
- Build picker options with client-local scalar keys mapped back to known
  `ModelInfo` entries.
- Keep provider grouping and display labels.
- Implement the qualified/unqualified `/model` resolution rules.
- Normalize thinking effort using the selected full `ModelInfo`.
- Add duplicate-ID selection, hydration, auth refresh, slash command, and
  optimistic update rollback tests.

### Task 13: Update TUI and non-interactive CLI

- Convert `AppConfig`, config manager, command context, session lifecycle,
  thread manager, send/turn paths, and status updates to full references.
- Make picker item values provider-aware and map them back to cards before
  sending RPC requests.
- Implement first-slash qualified parsing and unique-only unqualified lookup.
- List qualified candidates on ambiguity.
- Preserve provider auth prompting and effort normalization.
- Update welcome/status presentation so duplicate IDs are distinguishable.
- Convert non-interactive thread/turn request construction.
- Add command, picker, resume, config reload, and runner tests.

### Task 14: Update VS Code and supporting consumers

- Update VS Code initialize fixtures, thread store, session controller, and
  protocol tests.
- Update debug-viewer local session types, parser guards, model lookup, message
  badges, and cost rendering for legacy/current identities.
- Update e2e helpers and provider test matrices to provide `ModelRef`.
- Update test model constants so every executable model has explicit
  capabilities.
- Update OVERDARE sidecar/bootstrap fixtures that persist model selection.
- Audit docs and sample JSONL/JSONC data for synthetic ChatGPT IDs and bare
  model selections.

### Task 15: Remove transitional compatibility code

- Remove temporary internal overloads introduced to keep intermediate commits
  compiling.
- Search for `resolveModel(` calls with strings.
- Search for model comparisons using only `.modelId`.
- Search for current/runtime fields still named `modelId` where they represent
  a full selection.
- Search for `chatgpt-5.` outside legacy migration tests/fixtures.
- Search protocol schemas for `model: z.string()` and string current-model
  fields.
- Ensure `MODEL_CARDS` is no longer used as the primary public catalog API.

### Task 16: Verify and promote documentation

- Run focused tests after each package change.
- Run `bun run typecheck`, `bun run lint`, `bun run test`,
  `bun run test:e2e`, `bun run web:build`, `bun run debug-viewer:build`, and
  `bun run vscode:test`.
- Manually verify OpenAI/ChatGPT duplicate-ID selection and old-session resume
  in Web and TUI.
- Update `ARCHITECTURE.md` with provider-scoped model identity as a core/runtime
  invariant.
- Update relevant guides with the object config form and selector syntax.
- After implementation, move durable rationale to `decisions.md` if it is not
  already fully covered by D096 and architecture documentation; archive or
  remove this plan according to `docs/plan/README.md`.

## Expected file changes

| Package/area | Likely files |
|--------------|--------------|
| protocol | `src/data-model.ts`, `src/client-requests.ts`, exports, protocol flow/JSON-RPC tests |
| core model registry | `src/llm/types.ts`, `src/llm/models.ts`, `src/model-registry.ts` |
| core policy | `src/llm/provider-model-policy.ts`, `src/llm/model-class-policy.ts`, `src/llm/thinking-effort.ts` |
| core agent | `src/agent/agent.ts`, `src/agent/assistant.ts`, agent tests/helpers |
| ChatGPT provider | `src/llm/provider/chatgpt/index.ts`, `native-compaction.ts`, transport/compaction tests |
| runtime config/model migration | `src/config/schema.ts`, `loader.ts`, `runtime.ts`, `writer.ts`, new legacy model adapter, tests |
| runtime app-server | `server.ts`, `factory.ts`, `request-dispatcher.ts`, config/thread/turn/session handlers |
| runtime session | `src/session/types.ts`, `persistence.ts`, `context-builder.ts`, `manager.ts`, session tests |
| runtime collab | `src/collab/types.ts`, `registry.ts`, collab tests |
| runtime rendering/cost | `src/cost.ts`, `src/app-server/thread-read-builder.ts`, tests |
| CLI/TUI | config, lifecycle, managers, `/model`, picker/status/send paths, TUI tests |
| Web | provider manager, app lifecycle/actions/state, thinking helpers, `InputDock`, Web tests |
| VS Code | thread session/store and fixtures/tests |
| debug-viewer | local shared types, parser/API/message card, parser/render tests |
| evals/e2e | profiles, runner helpers, protocol/provider/session scenarios |
| product bootstrap | `apps/overdare-ai-agent/bootstrap/config.jsonc` and related tests |
| docs | `ARCHITECTURE.md`, provider/config guides, this plan |

## Acceptance criteria

1. The catalog can contain the same `modelId` under multiple providers.
2. OpenAI and ChatGPT both expose canonical `gpt-5.5` and `gpt-5.6-*` IDs.
3. ChatGPT streaming and native compaction send canonical IDs without a
   provider-prefix rewrite.
4. `resolveModel` requires provider context and has no unknown capability
   fallback.
5. Unknown config, CLI, Web, and RPC selections fail explicitly.
6. Provider-local aliases cannot select a model from another provider.
7. Model-class routing stays within the current provider.
8. Switching providers with the same model ID is recorded and rebuilds the
   active agent/provider path.
9. Parent and child agents retain the exact provider/model reference.
10. Protocol model selections and assistant messages use `ModelRef` objects.
11. Protocol schemas reject bare string model selections while
    `protocolVersion` remains `1`.
12. Config writes `{ provider, modelId }` and treats it atomically across
    config layers.
13. Known legacy config strings migrate deterministically; unknown values do
    not create cards.
14. Existing sessions with string assistant model fields remain readable when
    their identities are deterministically mappable.
15. New assistant messages preserve provider identity and historical costs use
    the correct provider card.
16. TUI and Web pickers can distinguish and select duplicate model IDs.
17. `/model provider/model-id` works in TUI and Web.
18. Unqualified `/model model-id` succeeds only for one canonical result and
    reports all qualified candidates when ambiguous.
19. VS Code compiles and consumes the updated shared protocol without a local
    alternate contract.
20. Debug-viewer reads both legacy and current session message identities
    without importing runtime session types.
21. Vertex deployment mapping behavior remains covered and unchanged.
22. Core, protocol, runtime, CLI, Web, VS Code, debug-viewer, eval, and e2e
    verification passes.

## Testing strategy

| Category | What to test |
|----------|--------------|
| Catalog unit | Duplicate IDs across providers, local alias collision rejection, immutability |
| Resolution unit | Strict full-ref resolution, canonical aliases, unknown errors |
| Policy unit | Provider defaults, class lookup, effort normalization with duplicate IDs |
| Provider unit | Exact ChatGPT outbound IDs for HTTP, WebSocket, and compaction |
| Config unit | Object schema, atomic merge, legacy mapping, unknown rejection, JSONC preservation |
| Session unit | Legacy/current normalization, mixed files, branch paths, resume, reconciliation |
| Runtime integration | Same-ID provider switch, agent rebuild, auth routing, per-cwd restore |
| Collab integration | Parent provider inheritance and class routing for child agents |
| Cost | Different prices for the same model ID under different providers |
| Protocol | Object-only request/response/message shapes and JSON serialization |
| Web | Picker keys, hydration, model change, slash ambiguity, effort metadata |
| TUI | Grouped picker, selected index, qualified parsing, ambiguity, status, auth flow |
| VS Code | Initialize/thread types and fixtures |
| Debug viewer | Legacy/current parser and provider-aware lookup/cost |
| E2E | Configure two providers, select duplicate IDs, run/resume/switch turns |

## Manual verification matrix

| Scenario | Web | TUI |
|----------|-----|-----|
| OpenAI and ChatGPT both configured | Both `gpt-5.5` cards visible in separate groups | Same |
| Select `openai/gpt-5.5` | OpenAI auth/stream used | Same |
| Switch to `chatgpt/gpt-5.5` | Agent rebuilds; ChatGPT OAuth/stream used | Same |
| Run `/model gpt-5.5` with both visible | Ambiguity with two qualified candidates | Same |
| Run `/model chatgpt/gpt-5.5` | Deterministic success | Same |
| Unknown model | Explicit error; no fallback | Same |
| Resume pre-P082 ChatGPT session | Canonical ChatGPT reference restored | Same |
| Spawn child after provider switch | Child stays on ChatGPT class route | Same |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| One ID-only field remains | Provider silently changes or wrong auth is used | Repository-wide searches plus same-ID switch e2e test |
| Object config deep-merges | Hybrid provider/model selection | Treat `model` as atomic and test layer precedence |
| Legacy resolver becomes steady-state inference | Unknown cards regain guessed capabilities | Separate named migration module; no use from normal resolution |
| Assistant messages lose provider | Historical cost and resume are wrong | Store `ModelRef`; test multi-provider thread history |
| UI encoding leaks into RPC | A new synthetic global ID replaces the old one | Map local option keys back to `ModelRef` before actions |
| Alias collision is hidden | Unqualified selection becomes nondeterministic | Catalog validation and explicit ambiguity errors |
| Protocol/client rollout is split | Clients fail schema validation | Land runtime/protocol/Web/TUI/VS Code flip together |
| Older sessions contain arbitrary models | Resume cannot build a valid card | Preserve readable diagnostics; fail execution explicitly without capabilities |
| ChatGPT rewrite remains in one path | Stream and compaction disagree | Exact outbound-ID tests for every transport path |
| Debug-viewer imports runtime types | Diagnostics boundary is violated | Follow D095 with local DTO unions and guards |
| Vertex mapping is accidentally removed | Existing Vertex requests send the wrong deployment ID | Explicit non-goal and Vertex regression tests |

## Rollout and commit structure

Keep each commit buildable where practical:

1. add failing collision/strictness tests and the additive `ModelRef` schema;
2. add provider-scoped catalog APIs with temporary internal compatibility only;
3. convert core policies, Agent construction, and ChatGPT canonical IDs;
4. add config/session legacy normalization and provider-aware runtime state;
5. flip protocol fields and all three clients together;
6. update debug-viewer, evals, e2e, bootstrap files, and current docs;
7. remove temporary overloads and complete full verification.

There is no old-wire compatibility window. Persisted-data adapters remain
after rollout because users may keep old config and session files indefinitely.

## Deferred follow-ups

1. Add Amazon Bedrock as a provider using the provider-scoped catalog.
2. Add remote/provider model discovery only after defining trusted capability
   metadata, cache invalidation, and offline behavior.
3. Add explicit user-defined model cards if a real custom-model requirement is
   approved; P082 intentionally rejects implicit custom capabilities.
4. Revisit Vertex's public model ID separately if product requirements decide
   that every catalog ID must be the exact endpoint identifier.
5. Introduce protocol negotiation only when independently deployed clients
   create a concrete compatibility requirement, as described by D096.

## Decisions referenced

| ID | Summary | Where used |
|----|---------|------------|
| D003 | Provider calls remain behind the stream abstraction | Explicit provider on resolved model selects the stream |
| D033/D034 | Config layer precedence and merge rules | Model object replaces lower layers atomically |
| D086 | Boundary/session data remains JSON serializable | `ModelRef` is a data-only object |
| D095 | Debug-viewer keeps local runtime-artifact DTOs | Legacy/current session parsing remains locally typed |
| D096 | Protocol marker remains fixed at `1` | Breaking model contract ships without version negotiation |
