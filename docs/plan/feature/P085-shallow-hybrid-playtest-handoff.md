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
- Public tool: `studio_playtest_smoke({ windowId? })`

The TypeScript implementation and cross-compiled Windows bundle have been
verified. A real OVERDARE Studio run on Windows is the remaining acceptance
step.

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

This is intentionally a shallow vertical slice, not the final player
architecture.

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
  windowId?: string
})
```

- The tool requests one `execute` approval.
- `windowId` is used only to resolve an ambiguous list returned by a previous
  run.
- The only allowed input sequence is:

```text
click client center
hold W for 500 ms
press and release Space
wait 500 ms
```

- The tool is not parallel-safe.
- Non-Windows execution returns `UNSUPPORTED_PLATFORM` before approval.

### Execution flow

1. Call existing `level.browse`.
2. Require exactly one `StarterPlayerScripts`.
3. Add `__DiligentPlaytestObserver_<runId>` as a temporary `LocalScript`.
4. Call existing `level.apply`.
5. Call existing `game.play`, which clears the previous `Play.log`.
6. Wait up to 10 seconds for the observer's `ready` marker.
7. Enumerate visible windows whose title or process name contains
   `OVERDARE_PLAYTEST_WINDOW_MATCH` (default: `overdare`).
8. Require one matching window, or the explicitly selected `windowId`.
9. Capture `before.png`.
10. Apply the fixed input sequence through `SendInput`.
11. Capture `after.png`.
12. Wait up to two seconds for W/Space begin/end markers.
13. In `finally`, call `game.stop`, delete the observer, and call
    `level.apply`.
14. Write the report and return all existing captured images.

### Pass condition

PASS requires all of the following:

- observer `ready`;
- `W:begin`;
- `W:end`;
- `SPACE:begin`;
- `SPACE:end`;
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
| `AMBIGUOUS_STUDIO_WINDOWS` | Multiple matching windows and no explicit id |
| `OBSERVER_NOT_READY` | Observer injection, play start, or ready marker failed |
| `CAPTURE_FAILED` | Before or after capture did not produce a valid PNG |
| `INPUT_NOT_OBSERVED` | Input application failed or required markers were incomplete |
| `CLEANUP_FAILED` | `game.stop`, observer delete, or final apply failed |
| `INTERRUPTED` | Tool signal was aborted |

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
| PowerShell runner, Win32 capture, fixed input adapter | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/playtest-desktop.ts` |
| Approval-free script document mutations | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/script-document-operations.ts` |
| Tool registration and shared write lock | `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts` |
| Orchestration tests | `apps/overdare-ai-agent/sidecar/test/tools/studiorpc/tools/playtest-smoke-tool.test.ts` |
| PowerShell boundary tests | `apps/overdare-ai-agent/sidecar/test/tools/studiorpc/tools/playtest-desktop.test.ts` |

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

## Verification already completed

The implementation session completed:

- 214 sidecar tool tests passing;
- orchestration coverage for success, missing/duplicate
  `StarterPlayerScripts`, observer timeout, missing/ambiguous windows, capture
  failure, incomplete input, interruption, cleanup failure, and unsupported
  platforms;
- PowerShell payload isolation, non-zero exit, timeout, abort, and adapter
  payload tests;
- full repository pre-commit lint;
- full repository TypeScript typecheck;
- successful Bun cross-compilation to `bun-windows-x64`.

The PowerShell/PInvoke code has not yet been executed against a real Windows
Studio window.

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
.\apps\overdare-ai-agent\sidecar\node_modules\.bin\tsc.cmd `
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

- The result status is `PASS`.
- Studio receives W and Space without manual interaction.
- Two images are visible in the tool result.
- `report.json` contains all four required input markers.
- `trace.jsonl` contains `observer.ready`, `input.applied`,
  `input.observed`, and cleanup events.
- Studio is no longer playing after completion.
- The `.ovdrjm` file contains no
  `__DiligentPlaytestObserver_<runId>` instance.

Run at least three times to detect focus, timing, or stale-window instability.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | Confirm the sidecar process itself is running on Windows |
| `STARTER_PLAYER_SCRIPTS_NOT_FOUND` | Browse the level and ensure exactly one container exists |
| `AMBIGUOUS_STUDIO_WINDOWS` | Retry with a candidate `windowId` returned in the failure output |
| `OBSERVER_NOT_READY` | Inspect `Play.log`; confirm the LocalScript was applied and client scripts execute |
| `CAPTURE_FAILED` | Restore/uncover the window; check PowerShell 5.1 and `System.Drawing`; verify the desktop is unlocked |
| `INPUT_NOT_OBSERVED` | Confirm Studio is focused, the sidecar shares the same interactive session, and no elevated/non-elevated boundary blocks input |
| `CLEANUP_FAILED` | Stop play manually and delete any `__DiligentPlaytestObserver_*` script before retrying |

If Windows foreground restrictions make `SetForegroundWindow` unreliable,
capture the actual failure before changing architecture. The first fallback to
evaluate is a small Rust helper owned by the launcher, not an expansion of
Studio RPC.

## Known v1 limitations

- Windows only.
- Captures the visible client rectangle with `Graphics.CopyFromScreen`; covered
  or off-screen pixels are not recovered.
- Fixed center click, W, and Space only.
- No arbitrary pointer coordinates, mouse delta, touch, gamepad, or concurrent
  key state.
- One local player only.
- No checkpoint, restore, profiler, or runtime object query.
- No contract YAML, general gameplay Eval, player subagent, or skill.
- No automatic game-specific success condition.
- No artifact retention policy.
- The observer depends on current `UserInputService`, `Enum.KeyCode`, and
  `HumanoidRootPart` conventions; only input markers are required for PASS.

## Recommended next steps after Windows acceptance

Do not broaden the player surface until the real Windows run is stable.

1. Fix only concrete Windows acceptance failures.
2. Run repeated smoke tests and record focus/capture/input reliability.
3. If stable, expose narrowly validated internal capture and input primitives.
4. Add a `game-playtester` custom agent and a routing skill that use those
   primitives.
5. Add per-game contracts and separate Play policy from Eval scoring.
6. Consider a Rust desktop helper only if PowerShell startup, focus, or
   capture reliability becomes the measured bottleneck.

The first expansion should preserve the current invariant: Studio RPC controls
editor lifecycle, the OS adapter produces real input and frames, and Lua
observers provide optional gray-box evidence.
