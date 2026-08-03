---
id: P085-HANDOFF
created: 2026-07-30
status: active
branch: feat/shallow-hybrid-playtest
implementation_commit: c2324e18
---

# P085 Hand-off: Shallow Hybrid Playtest

## Why this hand-off exists

This document preserves the design context, repository research, implementation
shape, and Windows acceptance procedure for the first playable-agent slice. It
is intended for continuing the work on a Windows machine without re-deriving
the decisions from the original session.

The implementation is on:

- Remote branch: `origin/feat/shallow-hybrid-playtest`
- Initial implementation commit: `c2324e18`
- Public tools: `studio_playtest_smoke({ actions? })`,
  `studio_playtest_goal({ actions, successMarker })`, and
  `studio_playtest_scripted({ driverSource, expectedCheckpoints, successMarker, timeoutMs? })`

The TypeScript implementation and cross-compiled Windows bundle have been
verified. One real default smoke run passed on Windows; repeated stability and
a real goal-marker run remain acceptance work.

## Original goal and constraint

The longer-term goal is a hybrid player that can:

1. start an unfamiliar game;
2. observe rendered state and selected runtime facts;
3. apply real player input;
4. retain a trace;
5. evaluate goal completion separately from play policy.

The initial design considered adding a richer Studio RPC playtest surface:

```text
playtest.capabilities
playtest.episode.start
playtest.observe
playtest.skill.run
playtest.raw_input.apply
playtest.checkpoint.save
playtest.checkpoint.load
playtest.episode.stop
```

That surface was rejected for the first slice because extending Studio RPC is
currently the hard dependency. The locked constraint is:

> Do not add or change Studio RPC methods for v1.

The resulting v1 proves one end-to-end fact: the agent can start Studio play,
send real W/Space input, observe those inputs inside the game, capture before
and after frames, and clean up its temporary instrumentation.

## Architecture decision

The selected design separates the control, action, and observation paths:

```text
Diligent tool
  |
  +-- existing Studio RPC ------------------ game.play / game.stop / level.apply
  |
  +-- temporary LocalScript ---------------- ready + input markers -> Play.log
  |
  +-- local Windows PowerShell/PInvoke ------ window capture + SendInput
```

The desktop tools remain a shallow vertical slice. A separate scripted mode now
covers complex gray-box scenarios without pretending that direct game API
calls prove real player input.

### Why this design was selected

- It does not require new Studio RPC methods.
- It verifies that input reached `UserInputService`, rather than only verifying
  that the operating system accepted an input call.
- It uses dependencies already present on supported Windows installations:
  Windows PowerShell 5.1, `user32.dll`, and `System.Drawing`.
- It keeps the action surface fixed and bounded while the fragile desktop
  boundary is validated.
- It reuses the existing Studio provider write lock and injected `callRpc`
  boundary.

### Alternatives deferred

| Alternative | Reason deferred |
| --- | --- |
| New Studio RPC playtest methods | Current hard dependency and explicitly out of scope |
| Rust native desktop helper | Better long-term robustness, but adds a binary, IPC, packaging, and release work before proving the slice |
| External MCP/computer-use harness | Adds installation and session dependencies and is not a bundled product capability |
| Lua-only self-playing test | Useful gray-box testing, but does not prove real player input |
| Screen capture plus input with no Lua observer | Cannot reliably distinguish input delivery from game receipt |

## Critical topology requirement

`studio_playtest_smoke` must execute in a sidecar process running:

- on Windows 10/11;
- in the same interactive Windows user session as OVERDARE Studio;
- with a local `--cwd` pointing to the Studio project containing the `.umap`
  and `.ovdrjm` files.

The model provider and browser UI may be remote. The sidecar and Studio may
not be separated for this tool because PowerShell operates on the sidecar
machine's local window handles and input desktop.

This is an exception to the normal remote Mac-agent/Windows-Studio RPC
topology. Remote Studio RPC continues to work for ordinary `studiorpc_*`
operations, but it cannot make a Mac sidecar call Windows `SendInput`.

