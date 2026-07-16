---
id: P077
status: backlog
created: 2026-07-15
---

# P077: Runtime-owned agent-loop hooks

## Goal

Remove runtime-owned plan-reminder behavior from `@diligent/core` and add a
small, synchronous in-process hook tier that runtime and bundled product
providers can compose into each Agent instance.

Reuse the existing runtime hook registration and bundled-provider assembly
path, but do not run the existing shell/plugin `PluginHookFn` contract inside
the high-frequency core agent loop.

The completed boundary should be:

```text
core
  owns: agent-loop lifecycle, hook contract, safe hook dispatch, context injection event
  knows nothing about: plan tool names, plan JSON, runtime sessions, clients, bundled providers

runtime
  owns: plan-reminder hook, per-Agent hook factories, internal-message persistence
  reuses: bundled-provider registration and app-server/child-agent assembly

clients
  receive: visible transcript only
  know nothing about: plan-reminder markers or internal context injections
```

## Prerequisites

- `Agent` remains the reusable stateful core runner.
- `RuntimeAgent` remains the runtime composition type and does not override the
  core loop.
- Existing lifecycle hooks remain available:
  - `UserPromptSubmit` before one outer runtime turn;
  - `Stop` after one successful outer runtime turn;
  - `EntryAppended` after durable session persistence.
- Existing deep import paths from `@diligent/core` remain source compatible
  through barrel exports or compatibility re-exports.
- Dependencies must be installed and the baseline core/runtime tests and
  typecheck must be green before behavioral edits begin.

## Confirmed decisions

1. **Two hook tiers:** keep coarse external lifecycle hooks and add a separate
   in-process agent-loop hook contract.
2. **Shared registration path:** bundled product providers register agent-loop
   hook factories through `BundledToolProvider`; no second product extension
   registry is introduced.
3. **Per-Agent instances:** providers return factories/results per Agent.
   Stateful hook instances are never shared across sessions or child agents.
4. **Core dependency direction:** core invokes only core-owned hook interfaces.
   Core never imports the runtime hook runner or bundled-provider types.
5. **Synchronous execution:** inner-loop hooks perform deterministic in-memory
   work only. The interface does not return promises.
6. **No shell/plugin inner-loop hooks:** filesystem JavaScript plugins and shell
   commands cannot register these hooks in this plan.
7. **Restricted mutation:** hooks cannot mutate Agent history directly. A
   `beforeTurn` hook may return structured user-context injections only.
8. **Internal persistence:** runtime persists injected context as internal
   message entries. Provider replay includes them; human transcripts exclude
   them.
9. **No protocol event:** the core context-injection event is consumed inside
   runtime and is not added to `AgentEventSchema` or broadcast to clients.
10. **Failure isolation:** a throwing in-process hook does not fail the user
    turn. Core logs a structured warning and disables that hook instance for
    the remaining Agent lifetime.
11. **Deterministic order:** built-in runtime hooks run first, followed by
    bundled-provider hooks in provider registration order and hook return order.
12. **Behavior preservation:** the built-in plan reminder remains enabled only
    where it is enabled today. Product factories receive Agent-kind context and
    explicitly choose whether to apply to main or child agents.

## Why existing hooks are insufficient

The current hook runner operates outside `Agent.prompt()`:

```text
UserPromptSubmit
  -> Agent.prompt()
       -> model sample
       -> tool execution
       -> model sample
       -> optional compaction
       -> model sample
  -> Stop
```

`UserPromptSubmit` can inject context once before the outer turn. `Stop` can
request a follow-up only after the entire loop finishes. `EntryAppended` can
observe persistence but cannot affect the loop.

Plan reminder needs to:

- observe each completed plan tool result;
- maintain cadence across multiple sampling rounds and prompts;
- inject context immediately before a later sampling round;
- know whether automatic compaction occurred in that round;
- rebuild state when an Agent resumes from provider history.

Calling the existing shell/plugin runner at those points would add process or
async plugin execution to every sampling round, invert the core -> runtime
dependency, and provide no safe per-Agent state ownership. This plan therefore
reuses registration and assembly, not the current `PluginHookFn` execution
contract.

