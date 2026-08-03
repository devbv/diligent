---
name: build-playtest-loop
description: Plan and build one playable OVERDARE Studio game slice, then verify it through either a bounded real-input path or one temporary complex Luau scenario driver. Use when the user asks to make, prototype, or modify a game and also test, playtest, run, or prove the resulting gameplay in the same task.
---

# Build Playtest Loop

Complete one vertical slice:

`gameplay contract -> plan -> build -> validate -> one playtest -> evidence-based result`

Do not design the game around one hard-coded W/Space sequence. Design a coherent game first, then choose the smallest verification mode that can exercise its meaningful behavior.

## 1. Define the playable contract

Before editing the level, state:

- The player's goal and visible success feedback.
- The normal controls and important game-state transitions.
- A stable uppercase success marker using only letters, digits, `_`, `.`, `:`, or `-`, for example `DILIGENT_TARGET_DESTROYED`.
- Concrete visual, gameplay, and evidence acceptance checks.
- The selected verification mode:
  - **Input-backed:** one representative path fits W, A, S, D, and SPACE; at most 12 sequential steps; 50-1,500 ms per step; 5,000 ms total.
  - **Scripted:** the scenario needs state inspection, conditional waits, multiple interactions, targeting, inventory, combat, dialogue, or longer execution.

Use input-backed verification when it represents the mechanic honestly. Use scripted verification when the desktop action surface would force the game into an artificial five-second course.

## 2. Inspect and plan

Reuse the current session's Studio exploration. Inspect only the hierarchy and scripts relevant to the slice.

Create a short implementation plan. Separate:

1. Visible world and goal feedback.
2. Gameplay state transitions and real success marker.
3. Static and script validation.
4. The single selected playtest.

For scripted verification, also define 2-8 ordered checkpoint tokens that describe meaningful progress, such as:

`TARGET_DISCOVERED -> LINE_OF_SIGHT_CONFIRMED -> WEAPON_FIRED -> TARGET_DEFEATED`

## 3. Build the slice

- Preserve unrelated level content.
- Use direct instance tools for a few intentional objects and the procedural builder skill for repeated or formula-driven geometry.
- Keep geometry readable, collisions deliberate, and the normal player route coherent.
- Place `SpawnLocation` on a continuous collidable surface with enough capsule clearance. Verify that it does not overlap floors, pedestals, walls, or the first obstacle, and that the first route segment is walkable.
- Add the success marker to the real goal-completion code path, not to startup, a timer, or a playtest-only branch.
- Make success visible in-game as well as observable in the log.
- Use dedicated Studio script tools for every permanent Luau change.

## 4. Validate before play

- Inspect the affected hierarchy and important properties.
- Run `validatelua` on every permanently changed script.
- Resolve validation errors before starting the playtest.
- Save or apply the intended game changes.
- Do not use `studiorpc_game_play` for a rehearsal. The selected playtest owns play, stop, evidence, and temporary-script cleanup.

## 5. Run exactly one selected playtest

Call exactly one playtest tool. Do not call both modes in one skill invocation.

### Input-backed mode

Call `studio_playtest_goal` exactly once with the representative input path:

```json
{
  "actions": [
    { "keys": ["W"], "durationMs": 400 },
    { "keys": ["W", "SPACE"], "durationMs": 100 },
    { "keys": ["W"], "durationMs": 500 },
    { "keys": ["D"], "durationMs": 250 }
  ],
  "successMarker": "DILIGENT_GOAL_GATE_COMPLETE"
}
```

Replace the example timeline and marker with the current contract. Never provide `windowId`.

### Scripted mode

Call `studio_playtest_scripted` exactly once with one temporary client Luau driver:

```json
{
  "driverSource": "local workspace = game:GetService(\"Workspace\")\nlocal target = workspace:WaitForChild(\"CombatTarget\", 5)\nif not target then error(\"target missing\") end\ncheckpoint(\"TARGET_DISCOVERED\")\nlocal combat = game:GetService(\"ReplicatedStorage\"):WaitForChild(\"Combat\", 5)\nif not combat then error(\"combat API missing\") end\ncombat:FireServer(target)\ncheckpoint(\"ATTACK_REQUESTED\")\nlocal deadline = os.clock() + 5\nwhile target.Parent and os.clock() < deadline do task.wait(0.1) end\nif target.Parent then error(\"target survived\") end\ncheckpoint(\"TARGET_DEFEATED\")",
  "expectedCheckpoints": [
    "TARGET_DISCOVERED",
    "ATTACK_REQUESTED",
    "TARGET_DEFEATED"
  ],
  "successMarker": "DILIGENT_TARGET_DESTROYED",
  "timeoutMs": 15000
}
```

