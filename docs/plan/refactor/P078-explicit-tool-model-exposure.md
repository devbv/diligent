---
id: P078
status: implemented
created: 2026-07-16
---

# P078: Explicit tool-to-model exposure

## Goal

Remove the `web_action` name check from core and make the way a runtime Tool is
advertised to a model an explicit part of the Tool boundary.

The completed boundary should be:

```text
runtime or trusted bundled provider
  chooses: catalog/config name
  declares: optional provider-native model capability

core agent
  derives: ordinary function definitions when no special exposure is declared
  forwards: explicit provider-native definitions without inspecting tool names

provider adapter
  translates: semantic capability to provider-specific request fields
```

For example, a runtime tool may be named `browse`, `web`, or `web_action` while
declaring the same provider-native web capability. Conversely, a local function
named `web_action` remains a normal function unless it explicitly declares
provider-native exposure.

## Related plans

- P077 moves runtime policy out of the core agent loop. P078 applies the same
  boundary rule to tool advertisement, but has no implementation dependency on
  P077.
- P079 moves user-facing recovery guidance out of core errors. P078 does not
  change provider error handling or client presentation.

## Current problem

`packages/core/src/agent/assistant.ts` currently contains this implicit rule:

```typescript
if (tool.name === "web_action") {
  return {
    kind: "provider_builtin",
    capability: "web",
    options: { citationsEnabled: true },
  };
}
```

Runtime registers `web_action` as a normal Tool with a placeholder `execute()`
implementation. Core then recognizes the string and changes how the Tool is
sent to the model.

This creates four problems:

1. renaming the runtime tool silently changes its execution model;
2. an unrelated local or plugin tool named `web_action` is misclassified;
3. core knows a runtime-owned product name;
4. runtime already records the same fact in `TOOL_CAPABILITIES`, but that fact
   is not carried across the Tool boundary.

Provider adapters already consume a semantic definition:

```typescript
{
  kind: "provider_builtin",
  capability: "web",
  options: { citationsEnabled: true },
}
```

The missing boundary is between runtime Tool registration and core model
context construction.

## Proposed contract

Add an optional provider-native exposure declaration to the core Tool contract:

```typescript
export interface Tool<TParams extends z.ZodType = any> {
  name: string;
  description: string;
  parameters: TParams;
  inputSchema?: Record<string, unknown>;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
  supportParallel?: boolean;
  parseArgs?: (raw: unknown) => z.infer<TParams>;

  /**
   * Overrides the default function-tool advertisement with a provider-native
   * semantic capability. The catalog name remains independent.
   */
  modelExposure?: ProviderBuiltinToolDefinition;
}
```

`modelExposure` is intentionally narrower than the full `ToolDefinition`
union. Ordinary function definitions continue to be derived from `name`,
`description`, and `inputSchema`/`parameters`. This prevents an explicit
function definition from advertising a different name than the executor
registry can dispatch.

Core model-context conversion becomes:

```typescript
function toToolDefinition(tool: Tool): ToolDefinition {
  return tool.modelExposure ?? toFunctionToolDefinition(tool);
}
```

Runtime declares the web capability at its source:

```typescript
export function createWebTool(): Tool<typeof WebParams> {
  return {
    name: "web_action",
    description: "Use the active provider's native web capability.",
    parameters: WebParams,
    modelExposure: {
      kind: "provider_builtin",
      capability: "web",
      options: { citationsEnabled: true },
    },
    execute: async () => ({
      output: "Provider-native web tools are not executed locally.",
    }),
  };
}
```

The placeholder executor remains in P078 to preserve the existing generic
`Tool<TParams>` shape and avoid making every executor call site handle an
optional function. Core must never dispatch it because provider-native results
arrive as provider content blocks rather than local `tool_call` blocks. A later
Tool type split may remove the placeholder after the source-compatibility cost
is assessed.

## Planning decisions

1. **Names are catalog identifiers:** `Tool.name` remains the identifier used by
   config, filtering, conflict resolution, rendering, and local execution.
2. **Exposure is semantic:** provider-native behavior is selected only by
   `modelExposure`, never by a tool-name comparison.
3. **Default remains a function:** a Tool without `modelExposure` is advertised
   as the existing function definition.
4. **Provider adapters remain authoritative:** OpenAI, Anthropic, Gemini, and
   future adapters translate `capability: "web"` into their wire formats.
5. **Trusted in-process scope:** runtime built-ins and `BundledToolProvider`
   tools may use the core field. External plugin SDK v1 does not expose it.
6. **No execution aliasing:** P078 does not allow an advertised function name to
   differ from `Tool.name`.
7. **No provider names in runtime tools:** runtime declares `web`, not
   `web_search`, `googleSearch`, or dated Anthropic tool names.
8. **One source of truth:** runtime tool metadata no longer separately declares
   `executionMode: "provider_builtin"` and `providerCapability: "web"` after
   all consumers use the Tool declaration.