## Artifact

### Generic runtime composition

```typescript
const appConfig = createAppServerConfig({
  cwd,
  runtimeConfig,
  bundledToolProviders: [
    {
      id: "studio",
      createTools: createStudioTools,
      onUserPromptSubmit: beginStudioTurn,
      onStop: saveStudioLevel,
      createAgentLoopHooks: (context) =>
        context.agentKind === "main"
          ? [createStudioContextHook(context)]
          : [],
    },
  ],
});
```

### Runtime plan reminder

```typescript
const hooks = [
  ...(runtimeConfig.planReminderIntervalTurns > 0
    ? [createPlanReminderHook({
        intervalTurns: runtimeConfig.planReminderIntervalTurns,
        logger,
      })]
    : []),
  ...createBundledAgentLoopHooks(bundledToolProviders, factoryContext),
];

return new RuntimeAgent(model, prompt, tools, {
  loopHooks: hooks,
  // existing options
});
```

### Inner-loop lifecycle

```text
Agent restore
  -> hook.restore()

Agent prompt
  -> hook.onPromptStart()

Agent loop iteration
  -> automatic compaction check
  -> steering drain
  -> hook.beforeTurn()
  -> append returned internal context
  -> provider sample
  -> tool execution
  -> hook.onToolResult() for each completed/synthesized result
  -> hook.afterTurn()
```

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| Core Agent API | Add synchronous `AgentLoopHook` and structured context-injection contracts |
| Core loop | Dispatch hook lifecycle points without knowing runtime policy names or payloads |
| Runtime hooks | Extend bundled-provider assembly with per-Agent loop-hook factories |
| Plan reminder | Move parsing, cadence, prompt text, and `plan` tool coupling from core to runtime |
| Session format | Mark injected message entries as internal and preserve their opaque source |
| Session context | Include internal messages in provider replay but exclude them from visible transcript and counts |
| App-server events | Consume core context-injection events server-side without protocol broadcast |
| Collaboration | Pass hook factories through child-agent assembly with explicit `agentKind` context |
| Web | Remove the plan-reminder marker heuristic after runtime transcript filtering owns visibility |
| Documentation | Document coarse external hooks versus trusted in-process loop hooks |

### What does NOT change

- No new protocol method, notification, schema member, or frontend feature.
- No shell `BeforeTurn`, `ToolResult`, or `AfterTurn` hook.
- No external plugin SDK support for agent-loop hooks.
- No async work, network access, approval, user input, or tool execution from an
  agent-loop hook.
- No general middleware pipeline around provider calls.
- No direct hook access to Agent internals, message mutation, steering queues,
  compaction implementation, or provider streams.
- No change to existing `UserPromptSubmit`, `Stop`, or `EntryAppended` behavior.
- No change to plan-reminder cadence, prompt wording, or config key.
- No change to ChatGPT WebSocket, provider retry, or provider compaction code.
- No removal of the `<system-reminder>` wrapper from model-facing plan-reminder
  text; only clients stop using the marker as a visibility contract.
- No `web_action` tool-definition cleanup or provider/UI error-presentation
  cleanup in this plan. Those remain follow-up boundary tasks.

## Proposed core contracts

Create a core-owned contract under `packages/core/src/agent/loop-hooks.ts`:

```typescript
export interface AgentContextInjection {
  /** Opaque diagnostic/persistence label. Core never branches on this value. */
  source: string;
  /** Only user content may be inserted between provider sampling rounds. */
  content: UserMessage["content"];
}

export interface AgentLoopHookRestoreContext {
  messages: readonly Message[];
}

export interface AgentLoopHookBeforeTurnContext {
  messages: readonly Message[];
  turnId: string;
  compactedThisTurn: boolean;
}

export interface AgentLoopHookPromptStartContext {
  messages: readonly Message[];
}

export interface AgentLoopHookToolResultContext {
  turnId: string;
  toolCall: ToolCallBlock;
  result: ToolResultMessage;
}

export interface AgentLoopHookAfterTurnContext {
  turnId: string;
  message: AssistantMessage;
  toolResults: readonly ToolResultMessage[];
}

export interface AgentLoopHook {
  /** Stable within one Agent for diagnostics and duplicate detection. */
  id: string;
  restore?(context: AgentLoopHookRestoreContext): void;
  onPromptStart?(context: AgentLoopHookPromptStartContext): void;
  beforeTurn?(
    context: AgentLoopHookBeforeTurnContext,
  ): readonly AgentContextInjection[] | void;
  onToolResult?(context: AgentLoopHookToolResultContext): void;
  afterTurn?(context: AgentLoopHookAfterTurnContext): void;
}
```

