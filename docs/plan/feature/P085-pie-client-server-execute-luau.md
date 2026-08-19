# PIE Client/Server `execute_luau` Compatibility Implementation Plan

**Status:** Proposed. Research and Roblox black-box validation are complete; no implementation is included in this plan.

**Goal:** Add one `studiorpc_execute_luau` tool that executes a caller-provided Luau source string in the Lua VM of the running PIE Client or Server DataModel, waits for the root chunk to finish (including yields), and returns the first result or a tool error with Roblox-compatible behavior.

**Scope decision:** This plan intentionally supports only `Client` and `Server`. `Edit`/Studio execution is out of scope.

**Estimated effort:** 12-17 engineer-days for the complete contract in this plan, including automated tests and crash hardening. The critical path is the scriptless Lua-thread lifecycle and asynchronous completion path, not the sidecar schema.

## 1. Product Decision

The feature is conditionally feasible and should be implemented as a first-class PIE runtime execution path, not by redirecting the edit-time procedural runner and not by borrowing an arbitrary script asset as execution context.

The public tool contract is:

```typescript
name: "studiorpc_execute_luau"

parameters: z.object({
  code: z.string(),
  datamodel_type: z.enum(["Client", "Server"]),
}).strict()
```

The internal Studio JSON-RPC method is `execute.luau` with the same two parameters. The Studio endpoint already selects the active Studio process, so the OVERDARE tool does not add Roblox's `studio_id` argument. It also does not add `clientId`: `Client` means the targeted/main PIE client, matching the client selected by existing play-test tools.

The successful JSON-RPC `result` is a string. The sidecar must pass that string through without parsing or pretty-printing it.

## 2. Evidence in the Current Code

The implementation can reuse existing ownership and routing boundaries:

- `Sandbox/Source/Sandbox/Private/MCP/PIESessionRegistry.cpp:135-179` enumerates live `EWorldType::PIE` world contexts and records client worlds.
- `Sandbox/Source/Sandbox/Private/MCP/PIESessionRegistry.cpp:299-360` resolves the targeted/main in-process client and asserts game-thread access.
- `Sandbox/Source/Sandbox/Private/MCP/PIESessionRegistry.cpp:363-382` already collects every PIE world, including the authority/server world.
- `Sandbox/Config/DefaultEditorPerProjectUserSettings.ini:153-155` configures `MPIE_Client`, which creates distinct Client and Server PIE worlds in the supported single-process setup.
- `unreal-engine/Engine/Plugins/LuaMachine/Source/LuaMachine/Public/LuaMachine.h:46-50` owns Lua states by `UGameInstance`.
- `unreal-engine/Engine/Plugins/LuaMachine/Source/LuaMachine/Private/LuaMachine.cpp:142-178` resolves or creates the `ULuaState` for a world's GameInstance.
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaGameInstanceSubsystem.cpp:551-557` resolves the world's `ULuaAPIState` through `FLuaMachineModule`.
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIStatics.cpp:204-302` already compiles source with `luau_compile` and loads bytecode into a runtime state.
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIState.cpp:1605-1682` creates a child Lua thread, installs a chunk environment, calls `luau_load`, and resumes it without requiring a code asset.
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIState.cpp:1685-1789` owns resume, yield, terminal cleanup, and termination notification.
- `Sandbox/Source/Sandbox/Private/MCP/MCPCommandHandler.h:12-26` and `MCPCommandDispatcher.cpp` support handlers that keep the socket open and respond asynchronously.
- `Sandbox/Source/Sandbox/Private/MCP/PIEInputSimulator.cpp:932-965` and its completion path provide an existing request/socket/cancellation pattern for asynchronous PIE RPC.
- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts:237-310` turns a method module into a `studiorpc_*` tool and preserves a string result.
- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts:83-183` owns the socket timeout and JSON-RPC error conversion.

The unsafe gaps that require new runtime work are equally concrete:

- `unreal-engine/Engine/Plugins/LuaMachine/Source/LuaMachine/Private/LuaState.cpp:1194-1238` asserts that a child created from the main state has a valid `ScriptObject`.
- A scriptless child spawned from another scriptless child also reaches the invalid-script assertion, so `task.spawn`, `task.delay`, and coroutine creation require explicit remote-context inheritance.
- `unreal-engine/Engine/Plugins/LuaMachine/Source/LuaMachine/Private/LuaState.cpp:1629-1661` blocks execution when `ScriptObject` is invalid.
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIStatics.cpp:317-342` assumes the debug watchdog can cast the current script object to `ALuaLuaSourceContainer`; a scriptless command can hard-crash here.
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIState.cpp:1734-1747` currently reads the last stack result and logs runtime errors instead of exposing the first result/error to the RPC caller.
- The existing termination delegate contains only `FLuaValue`; it does not expose status, error text, return count, or the live stack before cleanup.
- The sidecar's default timeout is 10 seconds, while Roblox was observed to complete a yielding command after more than 11 seconds.

## 3. Roblox Compatibility Baseline

The following behavior was observed directly against the available Roblox Studio MCP on 2026-08-18. These observations are acceptance fixtures, not guesses based on documentation.

### 3.1 Public surface

Roblox exposes:

```typescript
execute_luau({
  code: string,
  datamodel_type: "Edit" | "Client" | "Server",
  studio_id: string,
})
```