Do not run the sidecar as a Windows service or in session 0. Avoid a locked or
disconnected RDP desktop during acceptance.

## Implemented behavior

### Public tool contract

```ts
studio_playtest_smoke({
  actions?: Array<{
    keys: Array<"W" | "A" | "S" | "D" | "SPACE">
    durationMs: number
  }>
})

studio_playtest_goal({
  actions: Array<{
    keys: Array<"W" | "A" | "S" | "D" | "SPACE">
    durationMs: number
  }>
  successMarker: string
})

studio_playtest_scripted({
  driverSource: string
  expectedCheckpoints: string[]
  successMarker: string
  timeoutMs?: number
})
```

- Each tool requests one `execute` approval.
- `windowId` is intentionally absent. Agents must not invent or reuse native
  window IDs or use helper tools to discover windows.
- `actions` accepts 1-12 sequential steps, each lasting
  50-1,500 ms, with a maximum total duration of 5,000 ms. Each step holds zero
  to three unique keys from W, A, S, D, and Space. An empty key list is a wait.
- `actions` is optional only for `studio_playtest_smoke`.
- At least one step must hold a key. Keys remain held across adjacent steps and
  are always released at the end, including failure paths.
- `successMarker` exists only on `studio_playtest_goal`, is required, and
  accepts a bounded token containing only letters, digits, `_`, `.`, `:`, or
  `-`. The exact token must appear in `Play.log` for PASS. This separate schema
  prevents agents from inventing placeholder markers during input-only smoke
  runs.
- Omitting smoke `actions` preserves the compatibility sequence:

```text
click client center
hold W for 500 ms
press and release Space
wait 500 ms
```

- Neither tool is parallel-safe.
- Non-Windows execution returns `UNSUPPORTED_PLATFORM` before approval.

The scripted tool has a separate contract:

- It injects one temporary client `LocalScript` and runs without a native
  desktop adapter, so it is not Windows-only.
- `driverSource` is a 1-20,000 byte Luau function body. It may inspect runtime
  state, wait for conditions, call game-facing client APIs, and call
  `checkpoint("TOKEN")`.
- The wrapper provides `awaitPlayableCharacter(...)` and
  `moveCharacterTo(...)` for movement scenarios. These helpers wait for a
  spawn grace period plus sustained stable non-airborne character samples, then
  accept either a successful `MoveToFinished` signal or entry into the requested
  position tolerance, then verify the final horizontal/vertical position error.
- `moveCharacterTo(...)` treats `BasePart` destinations as floor markers by
  combining their X/Z with the current root Y. Explicit `Vector3` destinations
  retain full 3D movement semantics.
- `awaitCharacter(...)` now waits for the same stable playable state by default
  so legacy drivers do not begin during spawn freefall.
  `awaitSpawnedCharacter(...)` remains available for intentional airborne
  scenarios.
- `expectedCheckpoints` contains 1-20 unique tokens and must appear in order.
- `timeoutMs` is 1,000-30,000 ms and defaults to 15,000 ms.
- The driver source may not contain the reserved harness prefix or the exact
  success marker. The marker must come from the real game success path.
- The run preserves `driver.luau`, captured `play.log`, `trace.jsonl`, and
  `report.json` under the run directory.
- The driver is always removed after play. The tool never retries
  automatically.

### Execution flow

1. Call existing `level.browse`.
2. Require exactly one `StarterPlayerScripts`.
3. Add `__DiligentPlaytestObserver_<runId>` as a temporary `LocalScript`.
4. Call existing `level.apply`.
5. Call existing `game.play`, which clears the previous `Play.log`.
6. Wait up to 10 seconds for the observer's `ready` marker.
7. Enumerate visible windows whose title or process name contains
   `OVERDARE_PLAYTEST_WINDOW_MATCH` (default: `overdare`).
8. Require exactly one matching window.
9. Capture `before.png`.
10. Apply the bounded input timeline through `SendInput`.
11. Capture `after.png`.
12. Wait up to two seconds for the required ordered key begin/end markers and,
    when requested, the game success marker.