Contract rules:

- `messages` arrays are readonly snapshots. Hook implementations must not retain
  and mutate message objects.
- `source` must be a non-empty stable identifier such as `plan-reminder`.
- Core creates the injected `UserMessage` and timestamp; hooks cannot fabricate
  assistant or tool-result messages.
- Empty injection arrays are no-ops.
- Duplicate hook IDs are rejected when the Agent is constructed.
- Hook execution is sequential and deterministic.
- A hook that throws is logged with hook ID and phase, then disabled for the
  remaining lifetime of that Agent.
- Hook failures do not emit protocol-facing errors and do not abort the turn.

Add to `AgentOptions`:

```typescript
export interface AgentOptions {
  // existing fields
  loopHooks?: readonly AgentLoopHook[];
}
```

Add a core-only event:

```typescript
export type CoreAgentEvent =
  | ExistingCoreAgentEvents
  | {
      type: "context_injected";
      injections: Array<{
        source: string;
        message: UserMessage;
      }>;
    };
```

This event exists so core consumers can audit the conversation mutation and so
runtime can stage it durably. Runtime must exclude it from the protocol-facing
`AgentEvent` union.

## Proposed runtime factory contracts

Extend bundled providers with a runtime-owned factory contract:

```typescript
export interface AgentLoopHookFactoryContext {
  cwd: string;
  agentKind: "main" | "child";
  model: Model;
  tools: readonly Tool[];
  parentSessionId?: string;
  logger: Logger;
}

export type AgentLoopHookFactory = (
  context: AgentLoopHookFactoryContext,
) => readonly AgentLoopHook[];

export interface BundledToolProvider {
  // existing fields and coarse lifecycle hooks
  createAgentLoopHooks?: AgentLoopHookFactory;
}
```

Factory rules:

- Factories run once for each newly constructed Agent.
- Reusing a cached Agent does not recreate its hooks.
- A resumed session constructs new hooks, then `Agent.restore*()` rebuilds hook
  state from provider messages.
- Main and child agents receive distinct factory contexts and distinct hook
  instances.
- Provider factories decide whether to return hooks for child agents.
- Factory failures occur during Agent assembly and fail clearly; runtime does
  not silently construct an Agent with a partially collected hook set.
- Built-in runtime hooks are prepended before bundled-provider hooks.

## Internal session-message representation

Extend `SessionMessageEntry` without changing the core/protocol `Message` type:

```typescript
export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Message;
  visibility?: "internal";
  source?: string;
}
```

Semantics:

- Missing `visibility` means visible, preserving every existing session file.
- `visibility: "internal"` entries remain in the parent chain and provider
  replay context.
- Visible transcript builders, thread snapshots, and visible message counts
  skip internal entries.
- Compaction summary input remains the Agent's full provider conversation.
- Runtime persistence of `CompactionEntry.recentUserMessages` uses visible user
  history only, preventing an old internal reminder from becoming a visible
  retained user message after resume.
- `EntryAppended` observers continue receiving internal entries, now with an
  explicit source instead of an indistinguishable user message.
- Increment `SESSION_VERSION` from 9 to 10 for newly created sessions and
  retain backward reading support.

Legacy sessions may already contain untagged plan-reminder user messages. They
remain visible because missing `visibility` means visible. New writes must use
`visibility: "internal"`; marker parsing is not a storage contract.

## File Manifest

### packages/core/src/agent/