This OVERDARE plan deliberately removes only:

- `Edit`, because the requested scope is PIE Client/Server only.
- `studio_id`, because a StudioRPC socket is already bound to one active Studio instance.

The spelling and casing of `code`, `datamodel_type`, `Client`, and `Server` remain identical.

### 3.2 Target and state behavior

- `Client` and `Server` are available only while Play is running.
- Calling a missing target is a tool error, for example `Client datamodel is not available in Edit mode`.
- Client and Server have distinct persistent global state. A value written to `_G` in Client was not visible in Server and vice versa.
- Repeated calls to the same target share its existing VM globals.
- The command environment has `script == nil`, `shared` available, and a fresh environment whose fallback reaches the VM's shared/global table. `getfenv(0) == _G` was false.
- A plain global assignment writes into that one command's fresh environment and is not visible to the next command. Explicit `_G` and `shared` writes are visible to later calls in the same target VM.
- Stopping and restarting Play clears command globals and `shared` state because the old DataModel/VM is gone.
- `typeof(loadstring)` reported `function`, but invoking it failed with `loadstring() is not available`. The tool itself loads source through its privileged host path; it does not imply that nested dynamic loading is enabled inside the command.

### 3.3 Completion behavior

- Only the first returned value is reported. `return "first", 2, true` returns `first`.
- `return nil`, an omitted return, and `return nil, "second"` all return the text `nil`.
- A yielding root chunk is awaited. `task.wait(0.05)` resumed and returned normally.
- A yielding root chunk that later errors returns a tool error.
- `task.wait(11)` completed after approximately 11.2 seconds, so a 10-second wall timeout is not compatible.
- Detached work survives the root response. A `task.delay` callback changed `_G` after the tool had returned.
- Signal callbacks also survive the root response. In Client PIE, an `execute_luau` call that only registered `RunService.Heartbeat:Connect(...)` returned immediately; 0.5 seconds later its callback had run 257 times. This remained true without saving the returned `RBXScriptConnection` in a global.
- Persistent callback registration is not limited to Signals. A Client command registered `ContextActionService:BindAction`, returned, and a later command still found the action bound until it explicitly called `UnbindAction`.
- An error in a detached `task.spawn` did not fail a root chunk that later returned `root-ok`. Only the root chunk's terminal result controls the RPC response; descendant errors after detachment go to runtime diagnostics.
- Side effects are not transactional. A global written immediately before `error(...)` remained written.
- Concurrent calls were globally FIFO-serialized, including one Client call followed concurrently by a Server call. The second call did not run during the first call's yield.

### 3.4 Success rendering

Top-level successful values were rendered as text:

| Luau result | Tool text |
|---|---|
| `nil` or no result | `nil` |
| `true` / `false` | `true` / `false` |
| number | decimal text |
| string | raw string without JSON quotes |
| `workspace` | `Workspace` |
| `Vector3.new(1, 2, 3)` | `1, 2, 3` |
| function | `function: 0x...` |
| coroutine thread | `nil` |
| enum item | qualified enum text |
| `CFrame` | compact JSON object with `Position` and `Rotation` strings |
| table | compact JSON text |

Observed table projection rules that must be frozen as tests:

- `{}` renders as `[]`.
- A string-key dictionary renders as a JSON object; nil-valued fields are omitted.
- Contiguous positive integer keys render as stringified numeric object keys (`"1"`, `"2"`, ...), not as a JSON array.
- If key `1` exists, the table is treated as a sequence projection: only the contiguous `1..n` prefix is retained and mixed string/boolean keys are ignored.
- A sparse `{[1] = "one", [3] = "three"}` retained only key `1`.
- Numeric keys are stringified when the table is in dictionary mode; `{[0] = "zero", alpha = "a"}` retained both `"0"` and `"alpha"`.
- Boolean table keys are rejected as a tool error (`Invalid table key type used`).
- Nested functions and Instances are stringified, nested coroutine threads are omitted, and nested `Vector3`, `Color3`, enum, and `CFrame` values use the same projections as top-level values.
- Top-level `NaN`, positive infinity, and negative infinity render as `nan`, `inf`, and `-inf`. Inside a table they render as tagged objects such as `{"m":null,"t":"numeric","v":"nan"}`.
- Cyclic tables are rejected as a tool error (`tables cannot be cyclic`).
- JSON object key order is not stable and must not be asserted as raw string order.

### 3.5 Errors

- Parse failure is a tool error. Roblox's public message is generic (`Failed to parse command code`) rather than a success value.
- Runtime `error` and `assert` failures are tool errors and contain `AssistantCommand:1: <message>`.
- Internal Roblox package paths are not a compatibility requirement. OVERDARE should expose the useful source/line/message without imitating private Roblox stack prefixes.

## 4. OVERDARE Contract

### 4.1 Tool description

The description must state all of the following:

- The tool runs only in a currently running Play session.
- `datamodel_type` selects Client or Server.
- Client means the same targeted/main client used by existing PIE tools.
- Only the first return value is reported; nil/no return becomes `nil`.
- Yielding code is awaited, but detached tasks may continue after the response.
- Runtime mutations are immediate, survive errors, and are not covered by Studio map rollback.
- Commands are globally FIFO-serialized.
- Unbounded loops and destructive game/service calls remain the caller's responsibility and require normal execute approval.

