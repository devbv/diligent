# Direct OpenAI and Anthropic Provider Audit Against Vercel AI

**Date**: 2026-07-17
**Diligent baseline**: `ac2fca459f52909530b63edac1d6d9f31fd87859`
**Vercel AI baseline**: `/Users/devbv-mini4/git/ai` at
`223b5c33f745bc944de553a59992906e16c2cc78`
**Scope**: Diligent's direct OpenAI API, ChatGPT subscription, and Anthropic API implementations under
`packages/core/src/llm/provider`, with Vercel AI used as a wire-contract and edge-case reference.

## Executive Verdict

**YELLOW** — Keeping direct provider implementations is the correct strategy for Diligent. The current code should
not be replaced with `@ai-sdk/openai` or `@ai-sdk/anthropic`. Direct ownership gives Diligent control over new model
fields, ChatGPT subscription transports, compaction, retry behavior, persisted provider state, and debugging.

The comparison nevertheless found current-contract defects that should be fixed before adding more provider
features:

1. Anthropic thinking requests can send invalid or stale combinations for `none`, `xhigh`, and `temperature`.
2. Anthropic's 2026 web tools are selected while `allowed_callers: ["direct"]` disables their main dynamic-filtering
   capability; this needs an explicit product policy, not a beta header.
3. OpenAI `response.incomplete` and top-level stream `error` events are not terminal events in Diligent.
4. OpenAI function-call deltas use an output-item ID that Diligent never correlates with the public call ID.
5. Diligent requests OpenAI encrypted reasoning content but discards it and cannot replay reasoning state.

The comparison also confirmed several over-implementations. The strongest cleanup candidates are the hand-written
SSE framing parser, speculative compaction response recovery, speculative web-result shape search, semantic rewriting
of Anthropic JSON Schema unions, and duplicate WebSocket diagnostics decoding.

This audit uses Vercel AI as a differential reference, not as a dependency plan. The desired end state remains:

```text
official OpenAI / Anthropic transport SDKs where they fit
        +
Diligent-owned request, event, persistence, retry, and product mapping
        +
small standard protocol utilities for generic framing such as SSE
```

## Decision Rules

The following rules were used to avoid turning this audit into an AI SDK migration proposal.

### Add or correct behavior when

- Diligent already exposes the capability but emits an invalid request or misclassifies a valid response.
- A missing field loses state required for correct continuation, retry, compaction, or tool execution.
- Both public OpenAI/Anthropic wire shapes and the Vercel implementation identify the same edge case.
- The change can remain provider-local and does not require adopting the AI SDK provider abstraction.

### Remove or reduce behavior when

- a mature protocol utility already owns the concern;
- a decoder supports many guessed aliases or nesting layouts without captured upstream fixtures;
- a fallback invents new semantics instead of preserving an upstream contract; or
- two layers decode the same payload only to support diagnostics.

### Do not copy from Vercel solely because it exists

Vercel supports a general-purpose provider surface. Diligent is a coding agent with a narrower LLM contract. The
following are not gaps unless a Diligent product requirement is added:

- embeddings, image generation, speech, transcription, realtime, and completion APIs;
- OpenAI Conversations, `previous_response_id`, service tiers, log probabilities, and arbitrary metadata;
- hosted file search, MCP, computer use, code interpreter, shell, and image-generation provider tools;
- Anthropic hosted MCP, code execution, advisor, skills, server-side fallback chains, and fast mode;
- a generic provider-options framework or AI SDK warning model; and
- importing Vercel's complete Zod event schemas into Diligent.

## Supported Model Floor and Deletion Policy

This audit intentionally does not preserve compatibility for every historical OpenAI or Anthropic model. Provider
code only earns a compatibility branch when it is required by one of the following:

1. a model in the current Diligent catalog or model-class routes;
2. the current wire contract shared by those models;
3. a redacted payload fixture captured from a currently supported endpoint; or
4. the explicit unknown-model fallback used to adopt a new model ID before the catalog is updated.

The current direct-provider support floor is:

| Provider | Current Diligent families that justify compatibility code |
|---|---|
| Anthropic | Claude Opus 4.8, Fable 5, Sonnet 5, Sonnet 4.6, Haiku 4.5 |
| OpenAI API | GPT-5.6 variants, GPT-5.5 |
| ChatGPT subscription | ChatGPT GPT-5.6 variants, GPT-5.5 |

Consequences:

- Remove old response aliases, dated tool variants, request workarounds, and model-ID cases that are not reachable
  from this support floor.
- When a model family is removed from `MODEL_CARDS` and the model-class policy, remove its provider branches and
  dedicated tests in the same change. Do not leave dormant compatibility indefinitely.
- Do not keep a guessed wire shape merely because an old synthetic unit test asserts it. A current captured fixture
  is the compatibility evidence.
- Keep the unknown-model fallback small and capability-safe. It exists for rapid adoption of future model IDs, not
  for emulating every legacy model.
- Do not apply this pruning rule to the separate OpenAI-compatible provider. Its purpose is explicitly to support
  third-party Chat Completions-compatible endpoints.
- Preserve normalized persisted Diligent messages across upgrades. The aggressive deletion target is obsolete raw
  provider-wire compatibility, not project-local conversation continuity.

The current catalog still makes several apparent compatibility branches live:

- budget-based Anthropic thinking is still required by Haiku 4.5;
- pre-GPT-5.6 prompt-cache and reasoning-effort handling is still required by the retained GPT-5.5 routes; and
- ChatGPT HTTP/SSE remains the default transport for the retained catalog.

Those branches should be deleted when their corresponding catalog families are dropped, not before.

As of this audit, GPT-5.4 and GPT-5.4 mini are retired from both the OpenAI API and ChatGPT subscription catalogs.
GPT-5.6 Terra inherits the `general` class, GPT-5.6 Luna inherits the `lite` class, and the generic `gpt-5` alias
resolves to GPT-5.6 Sol. Unknown explicit model IDs remain provider-inferred for rapid adoption, but that fallback is
not a promise of catalog support or model-specific compatibility.

## Priority Summary

| Priority | ID | Action | Main owner |
|---|---|---|---|
| P0 | A1 | Correct Anthropic thinking request policy | `anthropic/index.ts`, model capability metadata |
| P3 | A2 | Lock direct-only Anthropic web tools; do not add obsolete beta or unused dynamic-filtering support | `anthropic/web-tools.ts`, focused request tests |
| P0 | A3 | Treat OpenAI `response.incomplete` and stream `error` as explicit terminal outcomes | `openai/sse.ts` |
| P1 | A4 | Correlate OpenAI output-item IDs with function call IDs | `openai/sse.ts` |
| P1 | A5 | Preserve and replay OpenAI encrypted reasoning state | protocol thinking metadata, `openai/sse.ts`, `openai/responses.ts` |
| P1 | A6 | Handle Anthropic context-window and modern stop reasons deliberately | `anthropic/index.ts`, provider/agent boundary |
| P1 | A7 | Make Anthropic web-tool request fields faithful and typed | `anthropic/web-tools.ts` |
| P1 | C1 | Replace hand-written ChatGPT HTTP SSE framing | `chatgpt/http-sse.ts` or equivalent |
| P2 | C2 | Reduce speculative compaction recovery to observed formats | `openai/shared.ts`, compaction fixtures |
| P2 | C3 | Reduce speculative web payload shape search | `openai/web-content.ts`, captured fixtures |
| P2 | C4 | Remove semantic JSON Schema union flattening | `anthropic/web-tools.ts` |
| P3 | C5 | Decode each ChatGPT WebSocket message once | `chatgpt/index.ts`, `chatgpt/websocket-session.ts` |
| P2 | C6 | Delete compatibility branches unreachable from the supported model floor | provider-local request/response adapters |

## Required Additions and Corrections

### A1. Correct Anthropic Thinking Request Policy

**Why this is P0**: Diligent can construct requests that contradict current Anthropic request rules while its unit
tests currently assert those combinations as correct.