| File | Action | Description |
|------|--------|-------------|
| `loop-hooks.ts` | CREATE | Core synchronous hook contracts and safe deterministic dispatcher |
| `types.ts` | MODIFY | Add `AgentOptions.loopHooks` and `context_injected` core event |
| `agent.ts` | MODIFY | Own hook instances, validate IDs, restore hook state, and pass dispatcher to loop runtime |
| `loop.ts` | MODIFY | Invoke before-turn, tool-result, and after-turn phases at defined boundaries |
| `index.ts` | MODIFY | Export loop-hook public contracts |
| `util/plan-reminder.ts` | DELETE | Runtime-owned behavior leaves core |

### packages/core/src/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | MODIFY | Re-export stable loop-hook contracts from package root |

### packages/runtime/src/agent/

| File | Action | Description |
|------|--------|-------------|
| `plan-reminder-hook.ts` | CREATE | Runtime plan parsing, cadence state, prompt construction, and hook factory |

### packages/runtime/src/tools/

| File | Action | Description |
|------|--------|-------------|
| `bundled-provider.ts` | MODIFY | Add per-Agent loop-hook factory context and collection helpers |
| `index.ts` | MODIFY | Export bundled loop-hook factory types for product sidecars |

### packages/runtime/src/app-server/

| File | Action | Description |
|------|--------|-------------|
| `factory.ts` | MODIFY | Create built-in and bundled hooks per main Agent and remove `planReminderIntervalTurns` from core options |

### packages/runtime/src/collab/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | MODIFY | Carry loop-hook factories and Agent-kind context through child assembly |
| `registry.ts` | MODIFY | Create fresh child hook instances and preserve current built-in plan-reminder child behavior |

### packages/runtime/src/session/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | MODIFY | Add internal visibility/source fields and increment session version |
| `turn-stager.ts` | MODIFY | Persist `context_injected` messages as internal entries without treating them as steering |
| `context-builder.ts` | MODIFY | Separate provider context from visible transcript using explicit visibility metadata |
| `persistence.ts` | MODIFY | Exclude internal entries from visible message counts while preserving append observers |
| `turn-orchestrator.ts` | MODIFY | Stage internal events and suppress them from runtime/client event emission |

### packages/runtime/src/

| File | Action | Description |
|------|--------|-------------|
| `agent-event.ts` | MODIFY | Exclude `context_injected` from protocol-facing runtime AgentEvent |
| `index.ts` | MODIFY | Export trusted in-process factory types required by bundled product providers |

### packages/web/src/client/lib/

| File | Action | Description |
|------|--------|-------------|
| `thread-store.ts` | MODIFY | Remove client-owned plan-reminder marker filtering after runtime owns transcript visibility |

### tests and documentation

| File | Action | Description |
|------|--------|-------------|
| `packages/core/test/agent/loop-hooks.test.ts` | CREATE | Hook lifecycle, order, injection, restore, duplicate ID, and failure isolation |
| `packages/core/test/agent/loop-plan-reminder.test.ts` | DELETE / MOVE | Replace product-policy assertions with generic hook lifecycle tests |
| `packages/core/test/agent/util/plan-reminder.test.ts` | DELETE / MOVE | Move plan-specific cases to runtime |
| `packages/runtime/test/agent/plan-reminder-hook.test.ts` | CREATE | Plan parsing, cadence, compaction, restore, and generated injection tests |
| `packages/runtime/test/app-server/factory.test.ts` | MODIFY | Main Agent built-in/bundled hook assembly and stable cached-Agent behavior |
| `packages/runtime/test/collab/registry.test.ts` | MODIFY | Fresh child hook instances and Agent-kind filtering |
| `packages/runtime/test/session/context-builder.test.ts` | MODIFY | Internal provider replay and visible transcript exclusion |
| `packages/runtime/test/session/turn-stager.test.ts` | MODIFY | Context injection persists as internal rather than steering |
| `packages/runtime/test/session/manager.test.ts` | MODIFY | End-to-end persistence/resume behavior for injected context |
| `packages/runtime/test/session/persistence.test.ts` | MODIFY | Visible counts and version-9 resume append compatibility |
| `packages/runtime/test/session/types.test.ts` | MODIFY | Session version and optional internal metadata |
| `packages/web/test/client/lib/thread-store.test.ts` | MODIFY | Remove marker-owned behavior and retain ordinary steering assertions |
| `ARCHITECTURE.md` | MODIFY | Document core hook contract and runtime policy ownership boundary |
| `docs/guide/session-lifecycle.md` | MODIFY | Document coarse external hooks versus trusted in-process loop hooks |
| `docs/plan/decisions.md` | MODIFY | Record the two-tier hook decision after implementation |