### 4.2 Target resolution

Add `EPieLuaDataModelType { Client, Server }` and `FPieLuaTarget` to the PIE registry boundary.

`ResolveLuaTarget` must:

1. Assert `IsInGameThread()` before touching Engine, world, GameInstance, or Lua state.
2. Require an active, non-stopping, single-process PIE session.
3. For `Client`, select the same lowest-PIE-instance targeted client as existing no-`clientId` tools, then use its `UWorld`.
4. For `Server`, enumerate current PIE world contexts and select the unique authority world (`NM_DedicatedServer` first, otherwise `NM_ListenServer`).
5. Reject `NM_Standalone` as a substitute for two distinct DataModels. Client and Server must never silently target the same GameInstance/VM.
6. Capture the current PIE session id/generation with the queued request and revalidate it immediately before execution so a queued command cannot cross into a newly started session.
7. Resolve `ULuaGameInstanceSubsystem` and its `ULuaAPIState` from the selected world only after target validation.

Stable target errors:

| Name | JSON-RPC code | Meaning |
|---|---:|---|
| `pieNotRunning` | `-32150` | No active Play session |
| `datamodelUnavailable` | `-32151` | Requested Client/Server world is absent in the current mode |
| `unsupportedPieMode` | `-32152` | Multi-process or non-distinct Client/Server setup |
| `luaVmUnavailable` | `-32153` | World exists but its GameInstance/Lua API state is not ready |
| `stalePieSession` | `-32154` | Request was queued for a prior PIE generation |

### 4.3 Scriptless remote Lua context

Introduce a first-class execution owner instead of weakening all `ScriptObject` checks or adding remote-only branches at every call site:

```cpp
enum class ELuaStateOwnerKind : uint8
{
    Script,
    Module,
    RemoteCommand,
};

struct FLuaExecutionOwnerHandle
{
    ELuaStateOwnerKind Kind;
    TWeakObjectPtr<UObject> ScriptObject;          // Script/Module only
    TSharedPtr<FRemoteRuntimeContext> Remote;      // RemoteCommand only

    bool IsAlive() const;
};
```

The exact pointer form may follow engine conventions, but every live Lua state and every native subsystem that stores a callback or asynchronous continuation must carry this owner handle. The Lua state context also stores a source label (`AssistantCommand`) for diagnostics. Required invariants:

- Only `RemoteCommand` may be rooted at the main VM with `ScriptObject == nullptr`.
- A child created by `task.spawn`, `task.delay`, `task.defer`, or coroutine APIs inherits `RemoteCommand` and the source label from its parent.
- Ordinary Script and Module paths retain their current validity checks unchanged.
- Existing script-facing helpers remain as compatibility wrappers, while new internals use `GetCurrentLuaExecutionOwner()` and `IsExecutionOwnerAlive()` rather than treating a null `ScriptObject` as dead.
- `ShouldBlockLuaStateExecution` accepts a valid remote-command context even though its script object is nil.
- The chunk environment writes `script = nil`, `_G` points at the VM global table, and the metatable `__index` remains the VM shared table.
- The debug watchdog formats timeout diagnostics from the stored source label when no script object exists; it must not cast or dereference a null script object.
- Stopping PIE invalidates all remote handles without touching a freed world, GameInstance, `ULuaAPIState`, or socket.

Do not create a transient `ALuaLuaSourceContainer`. It would make `script` non-nil, leak a fake script into the running world, and retain the exact watchdog/lifetime coupling this feature needs to remove.

### 4.4 Runtime execution API

Add a non-Blueprint remote execution API owned by `ULuaAPIState`:

```cpp
enum class ELuaRemoteCompletion : uint8
{
    Success,
    CompileError,
    LoadError,
    RuntimeError,
    Cancelled,
    TimedOut,
    SerializationError,
};

struct FLuaRemoteResult
{
    ELuaRemoteCompletion Completion;
    FString Output;
    FString Error;
    int32 Line = INDEX_NONE;
};

struct FLuaRemoteExecutionHandle
{
    FGuid RequestGuid;
    FLuaStateHandle LuaStateHandle;
};
```

The exact names may follow local C++ conventions, but the ownership must remain:

- `ULuaAPIState::StartRemoteString(...)` compiles, creates the remote child thread, installs the environment, registers terminal observation, and performs the first resume on the game thread.
- Compile/load failures complete immediately without creating or retaining a pending socket request.
- `LUA_YIELD` keeps the remote request pending while existing task/timer/service schedulers resume the same handle.
- On terminal resume, inspect status and stack before `CheckLuaStateRefCountAndRemoveRecursive`.
- On success, serialize stack index `1` when at least one result exists. Never use `-1`; Roblox reports the first value, while the current implementation reads the last.
- On failure, capture the live error string and line before cleanup instead of relying on log scraping.
- Remove the per-request terminal callback exactly once on success, failure, cancellation, PIE teardown, or VM teardown.
- Normal success/runtime-error completion releases only the root observer; already spawned descendants are not rolled back. Explicit cancellation/timeout before a response invalidates that invocation's runtime context and clears all continuations it still owns.