Current Diligent behavior in `packages/core/src/llm/provider/anthropic/index.ts:59-80`:

- `none` becomes adaptive thinking with `output_config.effort: "none"`, or budget-based thinking at the `low` budget.
- every adaptive `xhigh` becomes `max`;
- thinking requests always add `temperature: 1`; and
- omitting effort omits `thinking: { type: "disabled" }`, even for models that may default thinking on.

The compared Vercel implementation distinguishes the cases:

- `none` sends `thinking: { type: "disabled" }`;
- adaptive `xhigh` remains `xhigh` on Opus 4.7/4.8, Fable 5, and Sonnet 5, but maps to `max` on older adaptive
  models;
- sampling parameters are removed when thinking is enabled; and
- model capabilities separately track adaptive thinking, sampling-parameter rejection, and `xhigh` support.

Recommended Diligent policy:

| Input | Request behavior |
|---|---|
| `effort: "none"` | Send `thinking: { type: "disabled" }`; omit `output_config.effort` and thinking budget |
| adaptive + low/medium/high | Send adaptive thinking and the same effort; omit temperature |
| adaptive + xhigh | Preserve `xhigh` only on models that support it; otherwise map to `max` |
| adaptive + max | Send `max` |
| budget model + low/medium/high/xhigh/max | Send `thinking.enabled` with the model-card budget; omit temperature |
| no effort | Use an explicit product policy; do not accidentally inherit a new provider default |

The model card needs one additional intrinsic capability such as `supportsXhighEffort`. Do not infer this from
`supportsAdaptiveThinking`: Vercel's current capability table demonstrates that the two capabilities differ.

Tests to correct or add first:

- replace the current assertions that thinking sends `temperature: 1`;
- replace the blanket adaptive `xhigh -> max` assertion;
- add adaptive and budget-model `none` cases;
- cover a model that defaults thinking on when the caller selects `none`; and
- cover current Opus/Fable/Sonnet capability differences.

### A2. Make the Anthropic 2026 Web-Tool Caller Policy Explicit

The initial local-source comparison suggested copying Vercel's
`anthropic-beta: code-execution-web-tools-2026-02-09` header. The current official Anthropic documentation supersedes
that conclusion:

- the [tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference) classifies
  `web_search_20260209` and `web_fetch_20260209` as GA; and
- the [web search guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) shows current
  dated web-tool requests without an `anthropic-beta` header.

Therefore Diligent should **not** add the Vercel beta header. Vercel's current provider code appears to retain a
launch-period compatibility header that is no longer part of the documented request requirement. This is an example
of why Vercel is a useful implementation reference but not the source of truth for current API status.

There is a different decision to make. Diligent emits the 2026 tool type and always sets
`allowed_callers: ["direct"]`. Anthropic documents that:

- the 2026 versions add dynamic filtering through internal code execution;
- their default caller is code execution; and
- setting `allowed_callers: ["direct"]` explicitly disables dynamic filtering.

The current Diligent request is valid, but it selects the 2026 version while opting out of its primary new
capability. Under the supported-model-floor and aggressive-deletion policy, the recommended product decision is:

- retain the current 2026 tool type and direct-only caller;
- document that Diligent intentionally chooses ZDR-compatible, simple direct server-tool execution;
- assert that request shape in one focused test;
- do not add the obsolete beta header; and
- do not add dynamic-filtering code-execution result parsing or model capability branches until Diligent explicitly
  chooses that product feature.

This keeps one current tool version and one response shape. It also avoids retaining older basic tool versions or
copying Vercel's dynamic-filtering compatibility surface. `pause_turn` still needs deliberate generic server-tool
handling because a direct server-tool loop can pause independently of dynamic filtering.

### A3. Handle Every OpenAI Responses Terminal Shape

**Why this is P0**: `handleResponsesAPIEvents()` currently considers only `response.completed` successful termination.
It handles `response.failed`, but ignores `response.incomplete` and top-level `error` frames. An incomplete response is
therefore converted into the retryable network error `stream closed before response.completed`, even when the stream
ended normally because of `max_output_tokens` or a content filter.