## Implementation Tasks

### Task 0: Establish a green baseline

**Files:** no production changes

Install workspace dependencies using the repository lockfile, then run:

```bash
bun test packages/core/test
bun test packages/runtime/test
bun run typecheck
```

Do not attribute missing SDK/WASM/Zod modules to source regressions. Record any
real pre-existing failures before changing code.

### Task 1: Write core hook contract tests first

**Files:** `packages/core/test/agent/loop-hooks.test.ts`

Add failing tests that define the contract before implementation:

- restore executes once for each `restore()` or `restoreCompactionState()` call;
- `onPromptStart` executes once per `Agent.prompt()` before the first loop
  iteration and sees the newly appended outer user message;
- hooks execute in registration order;
- `beforeTurn` runs after compaction/steering and before provider sampling;
- returned injections are appended to provider history in returned order;
- injections emit one structured `context_injected` event;
- every real and synthesized tool result reaches `onToolResult` once;
- `afterTurn` runs once for each emitted core `turn_end`;
- state persists across two `Agent.prompt()` calls on one Agent;
- separate Agent instances do not share state;
- duplicate IDs fail at construction;
- a throwing hook is logged, disabled, and does not fail the turn;
- disabled hooks are not called again on later loop iterations or prompts.

The test hook should be generic and must not mention `plan`, runtime sessions, or
frontend markers.

**Verify:** `bun test packages/core/test/agent/loop-hooks.test.ts`

### Task 2: Implement the core in-process hook tier

**Files:** `packages/core/src/agent/loop-hooks.ts`,
`packages/core/src/agent/types.ts`, `packages/core/src/agent/agent.ts`,
`packages/core/src/agent/loop.ts`, `packages/core/src/agent/index.ts`,
`packages/core/src/index.ts`

Implement the proposed contracts and a small dispatcher that:

- validates stable unique IDs once;
- holds an internal disabled-ID set;
- catches and logs failures by `{ hookId, phase }`;
- returns validated injections from active hooks;
- never awaits hook work;
- exposes no mutable Agent internals.

Place calls at these exact points:

1. `Agent.restore*()` after copying restored messages;
2. `runAgentLoop()` once before entering the sampling loop, after the outer user
   message is present, for `onPromptStart`;
3. after automatic compaction and steering drain, immediately
   before provider sampling;
4. after each tool result is appended to the conversation;
5. after loop safety/reminder observers finish and immediately before
   `turn_end` emission.

Core creates timestamps for injected user messages, appends them to the working
conversation, and emits `context_injected`. It does not call the steering queue,
generate steering IDs, or inspect `source`.

**Verify:**

```bash
bun test packages/core/test/agent/loop-hooks.test.ts \
  packages/core/test/agent/agent.test.ts \
  packages/core/test/agent/loop.test.ts \
  packages/core/test/agent/loop-steering.test.ts
```

### Task 3: Move plan reminder into runtime

**Files:** `packages/runtime/src/agent/plan-reminder-hook.ts`,
`packages/runtime/test/agent/plan-reminder-hook.test.ts`,
`packages/core/src/agent/util/plan-reminder.ts`,
`packages/core/test/agent/loop-plan-reminder.test.ts`,
`packages/core/test/agent/util/plan-reminder.test.ts`

Move without changing behavior:

- `PLAN_TOOL_NAME` and plan-result parsing;
- plan step/status types;
- latest-goal extraction;
- unfinished-step filtering;
- reminder message construction;
- cadence and compaction-trigger state;
- structured plan-reminder logging.

Implement `createPlanReminderHook()` as an `AgentLoopHook` with ID
`plan-reminder`:

- `restore` scans restored provider messages for the latest valid plan result;
- `onPromptStart` captures the latest real user goal once for the whole prompt,
  before steering or internal injections can become the conversation tail;
- `beforeTurn` returns a `plan-reminder` context injection when the existing
  cadence/compaction rules require it;
- `onToolResult` updates plan state from successful `plan` results;
- `afterTurn` advances or resets cadence exactly as today.

Move all plan-specific tests to runtime. Delete the core-specific config/state
fields only after runtime parity tests pass.

**Verify:**

```bash
bun test packages/runtime/test/agent/plan-reminder-hook.test.ts
```

### Task 4: Reuse bundled-provider registration for hook factories

**Files:** `packages/runtime/src/tools/bundled-provider.ts`,
`packages/runtime/src/tools/index.ts`, `packages/runtime/src/index.ts`,
`packages/runtime/src/app-server/factory.ts`,
`packages/runtime/test/app-server/factory.test.ts`

Add `createAgentLoopHooks` and its factory context to
`BundledToolProvider`. Keep the current `collectBundledHooks()` result shape for
coarse hooks and add a separate helper for per-Agent hook construction; do not
mix instantiated loop hooks into the cached coarse hook arrays.

At main Agent construction:

1. create the built-in plan hook when configured;
2. construct bundled hooks in provider order;
3. pass the combined array through `AgentOptions.loopHooks`;
4. remove `planReminderIntervalTurns` from `AgentOptions`.

Tests must prove that hook factories run once per new Agent and not on cached
Agent reuse.

**Verify:** `bun test packages/runtime/test/app-server/factory.test.ts`

### Task 5: Thread factories through collaboration

**Files:** `packages/runtime/src/collab/types.ts`,
`packages/runtime/src/collab/registry.ts`,
`packages/runtime/test/collab/registry.test.ts`

Pass loop-hook factory capability through `CollabToolDeps` instead of passing
stateful hook instances. Child creation constructs fresh hooks with:

```typescript
{
  agentKind: "child",
  cwd,
  model: childModel,
  tools: filteredChildTools,
  parentSessionId,
  logger,
}
```

Preserve current built-in behavior: do not automatically add the built-in plan
reminder to child agents in this plan. Bundled providers may explicitly return
child hooks after inspecting `agentKind`.

Tests must prove:

- parent and child never share one hook object;
- two child agents receive separate hook objects;
- a main-only factory returns no child hooks;
- nested child creation decrements collaboration depth without losing factory
  capability.

**Verify:** `bun test packages/runtime/test/collab/registry.test.ts`

### Task 6: Persist internal context explicitly

**Files:** `packages/runtime/src/session/types.ts`,
`packages/runtime/src/session/turn-stager.ts`,
`packages/runtime/src/session/context-builder.ts`,
`packages/runtime/src/session/persistence.ts`,
`packages/runtime/src/session/turn-orchestrator.ts`,
`packages/runtime/src/agent-event.ts`

Write tests first, then:

- increment `SESSION_VERSION` to 10;
- stage `context_injected` messages with `visibility: "internal"` and source;
- include internal entries in `providerMessages` in path order;
- exclude internal entries from `messages`, transcript items, and visible counts;
- keep internal entries in the parent/leaf chain;
- prevent `context_injected` from reaching `ctx.emit()` and clients;
- preserve `EntryAppended` delivery with explicit metadata;
- keep compaction retained-user history visible-only;

Do not add `visibility` to the protocol `Message` schema. Visibility describes a
runtime session entry, not an LLM message or wire message.

**Verify:**

```bash
bun test packages/runtime/test/session/context-builder.test.ts \
  packages/runtime/test/session/turn-stager.test.ts \
  packages/runtime/test/session/manager.test.ts \
  packages/runtime/test/session/persistence.test.ts \
  packages/runtime/test/session/types.test.ts
```

### Task 7: Remove core and client policy knowledge

**Files:** `packages/core/src/agent/agent.ts`,
`packages/core/src/agent/loop.ts`, `packages/core/src/agent/types.ts`,
`packages/web/src/client/lib/thread-store.ts`,
`packages/web/test/client/lib/thread-store.test.ts`