13. In `finally`, call `game.stop`, delete the observer, and call
    `level.apply`.
14. Write the report and return all existing captured images.

### Pass condition

PASS requires all of the following:

- observer `ready`;
- every ordered key transition derived from the requested action timeline;
- the requested game success marker for `studio_playtest_goal`;
- valid before and after PNG files;
- successful game stop and observer removal.

Optional `HumanoidRootPart` positions are diagnostic only. A missing character
or different character root does not fail v1.

### Failure codes

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | Sidecar is not running on Windows |
| `STARTER_PLAYER_SCRIPTS_NOT_FOUND` | Zero or multiple matching containers, or level browse failed |
| `STUDIO_WINDOW_NOT_FOUND` | No matching visible window, or requested id is stale |
| `AMBIGUOUS_STUDIO_WINDOWS` | Multiple matching windows; close or hide extras before a new run |
| `OBSERVER_NOT_READY` | Observer injection, play start, or ready marker failed |
| `CAPTURE_FAILED` | Before or after capture did not produce a valid PNG |
| `INPUT_NOT_OBSERVED` | Input application failed or required markers were incomplete |
| `GOAL_NOT_OBSERVED` | Input delivery succeeded but the requested game success marker was absent |
| `CLEANUP_FAILED` | `game.stop`, observer delete, or final apply failed |
| `INTERRUPTED` | Tool signal was aborted |

Scripted runs add:

| Code | Meaning |
| --- | --- |
| `DRIVER_NOT_READY` | Temporary client driver injection, apply visibility, or startup marker failed |
| `PLAY_NOT_STARTED` | `game.play` returned but `Play.log` did not reset or produce new output |
| `DRIVER_FAILED` | The bounded Luau driver raised a runtime error |
| `DRIVER_TIMEOUT` | The driver did not return before its configured deadline |
| `CHECKPOINTS_NOT_OBSERVED` | Driver returned but required ordered scenario checkpoints were incomplete |

Cleanup failure takes precedence in the final failure code. The report retains
the original failure as `primaryFailure` when both the run and cleanup fail.

### Artifacts

Artifacts are stored under the configured Diligent storage root:

```text
<storage-root>/playtests/runs/<runId>/
  before.png
  after.png
  trace.jsonl
  report.json
```

In the OVERDARE product namespace, `<storage-root>` is normally `.overdare`.
In a default Diligent development environment, it may be `.diligent`.

## Code map