9. **Unknown capabilities fail explicitly:** a provider adapter must either
   support a declared capability or return a classified unsupported-capability
   error. It must not silently reinterpret it as a function.
10. **Compatibility first:** existing core Tool imports and generic
    `Tool<TParams>` usage remain source compatible.

## Scope

### What changes

| Area | Change |
|------|--------|
| Core Tool API | Add optional `modelExposure` for provider-native definitions |
| Agent context | Remove the `web_action` name branch and honor the explicit declaration |
| Runtime web tool | Declare `capability: "web"` at registration |
| Runtime metadata | Remove duplicated provider-execution metadata once unused |
| Bundled providers | Permit trusted in-process tools to use the core declaration |
| Tests | Prove names and execution modes are independent |
| Documentation | Document catalog identity versus model exposure |

### What does not change

- No rename of the user-visible/config key `web_action` in this plan.
- No provider wire-format rewrite.
- No new provider-native capability beyond `web`.
- No change to provider-native web result blocks or citations.
- No change to mode filtering, tool toggles, conflict resolution, or rendering.
- No plugin SDK v1 access to provider-native capabilities.
- No optional `execute()` and no broad Tool union refactor.
- No hidden tools, function aliases, per-turn exposure callbacks, or dynamic
  schema mutation.
- No P079 error-presentation work.

## Boundary and trust model

### Runtime built-ins

Runtime owns the product decision that a catalog entry activates native web.
It creates the Tool and sets `modelExposure` directly.

### Bundled tool providers

Bundled providers are trusted in-process product extensions and already return
core `Tool[]`. They may declare provider-native exposure. Their declarations
receive the same type checks and provider capability validation as runtime
built-ins.

### External plugins

Plugin SDK v1 continues to describe locally executable function tools only.
The plugin loader must not copy an unknown `modelExposure` property from a
duck-typed plugin export into the host Tool. This prevents an unversioned plugin
API expansion and keeps provider-billed/server-executed capabilities behind a
trusted boundary.

If third-party provider-native exposure becomes a real requirement, add it in a
separate plugin API version with explicit validation, capability discovery, and
user consent semantics.

## Provider behavior

The existing semantic-to-wire mapping remains:

| Core capability | Provider request representation |
|-----------------|---------------------------------|
| `web` | OpenAI Responses `web_search` |
| `web` | Anthropic dated `web_search` or `web_fetch` tool |
| `web` | Gemini `googleSearch` and `urlContext` |

Provider code should continue branching on `ToolDefinition.kind` and
`capability`, because that is a core LLM abstraction rather than a runtime
product name.

For providers that do not support `web`, define and test one explicit behavior.
The preferred behavior is a non-retryable classified error before the request
is sent. Silent omission makes the enabled catalog state disagree with the
model's actual capabilities.

## Implementation plan

### Task 0: Establish a green baseline

- Install dependencies if needed.
- Run focused core agent/provider tests and runtime tool/catalog tests.
- Record any pre-existing failures before changing behavior.

### Task 1: Write boundary tests first

Add core tests proving:

1. an ordinary tool named `web_action` becomes a function definition;
2. a provider-native web tool with a different catalog name becomes a
   `provider_builtin` definition;
3. a Tool without `modelExposure` retains its current schema derivation;
4. `inputSchema` still takes precedence over Zod-derived schema for functions;
5. provider-native exposure never reaches the local executor path.

Add runtime tests proving:

1. `createWebTool()` declares web exposure;
2. tool toggles and catalog state still use `web_action` as the external name;
3. plugin tools cannot smuggle an undeclared provider-native exposure through
   the plugin wrapper;
4. bundled in-process providers can declare the field.

### Task 2: Add the core Tool field

- Add `modelExposure?: ProviderBuiltinToolDefinition` to
  `packages/core/src/tool/types.ts`.
- Export any new alias through existing core barrels without removing deep
  imports.
- Keep the field serializable and data-only.
- Do not add provider-specific unions to the Tool package.

### Task 3: Replace name-based conversion

- Update `packages/core/src/agent/assistant.ts` to prefer explicit exposure.
- Delete every `tool.name === "web_action"` branch from core.
- Keep function conversion unchanged for all other tools.
- Add a narrow invariant/assertion around provider-native declarations if
  malformed values can enter through JavaScript consumers.

### Task 4: Move the declaration to runtime

- Add the web exposure declaration in `packages/runtime/src/tools/web.ts`.
- Preserve the current `web_action` catalog/config name and description unless
  a separate product rename is approved.
- Keep the placeholder executor clearly marked as unreachable and covered by a
  non-dispatch test.

### Task 5: Remove duplicated runtime metadata

- Verify all reads of `ToolCapabilities.executionMode` and
  `providerCapability`.