Do not widen the existing public `OnLuaStateTerminated` delegate as the primary implementation. It lacks status and stack information and has unrelated callers. A remote-only pending map/callback inside `ULuaAPIState` keeps the new contract local.

### 4.4.1 Post-return remote lifetime: separate invocation from runtime ownership

Roblox compatibility requires two distinct lifetimes. Do not let the socket/request lifetime define the lifetime of code registered by that request.

| Lifetime | Starts | Ends | Owns |
|---|---|---|---|
| `FRemoteInvocation` | a queued StudioRPC request reaches the FIFO head | root chunk succeeds, errors, cancels, times out, or PIE ends | socket response, deadline, root completion observer |
| `FRemoteRuntimeContext` | the root child is created | its last state/task/callback/connection reference is released, or it is invalidated by cancellation/VM teardown | source label, `RemoteCommand` owner identity, callbacks and descendants |

Required behavior:

1. The root command may return and complete its RPC response while `FRemoteRuntimeContext` remains alive.
2. `task.spawn`, `task.delay`, `task.defer`, and coroutine children inherit this runtime context. Existing child-to-parent `RefCount` behavior keeps a parent thread alive only as long as a child needs it; it must not be changed into "cancel on root response".
3. Signal callbacks are a separate persistence path: a `Connect` call stores a Lua function closure in the signal connection, then every future `Fire` creates a fresh callback child. The connection must carry the execution owner, because it has no `ScriptObject` and can outlive the root thread.
4. `FLuaScriptSignalImpl::Fire` currently removes a connection when `FromScript` is invalid (`LuaScriptSignal.cpp:83-89`). Replace that single-object validity rule with an owner validity predicate: a Script owner is valid while its `UObject` is valid; a RemoteCommand owner is valid while its `FRemoteRuntimeContext` and target `ULuaAPIState` are alive.
5. `LuaStateValueCall` needs an owner-aware overload so a stored remote callback creates a `RemoteCommand` child from `MainLuaState`, rather than hitting the current main-state `ScriptObject` assertion.
6. `Signal:Wait` also needs the owner-aware path. It currently returns without yielding when `GetCurrentLuaStateScript()` is invalid (`LuaScriptSignal.cpp:214-218`), so changing only `Connect` is insufficient.
7. Remote connections need a context-owned connection-id collection analogous to `ALuaBaseScript::OwnedConnections`. On context invalidation or VM/PIE teardown, disconnect them before discarding remote contexts. Ordinary `connection:Disconnect()` removes only that connection.
8. A remote context is reference-counted by its live root/child states and native callback registrations. A command that simply returns must release its context immediately; it must not leak one context per invocation until PIE stops.
9. Root completion removes only the `FRemoteInvocation` and opens the next FIFO item. It must not disconnect remote connections, clear a still-referenced runtime context, or cancel descendants.
10. A 60-second request deadline applies only until the root invocation completes. It does not retroactively kill a delayed task or event callback that was successfully registered before the response.
11. If the root is cancelled or times out before producing a response, invalidate that invocation's runtime context and release its pending descendants/registrations. Runtime mutations already performed remain non-transactional.
12. Errors from descendants do not complete or alter an already completed invocation. Report them through normal runtime console diagnostics using `AssistantCommand`; never attempt a second socket response.
13. Avoid an ownership cycle: Lua states and stored callback records hold a strong remote-context reference; the context stores only weak disconnect/unregister locators. `ULuaAPIState` keeps a weak enumerable registry so PIE teardown can pin and invalidate live contexts without keeping completed contexts alive.
14. The FIFO serializes root command invocations only. Detached tasks and callbacks from older commands remain ordinary scheduler work and may run while a later root command is active.

This is deliberately unlike a temporary Script actor. A fake script would couple persistent callbacks to an asset/actor lifetime that Roblox does not create for `execute_luau`.

### 4.4.2 Module and native asynchronous continuation audit

Full in-VM execution means the remote command must be able to use every OVERDARE API that an ordinary script can use in the selected DataModel, subject to that API's existing Client/Server and game-setting restrictions. The owner conversion therefore extends beyond the core scheduler:

1. `require(ModuleScript)` currently asserts that `GetCurrentLuaStateScriptObject()` is a valid `ALuaLuaSourceContainer` (`LuaAPIState.cpp:183-185`), then uses it for cycle detection, initial-caller bookkeeping, and waiting chains. Make the require chain state/owner-based so a RemoteCommand can require and await a module without fabricating a Script actor. Preserve the existing module cache and recursive/depth errors.
2. `HttpService` async methods capture a weak ScriptObject and refuse to resume when it is invalid (`LuaHttpService.cpp:688-695`, `753-759`, `826-832`). Gate on the execution owner plus the existing `FLuaStateHandle` instead.
3. DataStore async operations and `UpdateAsync` transform callbacks capture ScriptObject in the same way (`LuaDataStore.cpp:174`, `LuaGlobalDataStore.cpp:998`, `1137`, `1246`, `1382`, `1471`). Store/validate the execution owner and resume the existing state handle.
4. `ContextActionService:BindAction` stores `FLuaConnectionInfo::FromScript` and later calls through it (`LuaContextActionService.cpp:469-471`, `234`). Store the execution owner so bound callbacks survive the root response, matching the observed Roblox fixture.
5. `MarketplaceService.ProcessReceipt` stores the assigning script and later creates a callback thread (`LuaMarketplaceService.cpp:194`, `262`). It needs the same owner-aware callback path.
6. Audit every `GetCurrentLuaStateScriptObject`, `GetLuaStateScriptObject`, `FromScript`, and `LuaStateValueCall` call site. Classify each as actual Script semantics or merely execution ownership/liveness. Only the latter may accept RemoteCommand; actual Script-only semantics must return a deliberate Lua error, not assert.