Vercel treats both `response.completed` and `response.incomplete` as finished responses and reads
`response.incomplete_details.reason`. It also surfaces top-level `error` chunks directly.

Recommended decoder outcomes:

```text
response.completed  -> terminal success
response.incomplete -> terminal result with max_tokens/content-filter classification
response.failed     -> terminal provider error with upstream code/message
error               -> terminal provider error
EOF without any terminal frame -> retryable transport error
```

Specific changes:

- replace `sawCompleted` with a terminal-state discriminator;
- map `incomplete_details.reason === "max_output_tokens"` to Diligent `max_tokens`;
- decide how `content_filter` maps into the current protocol before coding; it must not be reported as a network
  failure;
- preserve usage from incomplete and failed responses when present; and
- keep EOF retryable only when no valid terminal frame was received.

Tests should use required wire fields and cover both the OpenAI SDK iterable and the shared ChatGPT raw-event path.

### A4. Correlate OpenAI Output Item IDs With Function Call IDs

**Why this matters**: OpenAI uses two IDs for a function call:

- `response.output_item.added.item.id` and delta `item_id` identify the output item;
- `call_id` identifies the function call and its later result.

Diligent keys the accumulator by `call_id` at start, then tries to append deltas using `item_id`. Because it never
records the mapping, the append misses its buffer and falls back to one global `currentToolId`. The final
`response.output_item.done` currently repairs the persisted call using authoritative arguments, but streamed argument
deltas can be lost or attributed to the wrong call.

Vercel tracks ongoing calls by `output_index`, which is present on both start and delta events. Diligent can either use
that strategy or maintain `item.id -> call_id`; it should not use one mutable current ID.

Required tests:

- include realistic `id`, `call_id`, `item_id`, and `output_index` values;
- interleave two function-call delta sequences;
- prove each delta and final input is attributed to the correct public call ID; and
- preserve the authoritative done-event fallback for missing deltas.

### A5. Preserve and Replay OpenAI Reasoning State

**Why this matters**: Diligent requests `reasoning.encrypted_content` in
`packages/core/src/llm/provider/openai/responses.ts:285-288`, but the event reducer keeps only plaintext summary text.
`convertMessages()` then drops all thinking blocks when constructing the next OpenAI request. The requested encrypted
payload is therefore unused.

Vercel preserves the reasoning item ID and encrypted content and replays either an item reference or a reasoning item
with `encrypted_content`. This enables multi-turn reasoning without depending on a server-side conversation object.
That model fits Diligent's project-local history better than adopting `previous_response_id`.

Recommended outcome:

1. Persist the OpenAI reasoning item ID and encrypted content alongside the normalized thinking block.
2. Keep the plaintext summary for rendering and debugging.
3. On the next same-provider request, replay the structured reasoning item before subsequent messages.
4. Drop provider-specific opaque state when switching providers, as Anthropic thinking replay already does for
   foreign signatures.
5. Redact opaque encrypted values from normal logs.

This requires a small protocol/persistence design because assistant messages are persisted and cross frontend
boundaries. Prefer a typed optional provider-state field over an unvalidated `Record<string, unknown>`. No frontend
visual change is required.

If this work is intentionally deferred, stop requesting `reasoning.encrypted_content` until there is a consumer. The
current halfway state adds payload and complexity without continuity.

### A6. Handle Modern Anthropic Stop Reasons Deliberately

Diligent maps only `end_turn`, `tool_use`, `max_tokens`, and `compaction`. Every unknown reason becomes `end_turn`.
The current Anthropic set also includes:

- `stop_sequence`;
- `pause_turn`;
- `refusal`; and
- `model_context_window_exceeded`.

Vercel distinguishes these as stop, content-filter, or length outcomes. Diligent has an additional requirement:
`model_context_window_exceeded` should enter the same context-overflow recovery path used for HTTP context errors,
not silently end the agent turn.

Recommended behavior:

- map `stop_sequence` to `end_turn`;
- convert `model_context_window_exceeded` into Diligent's structured context-overflow failure so agent compaction can
  run;
- define a non-network outcome for `refusal`; and
- document whether `pause_turn` is terminal or should trigger an automatic continuation for provider-executed tools.

Do not simply add all values to `StopReason`. The agent loop's required behavior should decide the mapping.

### A7. Make Anthropic Web Tool Fields Faithful and Typed

Current issues in `createAnthropicWebTool()`:

- `citationsEnabled` is accepted by Diligent's provider tool contract but never sent as `citations`;
- `user_location` is added to fetch as well as search, while the compared provider contract only sends it for search;
- `as unknown as Anthropic.Tool` hides incompatible or stale fields; and
- selection of a 2026 tool version is not tied to the intentional `allowed_callers`/dynamic-filtering policy.

Recommended correction:

- build distinct typed search and fetch objects;
- map `citationsEnabled` for fetch;
- restrict fields to the documented tool variant;
- apply the documented caller policy for the selected tool version; and
- retain the current Diligent product decision that `maxContentTokens` selects fetch, but document that policy because
  it is not implied by a generic `capability: "web"` name.

## Cleanup and Reduction

### C1. Replace Hand-Written SSE Framing

`packages/core/src/llm/provider/openai-compatible/json-sse.ts` is used only by the ChatGPT raw HTTP path. Normal
OpenAI and Anthropic requests already delegate transport framing to their official SDKs, and the generic
OpenAI-compatible provider does not call this file.

Some SSE processing is required for the ChatGPT endpoint, but the current 95-line implementation should not own SSE
framing. It manually handles UTF-8 buffering, CRLF, `data:` prefixes, EOF flush, cancellation, and `[DONE]`.

It is also incomplete as an SSE implementation: multiple `data:` fields belonging to one event must be joined with a
newline and dispatched at the blank line. Diligent instead tries to parse every `data:` line independently.

Vercel uses `eventsource-parser` through `EventSourceParserStream`, then performs only `[DONE]`, JSON parsing, and
schema validation. Diligent should follow the same layering without adopting an AI SDK provider:

```text
ReadableStream<Uint8Array>
  -> TextDecoderStream
  -> EventSourceParserStream
  -> thin ChatGPT JSON / [DONE] / diagnostics adapter
```

`eventsource-parser` is already present transitively in `bun.lock`; declare it as a direct `packages/core` dependency
before importing it. Move or rename the adapter under `chatgpt/` so its ownership matches its only consumer.

Expected reduction: approximately 60-80 source lines while improving protocol correctness.

### C2. Reduce Speculative Compaction Recovery

`packages/core/src/llm/provider/openai/shared.ts` accepts a large matrix of possible plaintext fields and ultimately
invents an XML-like `<user>` / `<assistant>` transcript when it cannot find a summary. The repository tests construct
these variants directly, but there are no captured upstream fixtures or documented payload provenance in the repo.

The structured shape with the strongest current contract is the encrypted compaction output item:

```json
{ "type": "compaction", "encrypted_content": "..." }
```

Recommended process:

1. Keep the current structured `compaction` item.
2. Perform one bounded check for existing redacted fixtures or currently captured endpoint payloads.
3. Delete every other format that lacks that evidence, including transcript synthesis and guessed top-level aliases.
4. Preserve concise unknown-shape diagnostics so a genuinely new current payload can be added with a fixture.

Lack of a historical fixture is not a reason to preserve a branch. The default is deletion. Do not replace one
speculative matrix with a generic recursive object walker. Unknown payloads should fail visibly and be added when
observed.

Expected reduction if only structured and one proven legacy format remain: approximately 80-130 source lines.

### C3. Reduce Speculative Web Payload Shape Search

`packages/core/src/llm/provider/openai/web-content.ts` searches many aliases and nesting layouts for the same source or
document:

- `action`, `item`, `output`, `result`, `page`, and `data` containers;
- `sources`, `results`, and `data` arrays; and
- `text`, `content`, `snippet`, `body`, `markdown`, and multiple casing variants.