- Remove those fields and the `web_action` values from
  `tool-metadata.ts` when the Tool declaration is the sole consumer-facing
  source.
- Do not move unrelated mode, immutability, or render metadata into Tool.

### Task 6: Enforce plugin and bundled-provider boundaries

- Keep `@diligent/plugin-sdk` Tool unchanged for API v1.
- Ensure `wrapPluginTool` builds an allowlisted host Tool and drops unknown
  provider-native declarations.
- Add a bundled-provider assembly test using a provider-native Tool with a
  non-reserved name.
- Document that trusted bundled providers compile against the core Tool API,
  while external packages use the narrower plugin SDK.

### Task 7: Verify provider compatibility

- Run OpenAI, Anthropic, Gemini, Vertex, ZAI, and ChatGPT provider tool-building
  tests.
- Verify unsupported providers fail explicitly or retain their documented
  existing behavior.
- Run core, runtime, protocol, Web, CLI, and e2e tests affected by tool schemas
  and provider-native blocks.
- Run typecheck and lint.

## Expected file changes

| Package | Likely files |
|---------|--------------|
| core | `src/tool/types.ts`, tool barrels, `src/agent/assistant.ts` |
| core tests | `test/agent/provider-builtin-tools.test.ts`, `test/agent/agent.test.ts` |
| runtime | `src/tools/web.ts`, `src/tools/tool-metadata.ts`, `src/tools/plugin-loader.ts` |
| runtime tests | tool catalog, plugin loader, default tools, bundled provider tests |
| docs | architecture/tool extension guidance and this plan |

Provider adapter source files should need no semantic change. Changes there
should be limited to explicit unsupported-capability validation or tests.

## Acceptance criteria

1. Core contains no `web_action` string or equivalent reserved-name check.
2. A local function named `web_action` is advertised and executed as a normal
   function.
3. A provider-native web entry works with an arbitrary catalog name.
4. Runtime owns the decision to expose native web.
5. Provider adapters receive the same `provider_builtin/web` definition as
   before.
6. Existing web search/fetch result blocks and citations are unchanged.
7. Tool settings and config remain keyed by `web_action` until a separate
   rename.
8. External plugin SDK v1 cannot activate provider-native capabilities.
9. Bundled in-process providers can declare supported provider-native
   exposure.
10. No existing core Tool import path breaks.
11. Focused and full tests, typecheck, and lint pass.

## Testing strategy

| Category | What to test |
|----------|--------------|
| Core conversion | Explicit exposure wins; absent exposure derives function |
| Name independence | Reserved-looking local name and arbitrary native name |
| Executor safety | Provider-native declaration never enters local dispatch |
| Runtime catalog | Config/filter/render identity remains the catalog name |
| Plugin trust | Extra native-exposure property is not promoted by v1 loader |
| Bundled provider | Trusted provider can return native exposure |
| Provider adapters | Semantic web definition maps to existing wire formats |
| Protocol/e2e | Provider-native result blocks remain unchanged |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Full `ToolDefinition` is exposed | Function name can diverge from executor name | Type field as `ProviderBuiltinToolDefinition` only |
| Placeholder executor is called | User sees an internal boundary failure | Non-dispatch invariant and tests |
| Plugin extras pass through | Unversioned privilege/cost expansion | Allowlisted wrapper and negative test |
| Runtime metadata remains duplicated | Sources can disagree | Remove provider execution fields after migration |
| Unsupported provider silently drops web | Catalog lies about availability | Explicit capability validation/error |
| Deep-import consumers break | Downstream packages fail typecheck | Additive field and preserved exports |

## Rollout

Keep implementation commits separable:

1. failing boundary tests;
2. additive core Tool contract and generic conversion;
3. runtime web declaration and metadata cleanup;
4. plugin/bundled boundary tests;
5. provider regression verification and docs.

The runtime declaration and removal of the core name special case must ship in
the same change set. Shipping only one side would either expose `web_action` as
a local function or disable native web.

## Deferred follow-ups

1. Split executable function Tools and provider-native capability entries into
   a discriminated union so native entries need no placeholder `execute()`.
2. Add plugin API support only after defining versioning, consent, billing, and
   provider capability discovery.
3. Generalize `ProviderBuiltinToolDefinition.capability` when a second real
   capability exists; do not pre-populate speculative values.
4. Consider catalog availability that reflects the selected provider's
   supported capabilities.
5. Rename the external `web_action` catalog/config key only as a separate
   migration with config compatibility.

## Decisions referenced

| ID | Summary | Where used |
|----|---------|------------|
| D003 | Provider calls remain behind `StreamFunction` | Provider adapters translate semantic exposure |
| D013 | Tools are interfaces with schema and an execute function | Exposure is additive; executable shape is preserved |
| D098 | Plugin SDK and core Tool capabilities intentionally differ | Plugin SDK v1 remains local-function-only |