After runtime persistence tests pass:

- delete core plan-reminder imports, fields, config, and state;
- remove the fake `steering_injected` emission for reminders;
- remove Web's `INJECTED_REMINDER_PREFIX` and marker filter;
- keep ordinary steering reducer behavior unchanged;
- verify no client contains `plan-reminder` or `<system-reminder>` knowledge.

Repository checks:

```bash
rg -n 'PLAN_TOOL_NAME|PlanReminder|planReminderIntervalTurns|INJECTED_REMINDER_PREFIX' packages/core packages/web
rg -n '<system-reminder>' packages/core packages/web packages/cli
```

Expected result: no runtime plan-policy implementation remains in core or
clients. The runtime plan-reminder hook may still contain the model-facing
marker and config name.

### Task 8: Document the durable boundary

**Files:** `ARCHITECTURE.md`, `docs/guide/session-lifecycle.md`,
`docs/plan/decisions.md`

Document:

- core loop hooks are synchronous trusted in-process extensions;
- runtime owns policy implementations and session visibility;
- bundled providers are the product registration path;
- shell/external hooks remain coarse-grained and may perform I/O;
- internal context is replayable but not user-visible;
- hook instances are Agent-scoped.

Record the durable decision as the next available D-series entry during
implementation. Do not leave this plan as the only source of truth after the
refactor lands.

### Task 9: Full verification

Run:

```bash
bun test packages/core/test
bun test packages/runtime/test
bun test packages/web/test
bun run typecheck
bun run lint
```

Also run targeted source-boundary checks:

```bash
rg -n 'from "@diligent/runtime|from ".*runtime' packages/core/src
rg -n 'plan-reminder|PLAN_TOOL_NAME|<system-reminder>' packages/core/src packages/web/src packages/cli/src
```

Manual verification:

1. Start a main thread with plan reminder enabled.
2. Make the model create a plan and perform enough tool rounds to trigger a
   reminder.
3. Confirm the provider receives the reminder and continues.
4. Confirm no Web or TUI user bubble appears for the reminder.
5. Inspect session JSONL and confirm an internal message entry with source
   `plan-reminder` exists.
6. Restart and resume the thread; confirm provider context includes the internal
   entry while `thread/read` remains clean.
7. Spawn two children with a test bundled hook and confirm state isolation.

## Acceptance Criteria

1. `packages/core` contains no `plan` tool name, plan-result parser,
   plan-reminder cadence, reminder text, or frontend marker knowledge.
2. Core exposes a small synchronous Agent-loop hook contract with no runtime
   imports.
3. Existing `UserPromptSubmit`, `Stop`, and `EntryAppended` behavior and public
   contracts remain unchanged.
4. Bundled providers can create per-Agent in-process hooks through their
   existing runtime registration path.
5. Hook instances are not shared across main, resumed, or child Agents.
6. Hook invocation order is deterministic and covered by tests.
7. A failing hook is logged and disabled without failing the user turn.
8. Hooks can inject user context before provider sampling but cannot mutate
   history or inject assistant/tool-result roles.
9. Plan-reminder behavior, cadence, compaction response, prompt wording, and
   config semantics remain unchanged for main Agents.
10. Reminder injections no longer use `steering_injected` and cannot consume or
    clear client steering queues.
11. Internal context is durably persisted, replayed to providers, excluded from
    visible transcripts/counts, and tagged with an opaque source.
12. Legacy untagged reminder entries remain visible; only explicit metadata
    controls visibility.
13. `context_injected` never crosses `AgentEventSchema` or requires a protocol
    version change.
14. Web and TUI contain no new plan-specific logic; Web's existing marker
    heuristic is removed.