| Area | Path |
| --- | --- |
| Orchestration, observer source, log parsing, artifacts | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/playtest-smoke-tool.ts` |
| PowerShell runner, Win32 capture, bounded input adapter | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/playtest-desktop.ts` |
| Approval-free script document mutations | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/script-document-operations.ts` |
| Tool registration and shared write lock | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts` |
| One-loop build and playtest workflow | `apps/overdare-ai-agent/bootstrap/skills/build-playtest-loop/SKILL.md` |
| Orchestration tests | `apps/overdare-ai-agent/sidecar/test/tools/studiorpc/tools/playtest-smoke-tool.test.ts` |
| PowerShell boundary tests | `apps/overdare-ai-agent/sidecar/test/tools/studiorpc/tools/playtest-desktop.test.ts` |
| Complex temporary Luau driver | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/playtest-scripted-tool.ts` |
| Scripted driver tests | `apps/overdare-ai-agent/sidecar/test/tools/studiorpc/tools/playtest-scripted-tool.test.ts` |

The public `studiorpc_script_add` and `studiorpc_script_delete` tools now reuse
the same approval-free document operations. Their approval and rendering
behavior remains unchanged.

## OVERDARE API research basis

The observer design is based on the official Creator Guide:

- [`StarterPlayerScripts`](https://docs.overdare.com/development/api-reference/classes/starterplayerscripts)
  copies its scripts into each player's `PlayerScripts`.
- [`PlayerScripts`](https://docs.overdare.com/development/api-reference/classes/playerscripts)
  runs copied `LocalScript` instances on the associated client.
- [`LocalScript`](https://docs.overdare.com/development/api-reference/classes/localscript)
  supports client-only APIs and `game.Players.LocalPlayer`.
- [`UserInputService`](https://docs.overdare.com/api-reference/classes/userinputservice)
  exposes `InputBegan` and `InputEnded`.
- [`InputObject`](https://docs.overdare.com/development/api-reference/classes/inputobject)
  exposes the input key and state used by the observer.

The reviewed public API documents expose input observation but did not provide
a supported general input-synthesis API. That absence is why v1 applies input
outside the game through Windows `SendInput` and observes receipt inside the
game through `UserInputService`.

The scripted expansion also relies on official client runtime surfaces:

- [`RunService`](https://docs.overdare.com/api-reference/classes/runservice)
  provides bounded frame-by-frame waits through `Heartbeat` and
  `RenderStepped`.
- [`Camera`](https://docs.overdare.com/development/api-reference/classes/camera)
  exposes `WorldToViewportPoint` and `ViewportSize` for target observations.
- [`WorldRoot`](https://docs.overdare.com/development/api-reference/classes/worldroot)
  and [`RaycastResult`](https://docs.overdare.com/development/api-reference/datatype/raycastresult)
  support line-of-sight and hit-path checks.
- [`Instance`](https://docs.overdare.com/development/api-reference/classes/instance)
  exposes hierarchy, tags, attributes, and descendant queries needed by
  scenario drivers.
- [`Player`](https://docs.overdare.com/development/api-reference/classes/player)
  documents that `Character` may initially be absent, so the wrapper provides
  the bounded `awaitCharacter(...)` helper instead of assuming spawn is
  complete.
- [`Humanoid`](https://docs.overdare.com/development/api-reference/classes/humanoid)
  exposes `GetState`, `MoveTo`, and `MoveToFinished`, allowing scenarios to
  reject spawning/freefall states and exercise a game-facing movement API
  without pretending that it proves keyboard input. `AssemblyLinearVelocity`
  on the root part is also checked before movement begins.

These APIs let a temporary driver express stateful gameplay such as acquiring
an item, waiting for a door state, selecting a visible target, invoking the
game's client interaction surface, and confirming the resulting state. Direct
driver calls are intentionally reported as gray-box evidence, not real-control
evidence.

## Windows debugging and acceptance session (2026-07-30 to 2026-07-31)

The Windows continuation session used the sidecar at `127.0.0.1:11000` with
the Studio project at `C:\Users\jjss\Documents\test`. It exercised both the
input-backed smoke path and a stateful `ComplexRoom` scenario driven through
the game's real `ComplexRoomAction` `RemoteEvent`.

The representative scenario was:

```text
BUTTON_ACTIVATED -> DOOR_OPENED -> KEY_ACQUIRED -> TARGET_DEFEATED
```

The real server completion path emitted `COMPLEX_ROOM_COMPLETE`. The temporary
driver never printed or constructed that marker.

### Failure-to-fix record

| Run | Result | Evidence and action |
| --- | --- | --- |
| `1785402375165-cbcc2793` | PASS | The fixed W/Space smoke path observed all four input markers and completed cleanup. |
| `1785407798459-d8417bff` | FAIL (`DRIVER_NOT_READY`) | Studio and the sidecar were attached to different project directories. The sidecar was restarted with `--cwd=C:\Users\jjss\Documents\test`. |
| `1785476753423-64e235d7` | FAIL (`DRIVER_FAILED`) | The character was still in the pre-physics spawn window. `awaitPlayableCharacter` gained a spawn grace period plus sustained position, velocity, and humanoid-state stability checks. |
| `1785477013355-ab93723f` | FAIL (`DRIVER_FAILED`) | The direct route crossed `ButtonPedestal`. The two front-of-door waypoints were moved to a collision-safe right-side route. |
| `1785477238759-af5dcbba` | FAIL (`DRIVER_FAILED`) | `moveCharacterTo` used a floor marker's Y coordinate as a 3D destination. `BasePart` destinations now combine marker X/Z with the current root Y. |
| `1785477456272-54d4198f` | FAIL (`DRIVER_FAILED`) | The route reached `KEY_ACQUIRED` but the key pedestal blocked the diagonal target approach. `WaypointTargetApproach` moved to `(150, 25, 700)`, still within the target's 300 cm server interaction limit. |
| `1785477933723-a0dde3e3` | FAIL (`PLAY_NOT_STARTED`) | A concurrent camera-validation task had left Studio in Play mode. The stale Play session was stopped explicitly before the next run. |
| `1785477988110-cbe29ac5` | FAIL (`DRIVER_FAILED`) | The root was only about 19 cm from `WaypointDoorPast`, but OVERDARE did not emit `MoveToFinished`. Movement completion now accepts either the success signal or actual entry into the requested position tolerance. Timeout errors retain root, target, and humanoid-state diagnostics. |
| `1785478092291-c87c2be3` | PASS | All ordered checkpoints, driver completion, the real success marker, and cleanup were observed. |

### Final acceptance evidence

The final report recorded:

- `status: PASS`;
- all four checkpoints in the required order;
- `driverCompleted: true`;
- `successMarkerObserved: true` for `COMPLEX_ROOM_COMPLETE`;
- `cleanupSucceeded: true` with no cleanup errors; and
- no remaining `__DiligentScriptedPlaytest_1785478092291-c87c2be3`
  instance in `StarterPlayerScripts`.

The local evidence directory is:

```text
C:\Users\jjss\Documents\test\.overdare\playtests\runs\1785478092291-c87c2be3
```

It contains `driver.luau`, `play.log`, `trace.jsonl`, and `report.json`. These
runtime artifacts are intentionally not committed to this repository; the run
identifier and acceptance facts above preserve the handoff record without
copying project-local evidence or generated logs into source control.

## Verification already completed

The implementation session completed:

- 226 sidecar tool tests passing;
- 31 additional registration, bootstrap-skill, and runtime-config tests passing;
- orchestration coverage for success, missing/duplicate
  `StarterPlayerScripts`, observer timeout, missing/ambiguous windows, capture
  failure, incomplete input, interruption, cleanup failure, and unsupported
  platforms;
- scripted-driver coverage for ordered checkpoints, real game markers, driver
  errors, missing checkpoints, missing goals, timeouts, approval rejection, and
  cleanup;
- PowerShell payload isolation, non-zero exit, timeout, abort, and adapter
  payload tests;
- sidecar TypeScript typecheck and scoped Biome checks;
- a live Windows input-backed smoke PASS; and
- a live scripted MiniCourse run that reached
  `PLAYER_READY -> GOAL_FOUND -> HURDLE_APPROACHED`, classified the failed
  hurdle traversal as `DRIVER_FAILED`, retained the run artifacts, and
  completed cleanup without retrying.

## Windows continuation checklist

### 1. Prepare the branch

```powershell
git fetch origin
git switch feat/shallow-hybrid-playtest
git pull --ff-only
bun install
```

### 2. Run automated verification

```powershell
bun test .\apps\overdare-ai-agent\sidecar\test\tools
.\apps\overdare-ai-agent\sidecar\node_modules\.bin\tsc.exe `
  --pretty false --noEmit `
  -p .\apps\overdare-ai-agent\sidecar\tsconfig.json