The current tests prove that the generic walker behaves as written, but most payloads are synthetic rather than
redacted provider fixtures. Vercel's OpenAI decoder uses explicit discriminated shapes for search, open-page,
find-in-page, sources, and annotations.

Recommended process:

- retain explicit public OpenAI shapes;
- retain each ChatGPT-only shape backed by a captured payload fixture;
- delete every unproven alias or nesting path in the same change;
- log safe key/type summaries for unknown ChatGPT payloads; and
- add support only with a new fixture.

The completed-response fallback itself is useful and should remain. The cleanup target is the guessed alias matrix,
not recovery from a missing streaming detail event.

Expected reduction: approximately 60-120 source lines, depending on the number of observed ChatGPT variants.

### C4. Remove Semantic JSON Schema Union Flattening

`flattenTopLevelSchema()` rewrites root `anyOf`, `oneOf`, and `allOf` schemas into one merged object. This changes the
tool contract rather than adapting its syntax: mutually exclusive branches become a permissive bag of properties,
and required-property semantics are approximated.

The compared Vercel Anthropic provider passes ordinary function-tool `input_schema` through unchanged. If a specific
Anthropic model rejects a root union, Diligent should either:

- preserve a proven, semantics-preserving normalization for that exact restriction; or
- reject the schema with a clear provider compatibility error.

It should not silently send a different schema. Remove the flattener unless a captured API failure establishes a
requirement and a semantics-preserving transformation is available.

Expected reduction: approximately 35 source lines plus synthetic tests.

### C5. Decode ChatGPT WebSocket Messages Once

ChatGPT diagnostics currently decode string, `ArrayBuffer`, and typed-array payloads in `chatgpt/index.ts`, while
`ChatGPTWebSocketSession` decodes the same payload again for JSON parsing. Blob frames add a `pending_decode` log and a
second `decoded` callback.

Move decoding and byte-length calculation into the session boundary and pass the decoded text/payload plus byte
length to diagnostics. This removes duplicate `TextDecoder`/`TextEncoder` helpers and the two-stage Blob logging path.

This is a small cleanup. It should not disturb the WebSocket lifecycle, idle timeout, fallback policy, or scoped
session reuse.

### C6. Delete Unreachable Compatibility Branches With the Model That Needed Them

Apply the supported-model floor mechanically to provider-local types and branches. Immediate examples include:

- remove the unused OpenAI `web_search_preview` type alternative because `buildTools()` only emits `web_search` for
  every supported model;
- remove plaintext `summary`, `compaction_summary`, `compacted_summary`, and XML transcript fallbacks when no current
  compact-endpoint fixture demonstrates them;
- remove guessed OpenAI/ChatGPT web payload aliases that do not occur in a current fixture; and
- remove synthetic tests whose only purpose is to preserve one of those deleted branches.

For live branches, tie the reason to the model card in a focused capability function or test. When the last model
requiring a branch leaves the catalog, the branch and its tests leave in the same change. Avoid generic "legacy"
flags that outlive the model they were created for.

## Implementations to Retain

The following code may look substantial compared with an SDK wrapper, but it is justified by Diligent's direct
provider strategy.

### Retain official SDK transport plus Diligent event mapping

- OpenAI API uses `openai.responses.create()` for transport and SDK stream framing.
- Anthropic uses `client.messages.stream()` for transport and SDK event emission.
- Diligent still needs its own normalized content, error, usage, and persistence mapping.

`openai/sse.ts` is therefore not redundant SSE transport code. Its name is slightly misleading, but its primary role
is a Responses event reducer shared by the OpenAI SDK stream and ChatGPT raw events.

### Retain `OpenAIContentAccumulator`

It centralizes exactly-once text/thinking finalization, authoritative message replacement, tool-call buffering, usage,
and final assistant-message construction across OpenAI-shaped providers. Replacing it with provider-local mutable
arrays would reintroduce drift.

### Retain ChatGPT WebSocket session support