This audit is a release gate. Supporting `return 1`, `task.wait`, and Signal connections while silently dropping HTTP/DataStore completions or crashing on `require` is not full-spec execution.

Tool parity does not replace OVERDARE's Luau API surface with Roblox's. For example, Roblox's command host exposed a `loadstring` symbol whose invocation was denied; OVERDARE keeps its existing VM library/service policy. The compatibility contract here covers target selection, environment isolation, execution lifetime, scheduling, return rendering, and errors for APIs that OVERDARE actually exposes.

### 4.5 Result serializer

Create a remote-only serializer that reads the live Lua stack before cleanup. It must not route through generic `FLuaValue` JSON conversion when doing so would lose table shape or unsupported-value behavior.

Required rules:

1. No result and nil both produce `nil`.
2. Boolean, number (including `nan`, `inf`, and `-inf`), and string produce unquoted text.
3. The first result only is observed.
4. Tables use the compatibility projection in section 3.4 and then compact JSON serialization.
5. Instance/object and value userdata use their Luau-visible string representation. OVERDARE equivalents of `Vector3`, `Color3`, enum values, and Instance names need explicit fixtures.
6. `CFrame` uses a stable object projection with position/rotation strings if current userdata conversion supports the analogous shape.
7. Thread values produce `nil`.
8. Function/userdata pointer strings are diagnostic only; tests match type/prefix and never a concrete address. Nested thread values are omitted.
9. Numeric dictionary keys are stringified. Boolean keys return `SerializationError`. If key `1` exists, use only the contiguous sequence prefix and ignore mixed keys, matching section 3.4.
10. Non-finite numbers inside tables use Roblox's tagged numeric object (`m:null`, `t:"numeric"`, `v:"nan"|"inf"|"-inf"`).
11. Cyclic tables, excessive depth, excessive node count, or output over the byte limit return `SerializationError`, never recurse indefinitely or crash.

Safety limits are explicit OVERDARE extensions because Roblox does not publish them:

- Source: at most 48 KiB UTF-8, keeping the current 64 KiB JSON-RPC frame limit intact.
- Table depth: 32.
- Visited table nodes: 10,000.
- Output: 1 MiB after UTF-8 encoding.
- Active/queued request wall deadline: 60 seconds from Studio receipt.
- Sidecar socket timeout for this method: 65 seconds.
- Existing 10-second continuous CPU/debug-step watchdog remains in force per resume segment. Yield time does not count as continuous CPU time.

If product parity later requires larger source, raise the transport frame limit as a separate MCP-wide change; do not silently make `execute.luau` the only method that can bypass framing policy.

### 4.6 Async RPC and global FIFO queue

The handler must use `bAsync = true`. Blocking the game thread until a yielding chunk completes is forbidden because the same game thread must tick the scheduler that resumes it.

Add a game-thread-owned execution service with one global FIFO queue across Client and Server. This matches the observed Roblox ordering and avoids concurrent mutation of either VM through this tool.

Each queued request owns only safe lifetime handles:

- request id and connection id;
- weak cleanup token and thread-safe cancellation token;
- socket pointer used only while the cleanup token is valid and cancellation is false;
- requested DataModel, source string, captured PIE session generation, and absolute deadline;
- weak `ULuaAPIState` plus `FLuaRemoteExecutionHandle` after start.

Lifecycle rules:

1. Validate schema and source byte size synchronously in `ExecuteAsync`; send a JSON-RPC error and complete cleanup on failure.
2. Enqueue and start the head only on the game thread.
3. Re-resolve the target and session generation when the item reaches the head.
4. Keep the socket open across yields.
5. On completion, send exactly one success or error response, mark cleanup, remove the active item, and start the next item.
6. On connection close, cancellation token, timeout, VM teardown, or `PrePIEEnded`, cancel/discard the active root, fail all affected queued items where a socket is still writable, and release every callback/handle.
7. Never call Engine or Lua APIs from a socket/worker thread. If a future transport callback can arrive off-thread, marshal it with `AsyncTask(ENamedThreads::GameThread, ...)` before touching the queue.
8. Add `check(IsInGameThread())` to queue entry points that touch PIE or Lua state.

Execution errors:

| Name | JSON-RPC code | Public message behavior |
|---|---:|---|
| `luaCompileError` | `-32160` | `Failed to parse command code`, with detail/line in error data |
| `luaLoadError` | `-32161` | Load failure with `AssistantCommand` source |
| `luaRuntimeError` | `-32162` | `AssistantCommand:<line>: <message>` |
| `luaExecutionCancelled` | `-32163` | Request connection/caller was cancelled |
| `luaExecutionTimedOut` | `-32164` | 60-second wall deadline exceeded |
| `luaResultSerializationError` | `-32165` | Result cannot be represented within limits |
| `luaExecutionQueueFull` | `-32166` | More than 16 outstanding commands |