```

### 3. Start the local Studio topology

1. Open the target project in OVERDARE Studio.
2. Confirm the project contains exactly one `StarterPlayerScripts`.
3. Keep the play window visible and unobstructed.
4. Start the sidecar on the same Windows machine:

```powershell
$env:STUDIO_PORT = "13377"
bun run .\apps\overdare-ai-agent\sidecar\src\server.ts `
  --dev `
  --port=7433 `
  --cwd="C:\path\to\StudioProject"
```

5. In another terminal, start the Web client:

```powershell
bun run --cwd .\apps\overdare-ai-agent\sidecar web:dev
```

6. Open `http://localhost:5174`.
7. Ask the agent to run the shallow Studio playtest and approve the tool.

### 4. Acceptance checks

For input-backed mode:

- The result status is `PASS`.
- Studio receives W and Space without manual interaction.
- Two images are visible in the tool result.
- `report.json` contains all four required input markers.
- `trace.jsonl` contains `observer.ready`, `input.applied`,
  `input.observed`, and cleanup events.

For scripted mode:

- The temporary driver reports every expected checkpoint in order.
- `Play.log` contains the exact success marker emitted by the game, not by the
  driver.
- `driver.luau`, `play.log`, `trace.jsonl`, and `report.json` are retained in
  the run artifact directory.