The WebSocket path is an explicit, environment-controlled capability with a completed design record in P074. It owns
connection reuse, single-flight exchanges, idle timeout, close diagnostics, abort, and HTTP fallback that the public
OpenAI SDK does not provide for the ChatGPT subscription endpoint.

Do not remove it solely because HTTP/SSE is the default. Reconsider only with production evidence that the feature
will not be enabled or maintained.

### Retain provider-native compaction transports

Diligent's local continuity and explicit compaction orchestration differ from Vercel's general server-side context
management surface. Direct compact endpoints and provider-specific beta headers are justified. The cleanup target is
speculative response recovery, not native compaction itself.

### Retain provider-native web content normalization

Diligent persists web calls, results, fetches, and citations as its own typed content blocks so Web, TUI, debug tools,
and future model turns see one contract. Keep that normalization. Reduce only unsupported guessed input shapes.

### Retain small provider-local differences

Do not create a universal provider base class for retry-after parsing, API-key lookup, base URL normalization, or
error construction. These helpers are small, and their provider policies already differ. Consolidate only truly
identical OpenAI-family behavior with shared tests.

## Recommended Execution Order

### Phase 1: Correct current wire behavior

1. A1 — Anthropic thinking policy and model capabilities.
2. A3 — OpenAI terminal event completeness.
3. A4 — OpenAI function-call delta correlation.
4. A7 — Anthropic web request fields.

These are provider-local changes. Tests should be written or corrected first.

### Phase 2: Restore provider state continuity

1. A5 — typed OpenAI reasoning state persistence and replay.
2. A6 — Anthropic stop-reason and context-overflow behavior.

A5 crosses protocol persistence and must follow the repository rule for shared Web/TUI protocol behavior, even though
the opaque state does not need a visible renderer.

### Phase 3: Remove unnecessary plumbing

1. A2 — lock the direct-only Anthropic web policy and reject obsolete beta/dynamic-filter compatibility.
2. C1 — standard SSE parser and ownership rename.
3. C4 — remove schema semantic rewriting.
4. C5 — single WebSocket decode boundary.
5. C2/C3/C6 — supported-model-floor deletion of speculative and unreachable compatibility.

C2 and C3 get one bounded evidence check, not an open-ended compatibility investigation. Delete every fallback that
has no current fixture or supported-model owner.

## Verification Plan

At minimum, the implementation phase should add the following deterministic tests before changing behavior:

| Area | Required test |
|---|---|
| Anthropic thinking | `none`, supported `xhigh`, fallback `xhigh`, no sampling fields during thinking |
| Anthropic web | no obsolete beta header, explicit caller policy, and per-variant request fields |
| OpenAI terminal events | completed, incomplete/max tokens, incomplete/content filter, failed, top-level error, raw EOF |
| OpenAI tool deltas | two interleaved calls with realistic item/call IDs and output indices |
| OpenAI reasoning | encrypted reasoning capture, persistence round trip, same-provider replay, foreign-provider omission |
| SSE framing | CRLF, chunked UTF-8, multi-line `data:`, comments, `[DONE]`, abort cancellation |
| Compaction/web fixtures | redacted real payload per supported shape; unknown shape produces diagnostics rather than guessed data |

Then run:

```text
bun test packages/core/test/llm
bun test packages/protocol/test
tsc --noEmit -p packages/core/tsconfig.json
tsc -p packages/core/tsconfig.test.json
bunx biome check packages/core/src/llm packages/core/test/llm packages/protocol
git diff --check
```

## Net Assessment

Diligent is not overbuilt because it implements providers directly. The justified complexity is in product-specific
state, normalization, retries, compaction, and the ChatGPT subscription transport. The avoidable complexity is lower
level or speculative:

- generic SSE framing implemented by hand;
- response-shape guessing without captured evidence;
- semantic schema rewriting;
- duplicate payload decoding; and
- requesting opaque provider state without preserving it.

The likely cleanup is approximately 250-400 source lines, but line count is not the goal. The goal is a smaller
provider boundary whose remaining branches each correspond to a documented wire contract, a captured upstream
fixture, or an explicit Diligent product policy.