Errors are JSON-RPC errors so the final MCP tool result is marked `isError: true`. Do not return `{ ok: false }` as a successful tool result.

### 4.7 Security and observability

- Keep normal StudioRPC `execute` approval and show `datamodel_type`, source byte length, and source preview in approval details.
- Do not classify this as a map mutation: it receives no map snapshot, save, or write lock. Runtime effects are intentionally ephemeral but can still call powerful game services.
- Do not log the entire source or include it in generic `Request was:` error text. Log method, DataModel, byte length, request id, duration, completion class, and a source hash.
- Never include bearer tokens, service responses, or arbitrary returned userdata memory in telemetry.
- Add counters for success, compile error, runtime error, timeout, cancellation, target unavailable, and serialization failure. Do not record code or result bodies.

## 5. File Changes

### Studio/engine repository (`C:\Users\devbv\git\sandbox`)

Create:

- `Sandbox/Source/Sandbox/Private/MCP/MCPCommandHandler_PIELua.h`
- `Sandbox/Source/Sandbox/Private/MCP/MCPCommandHandler_PIELua.cpp`
- `Sandbox/Source/Sandbox/Private/MCP/PIELuaExecutionService.h`
- `Sandbox/Source/Sandbox/Private/MCP/PIELuaExecutionService.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/Tests/LuaRemoteExecutionTests.cpp`

Modify:

- `Sandbox/Source/Sandbox/Private/MCP/PIESessionRegistry.h`
- `Sandbox/Source/Sandbox/Private/MCP/PIESessionRegistry.cpp`
- `Sandbox/Source/Sandbox/Private/MCP/MCPService.cpp`
- `unreal-engine/Engine/Plugins/LuaMachine/Source/LuaMachine/Public/LuaState.h`
- `unreal-engine/Engine/Plugins/LuaMachine/Source/LuaMachine/Private/LuaState.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Public/LuaAPIState.h`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIState.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Public/LuaAPIStatics.h` only if shared result/delegate types belong there
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/LuaAPIStatics.cpp` for compilation reuse and scriptless watchdog diagnostics
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Public/DataTypes/LuaScriptSignal.h`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/DataTypes/LuaScriptSignal.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/Classes/Services/LuaContextActionService.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/Classes/Services/LuaHttpService.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/Classes/DataStore/LuaDataStore.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/Classes/DataStore/LuaGlobalDataStore.cpp`
- `Sandbox/Plugins/migaloo-script/Source/LuaAPI/Private/Classes/Services/LuaMarketplaceService.cpp`
- Corresponding public headers when stored callback/async state types must carry `FLuaExecutionOwnerHandle`
- `Sandbox/Source/Sandbox/Private/MCP/MCPCommandHandler_PIEInput.cpp` only if `game.pie.status` exposes available Luau DataModels/capability

No dependency change is expected in `Sandbox/Source/Sandbox/Sandbox.Build.cs`; it already depends on `LuaMachine` and `LuaAPI`. Verify this during implementation rather than editing it preemptively.

### Sidecar repository (`C:\Users\devbv\git\diligent`)

Create:

- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/methods/execute.luau.ts`
- `apps/overdare-ai-agent/sidecar/test/tools/studiorpc/methods/execute.luau.test.ts`

Modify:

- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tool-registry.ts`
- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts` for abort propagation and source redaction
- `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts` only as needed to pass `toolCtx.signal` to this RPC call without changing output rendering
- `apps/overdare-ai-agent/sidecar/test/tools/studiorpc.test.ts` for provider/tool assembly
- `apps/overdare-ai-agent/sidecar/test/tools/studiorpc-rpc.test.ts` or the current RPC transport test file for timeout, abort, and redaction coverage

## 6. Implementation Tasks

### Task 1: Freeze the public compatibility contract

- [ ] Add the strict sidecar schema and description for `execute.luau`.
- [ ] Register it so the generated name is exactly `studiorpc_execute_luau`.
- [ ] Set the method timeout to 65 seconds.
- [ ] Add unit tests for exact argument names/casing, rejection of `Edit`, rejection of unknown keys, raw string result pass-through, and JSON-RPC error propagation.
- [ ] Assert that the tool does not acquire the map write lock, capture a rollback snapshot, or call `level.save.file`.

**Gate:** The tool contract exists in tests, but an unavailable engine method still fails cleanly. Do not ship at this intermediate point.

### Task 2: Add deterministic Client/Server target resolution

- [ ] Add `EPieLuaDataModelType`, `FPieLuaTarget`, and `ResolveLuaTarget` to `PIESessionRegistry`.
- [ ] Reuse the existing targeted client selection for Client.
- [ ] Resolve the unique authority world for Server without requiring a viewport or local player.
- [ ] Require distinct GameInstances and supported single-process PIE mode.
- [ ] Capture and revalidate PIE session generation.
- [ ] Add status capability output only if it can be done without changing existing client-selection semantics.

**Tests:** no PIE, starting/stopping PIE, Client, Server, multiple clients (targeted lowest PIE instance), stale generation, authority absent, multi-process rejected, and accidental Client/Server same-VM rejection.

### Task 3: Introduce explicit scriptless remote Lua contexts

- [ ] Add the owner kind and source label to `FLuaStateContext`.
- [ ] Add `FLuaExecutionOwnerHandle` and central owner validity/callback-state creation helpers; do not scatter `RemoteCommand` null exceptions.
- [ ] Add a narrow root creation path for `RemoteCommand`; preserve all Script/Module assertions.
- [ ] Inherit the owner kind through task/coroutine child creation.
- [ ] Update execution blocking, script lookup, interruption, cleanup, and debugger/watchdog call sites that currently assume `ScriptObject` is always valid.
- [ ] Ensure `script` is nil and the environment/global lookup matches the observed contract.
- [ ] Introduce `FRemoteRuntimeContext` independently of the pending socket request, and carry it through task/coroutine child creation.
- [ ] Make `FLuaScriptSignal` connection ownership owner-kind-aware; allow a live RemoteCommand callback with no `ScriptObject`, and create future callback children with that remote context.
- [ ] Make `Signal:Wait` accept a live RemoteCommand owner and remove/cancel its waiter safely.
- [ ] Disconnect context-owned registrations on explicit connection/unbind, cancellation before response, or target VM/PIE teardown; never merely because a normally completed root command returned.
- [ ] Reference-count remote contexts and reclaim them as soon as no root/child/callback/connection owns them.
- [ ] Make `require(ModuleScript)` owner/state-based for RemoteCommand while preserving module caching, yield, and cycle detection.
- [ ] Migrate ContextAction, HTTP, DataStore, DataStore transform, and Marketplace deferred paths from ScriptObject liveness to execution-owner liveness.
- [ ] Audit all remaining ScriptObject reads and make Script-only APIs fail with Lua errors instead of assertions.

**Crash regression:** Execute a CPU-heavy but bounded command in a PIE world containing no Lua script assets. The watchdog/debug-step path must neither assert nor cast a null object.

### Task 4: Add remote execution completion and serialization

- [ ] Add `StartRemoteString`, terminal pending-map ownership, and `CancelRemoteExecution` to `ULuaAPIState`.
- [ ] Reuse BOM stripping and `luau_compile` options without routing through a script asset.
- [ ] Capture compile/load/runtime status and error text before cleanup.
- [ ] Read only stack result index `1`.
- [ ] Implement the bounded compatibility serializer.
- [ ] Complete exactly once across synchronous success, yield/resume, runtime error, cancellation, and teardown.

**Tests:** primitives, raw/empty/escaped strings, nil/no return, multiple returns, dictionary/sequence/sparse/mixed tables, invalid boolean keys, nested values, non-finite numeric tags, Instance/value types, function/thread, cycle, depth/node/output limits, compile error, immediate runtime error, post-yield runtime error, and cancellation.

### Task 5: Add asynchronous handler and global FIFO queue

- [ ] Register `execute.luau` as an async MCP handler.
- [ ] Implement the 16-entry global FIFO across Client and Server.
- [ ] Start and complete all Lua operations on the game thread.
- [ ] Keep the connection open across yield and send exactly one response.
- [ ] Wire connection cancellation, MCP service stop, PIE pre-end/world cleanup, VM invalidation, and the 60-second deadline.
- [ ] Redact source from engine logs and error envelopes.
- [ ] Treat root completion as queue completion only; persistent remote callbacks/tasks must not retain the FIFO slot or socket.

**Tests:** immediate success, 11-second yielding success, same-target FIFO, cross-target FIFO, queued target becoming stale, socket disconnect during yield, timeout, PIE stop during yield, and service shutdown with queued work.

### Task 6: Finish sidecar cancellation and error presentation

- [ ] Extend `StudioRpcCallOptions` with an optional `AbortSignal` or add an equivalent request-local path.
- [ ] Destroy the socket promptly on caller abort so Studio's cancellation token is set.
- [ ] Preserve the raw successful string.
- [ ] Preserve tool-error status for every engine JSON-RPC error.
- [ ] Remove source text from debug logging and the generic `Request was:` suffix for `execute.luau`; retain a hash/length.
- [ ] Verify the 65-second sidecar timeout is longer than Studio's 60-second deadline.

### Task 7: Run end-to-end compatibility validation

- [ ] Start one-player single-process `MPIE_Client` through `studiorpc_game_play`.
- [ ] Confirm both DataModels are available and backed by distinct GameInstances/`ULuaAPIState` objects.
- [ ] Run the section 3 fixture corpus against OVERDARE Client and Server.
- [ ] Compare semantic output with the recorded Roblox results; parse table JSON before comparing because key order is unstable.
- [ ] Confirm `_G` persistence within each target and isolation across targets.
- [ ] Confirm `task.wait`, post-yield error, detached `task.delay`, and non-rollback side effects.
- [ ] Confirm an unretained `RunService.Heartbeat:Connect` callback continues to run after the root response, then stops when PIE stops.
- [ ] Stop PIE during a pending yield and confirm no crash, leaked socket, callback, timer, or Lua handle.
- [ ] Repeat start/execute/stop at least 20 times to exercise stale-world and teardown races.

### Task 8: Documentation and release gate

- [ ] Document the public tool and the intentional differences from Roblox (`Edit`, `studio_id`, safety limits, cleaner error prefix).
- [ ] Document that runtime mutations are outside map rollback.
- [ ] Add the capability to any tool catalog/bootstrap guidance that lists play-test tools.
- [ ] Keep source/result bodies out of analytics.
- [ ] Ship only after engine automation tests, sidecar tests/typecheck/lint, and the manual PIE teardown stress pass all succeed.

## 7. Verification Matrix

| Area | Required verification |
|---|---|
| Schema | Exact `code` + `datamodel_type`; Client/Server only; strict object |
| Routing | Client targets main client VM; Server targets authority VM; distinct GI/VM |
| Threading | Every Engine/Lua touch asserts game thread |
| Immediate return | nil, bool, number, string, first-of-many |
| Structured return | dictionary, contiguous numeric keys, sparse, mixed, nested, empty |
| Runtime values | Instance, Vector3-equivalent, Color3-equivalent, CFrame-equivalent, enum, function, thread |
| Errors | compile, load, runtime, post-yield runtime, serialization |
| Async | yield under and over 10 seconds, detached task, FIFO ordering |
| Deferred APIs | `Signal:Wait`, persistent Signal, ContextAction callback, ModuleScript require/cache, one HTTP/DataStore-style state-handle resume fixture |
| Lifecycle | abort, socket close, timeout, PIE stop, VM teardown, service shutdown |
| State | same-target globals persist; Client/Server globals remain isolated |
| Safety | source/output/depth/node/queue limits; no source telemetry |
| Regression | normal Script/Module execution, task scheduling, debugger, watchdog, and PIE input remain unchanged |

## 8. Effort Breakdown

| Workstream | Estimate |
|---|---:|
| Target resolver and async MCP queue | 2-3 days |
| Execution-owner model and task/coroutine/Signal lifecycle | 4-6 days |
| Module require and native deferred-API owner migration | 3-4 days |
| Terminal result/error capture, cancellation, and teardown | 2-3 days |
| Roblox-compatible bounded serializer | 2-3 days |
| Sidecar schema, timeout, abort, redaction, and tests | 1-2 days |
| PIE integration, stress, and regression verification | 3-4 days |
| **Total** | **17-25 days** |

The earlier 12-17 day estimate covered the root executor, scheduler, Signal persistence, serializer, and transport. The wider 17-25 day estimate is the honest full-spec number after identifying `require`, `Signal:Wait`, ContextAction, HTTP, DataStore, and Marketplace paths that use ScriptObject as a continuation owner. It assumes an engineer already familiar with LuaMachine/LuaAPI. If automated latent PIE test infrastructure must be created from scratch, add 2-3 days; do not replace those tests with only manual verification.

## 9. Risks and Mitigations

### Highest engineering risk: hidden `ScriptObject` lifetime assumptions

The Lua runtime and multiple service continuations currently treat a valid script object as their execution-owner invariant. Fixing only the initial `checkf` would create a path that appears to work for simple `return 1` but can hard-crash, never resume, or silently discard work on `require`, `Signal:Wait`, HTTP/DataStore completion, a stored callback, watchdog execution, or PIE teardown.

Mitigation: introduce one explicit execution-owner handle, audit every script-object read and stored callback, and require zero-script-world, module/deferred-API fixtures, and repeated PIE-stop crash tests before shipping.

Other material risks:

- Arbitrary Server code can invoke powerful runtime services. Mitigate with existing execute approval, clear description, and no hidden automatic invocation.
- A stale async callback can use a destroyed socket/world/VM. Mitigate with weak cleanup/cancellation tokens, generation checks, game-thread queue ownership, and exactly-once completion.
- Cyclic or huge return tables can hang or exhaust memory. Mitigate with depth/node/output limits before JSON construction.
- A long or non-yielding command can freeze the Studio game thread. Retain the continuous CPU watchdog and add the wall deadline/cancellation path.
- Target ambiguity can execute in the wrong VM. Reject unsupported/same-VM modes instead of silently falling back.

## 10. Definition of Done

The feature is complete only when all of the following are true:

- `studiorpc_execute_luau` exposes exactly `code` and Client/Server `datamodel_type`.
- It executes in the already-running target VM, not a new external VM or edit-time runner.
- Client and Server are demonstrably distinct VM instances.
- First return, nil/no return, errors, yield, detached tasks, FIFO ordering, and state persistence match the recorded Roblox fixtures.
- Fresh command environments, `_G`/`shared` persistence, persistent ContextAction/Signal callbacks, and descendant-error isolation match the recorded Roblox fixtures.
- `require`, `Signal:Wait`, and native asynchronous continuation paths work without a Script actor or deliberate Script-only paths return a Lua error rather than asserting.
- A world with no script assets can execute, yield, time out, and stop PIE without an assert or crash.
- Every async terminal path releases the request, callback, scheduler handle, and socket exactly once.
- Result serialization is bounded and deterministic within the documented compatibility matrix.
- No source or result body is written to telemetry/logs.
- Existing Script/Module execution and all current StudioRPC play-test tools pass regression verification.

## Explicit Exclusions

- Edit/Studio DataModel execution.
- Multi-process PIE or remote game-server execution.
- Selecting a non-targeted Client by `clientId`.
- Transactional rollback of runtime effects.
- Returning multiple values or typed binary values.
- Redirecting `studiorpc_procedural_run` into PIE.
- Executing through a temporary script asset or actor.
- Exact reproduction of Roblox's private package-path error prefixes.