The driver is the body of a temporary `LocalScript`. It may inspect runtime state, wait for conditions, use the game's real client-facing APIs, and call `checkpoint("TOKEN")`.

The wrapper provides:

- `awaitCharacter(timeoutSeconds)` for the default bounded startup path. It
  returns only after the local character is in a stable playable state.
- `awaitSpawnedCharacter(timeoutSeconds)` for scenarios that intentionally
  need access while the character is airborne or still settling.
- `awaitPlayableCharacter(timeoutSeconds)` to wait for the local character,
  movement components, a spawn grace period, a non-airborne humanoid state,
  and sustained vertical position and velocity stability.
- `moveCharacterTo(humanoid, rootPart, destination, timeoutSeconds,
  horizontalTolerance, verticalTolerance)` to perform one bounded
  `Humanoid:MoveTo()`. Completion accepts either a successful
  `MoveToFinished` signal or the character entering the requested position
  tolerance, then verifies grounded state and final position. A `BasePart`
  destination is treated as a floor marker and uses its X/Z with the current
  character-root Y. Pass an explicit `Vector3` when the scenario intentionally
  needs a vertical destination.
- `waitUntil(predicate, timeoutSeconds, intervalSeconds)` for bounded state
  waits.

Prefer these helpers over unbounded event waits or open-ended loops.

Rules for the scripted driver:

- It must return after the scenario settles.
- It may contain at most 20,000 UTF-8 bytes and run for 1-30 seconds.
- It must emit the expected checkpoint tokens in order.
- It must not contain, print, or construct the success marker. Only the real game path may emit that marker.
- It must not add permanent project objects or rewrite permanent game scripts.
- Prefer the game's public interaction surfaces, RemoteEvents, attributes, and state machines over directly forcing the final state.
- If the scenario claims that the player walked, jumped, dodged, or approached
  an interaction, begin with `awaitCharacter` or `awaitPlayableCharacter` and use
  `moveCharacterTo` for every automated walking segment. Never accept `MoveToFinished` alone as proof: a spawning or falling character can satisfy
  a planar check while remaining far above or below the intended route.
- Before firing an interaction RemoteEvent, verify the character is still
  grounded and within the same server-side distance tolerance used by the
  game. Log both the character and target positions when that check fails.
- Emit a checkpoint only after the resulting game state is observed. Sending a
  request is not itself a successful gameplay checkpoint.
- This gray-box mode does not prove real player input. Report that limitation explicitly.

Do not retry automatically after any failure. One skill invocation performs one playtest run.

## 6. Classify the result

Treat PASS as complete only when the selected mode's evidence and cleanup all succeed.

Input-backed PASS requires:

- Every required ordered input marker.
- The requested game success marker.
- Before and after images.
- Successful cleanup.

Scripted PASS requires:

- Driver ready and completion.
- Every expected checkpoint in order.
- The requested real game success marker.
- Successful stop and temporary-driver removal.

Classify failures:

- **Build failure:** Studio edits, apply/save, or permanent Luau validation failed before play.
- **Harness failure:** container discovery, driver/observer startup, capture, input delivery, interruption, or cleanup failed.
- **Driver failure:** `DRIVER_FAILED`, `DRIVER_TIMEOUT`, or `CHECKPOINTS_NOT_OBSERVED`.
- **Game failure:** `GOAL_NOT_OBSERVED` after the selected actions or scripted checkpoints completed.

For a failure, identify the last confirmed checkpoint or input marker and recommend the smallest next change. Do not apply it or run again unless the user asks.

## 7. Report

Return:

- What was built.
- The selected verification mode and why.
- The planned input timeline or scripted checkpoint sequence.
- PASS or FAIL and its classification.
- Required and observed inputs or checkpoints.
- Success marker and whether it was observed.
- Evidence artifact paths, including driver source and captured Play.log for scripted runs.
- `runId`, report path, and trace path.
- Cleanup status.
- The gray-box limitation for scripted runs.
- The next recommended change when the run fails.