For both modes:

- Studio is no longer playing after completion.
- The `.ovdrjm` file contains no temporary
  `__DiligentPlaytestObserver_<runId>` or
  `__DiligentScriptedPlaytest_<runId>` instance.
- A failed run is reported with its evidence and cleanup state without an
  automatic retry.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | Confirm the sidecar process itself is running on Windows |
| `STARTER_PLAYER_SCRIPTS_NOT_FOUND` | Browse the level and ensure exactly one container exists |
| `AMBIGUOUS_STUDIO_WINDOWS` | Close or hide extra matching windows, then start a new run |
| `OBSERVER_NOT_READY` | Inspect `Play.log`; confirm the LocalScript was applied and client scripts execute |
| `CAPTURE_FAILED` | Restore/uncover the window; check PowerShell 5.1 and `System.Drawing`; verify the desktop is unlocked |
| `INPUT_NOT_OBSERVED` | Confirm Studio is focused, the sidecar shares the same interactive session, and no elevated/non-elevated boundary blocks input |
| `GOAL_NOT_OBSERVED` | Input reached the game; inspect route geometry, timing, collision, spawn orientation, and the real goal code path |
| `CLEANUP_FAILED` | Stop play manually and delete any `__DiligentPlaytestObserver_*` script before retrying |

If Windows foreground restrictions make `SetForegroundWindow` unreliable,
capture the actual failure before changing architecture. The first fallback to
evaluate is a small Rust helper owned by the launcher, not an expansion of
Studio RPC.

## Known v1 limitations

- Windows only.
- Captures the visible client rectangle with `Graphics.CopyFromScreen`; covered
  or off-screen pixels are not recovered.
- Fixed center click plus bounded W/A/S/D/Space timelines only.
- No arbitrary pointer coordinates, mouse delta, touch, gamepad, or keys
  outside the bounded movement/jump set.
- One local player only.
- No checkpoint, restore, profiler, or runtime object query.
- No contract YAML, adaptive visual gameplay evaluator, or player subagent.
- Game-specific success is limited to one exact `Play.log` marker.
- No automatic repair or retry after a failed run.
- No artifact retention policy.
- The observer depends on current `UserInputService`, `Enum.KeyCode`, and
  `HumanoidRootPart` conventions; only input markers are required for PASS.
- Scripted mode is client-only, accepts bounded generated Luau, and does not
  prove input bindings, control feel, camera feel, accessibility, or visual
  discoverability.
- Scripted mode trusts the driver to use normal game-facing APIs rather than
  directly force the final state; ordered checkpoints and a separately emitted
  game marker make that behavior inspectable but are not a security sandbox.

## Recommended next steps after Windows acceptance

Do not broaden the player surface until the real Windows run is stable.

1. Fix only concrete Windows acceptance failures.
2. Run repeated smoke tests and record focus/capture/input reliability.
3. Use input-backed mode for control acceptance and scripted mode for complex
   gray-box scenario coverage; do not merge their claims.
4. Add per-game contracts and separate Play policy from Eval scoring.
5. Consider a `game-playtester` custom agent only after representative
   scripted drivers establish reusable scenario patterns.
6. Consider a Rust desktop helper only if PowerShell startup, focus, or
   capture reliability becomes the measured bottleneck.

The first expansion should preserve the current invariant: Studio RPC controls
editor lifecycle, the OS adapter produces real input and frames, and Lua
observers provide optional gray-box evidence.