15. Existing `@diligent/core` import paths remain valid.
16. Core, runtime, Web tests, typecheck, and lint pass.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Core unit | Hook validation, ordering, disable-on-error | Recording fake hooks and structured test logger |
| Core integration | Lifecycle placement and injection history | Fake provider stream with tool continuations and compaction |
| Runtime unit | Plan parsing and cadence | Moved plan-reminder cases with fake messages/results |
| Runtime assembly | Built-in and bundled factory composition | App-server factory tests and cached Agent reuse |
| Collaboration | Agent-scoped state | Two children and nested child factory contexts |
| Persistence | Internal entry round trip | Session writer/read/context builder tests |
| Compatibility | Existing session files | Version-9 fixtures with untagged reminder messages |
| Client regression | Steering remains correct | Existing Web/TUI steering tests; no reminder event delivered |
| Manual | Real long-running plan | Trigger reminder, inspect JSONL, restart, resume |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Hook callbacks become a general plugin API | Core loop gains uncontrolled complexity | Synchronous restricted contract; bundled providers only; explicit non-goals |
| Stateful hook instance is shared | Cross-session or parent/child contamination | Factories per Agent; identity tests for parent and children |
| Hook failure aborts agent work | Product extension can break every turn | Catch, structured warn, disable failed instance |
| Internal message reaches clients | Fake user bubble or steering queue corruption | Runtime-only event consumption; visibility metadata; thread snapshot tests |
| Internal message is dropped on resume | Model loses injected policy context | Provider-message replay includes internal entries; round-trip tests |
| Internal message leaks through compaction tail | Reminder appears as retained user text | Visible-only `recentUserMessages`; compaction/resume tests |
| New event widens runtime AgentEvent accidentally | Protocol safe-parse silently hides a typing bug | Explicit `Exclude<..., { type: "context_injected" }>` and compile-time test |
| Hook order changes behavior | Product policies produce inconsistent prompts | Built-in-first and provider-order contract with tests |
| Child behavior changes unexpectedly | Sub-agents receive plan reminders they did not receive before | Preserve main-only built-in hook; explicit `agentKind` filtering |
| Session count semantics change | Thread list counts include hidden messages | Define visible count and test persistence/listing paths |

## Rollout and migration

Implement in one branch but keep commits separable by dependency direction:

1. core contract and generic tests;
2. runtime plan hook and factory assembly;
3. internal persistence and resume compatibility;
4. removal of legacy core/client policy code;
5. documentation and full verification.

Do not temporarily expose context injections through protocol. During the
transition, keep old core reminder behavior disabled only after the runtime hook
and persistence path are verified in the same change set, preventing duplicate
reminders.

Session migration is read-compatible and append-only:

- version-9 files remain readable;
- newly created files use a version-10 header;
- when a version-9 session is resumed, the current runtime may append message
  entries with the new optional metadata while leaving the original header
  untouched; the current reader accepts both shapes;
- no existing JSONL file is rewritten in place;
- downgrading and reopening a session after newer entries were appended is not
  supported, consistent with the repository's current non-negotiated format
  policy;

## Deferred follow-ups

1. Replace the `web_action` name check in core with an explicit runtime-supplied
   model-tool definition.
2. Move CLI/Web-specific provider error guidance out of core and add runtime
   presentation mapping.
3. Consolidate duplicate `ToolRenderPayloadLike` and ChatGPT OAuth constants.
4. Remove unused core dependencies and stale package export/documentation
   entries.
5. Consider external plugin access to a safe subset of loop events only after
   at least two real third-party use cases exist; do not expose shell hooks at
   sampling frequency.
6. Consider explicit persisted hook state only if a runtime hook cannot rebuild
   from provider messages. This plan intentionally avoids a generic hook-state
   schema.

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D003 | Provider calls remain behind `StreamFunction` | Hooks inject context before sampling without wrapping providers |
| D006 | Session storage is append-only JSONL | Internal context is appended, never rewritten |
| D008 | Agent options are loop-control/integration inputs | `loopHooks` is an injected integration option, not product config |
| D009 | AbortSignal propagates through execution | Hooks do not replace or intercept cancellation |
| D013 | Core owns the minimal tool contract | Plan tool result observation uses existing core result types |
| D086 | Core/consumer event data is serializable | Context injection event contains only source and UserMessage |
| D098 | Runtime-mediated capabilities stay outside minimal core contracts | Existing external/bundled hook capabilities remain runtime-owned |
