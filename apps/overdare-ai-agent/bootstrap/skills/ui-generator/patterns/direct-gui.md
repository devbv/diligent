# Pattern: Direct GUI Creation

Use this pattern when creating UI directly with Studio GUI instances.

## When to Use

- The user needs a custom layout.
- No suitable `UI_ELEMENTS` worldAsset exists.
- The UI needs predictable hierarchy for later scripting.
- The UI is a scoreboard, popup, quick slot, health bar, stamina bar, status panel, or custom HUD.

## Core Rule

Create static UI instances in Studio whenever possible. Do not generate normal HUD or menu UI dynamically at runtime unless the UI truly needs to be created during gameplay.

2D game UI should normally live under `StarterGui` in Studio. Create or reuse a `ScreenGui` under `StarterGui`, then place root containers such as `GameHUDRoot`, `MainMenuRoot`, or `PopupRoot` under that `ScreenGui`.

Use a mobile landscape screen as the default target. A practical reference viewport is about `1386 x 640`.

Avoid persistent gameplay UI in the exact center of the screen because the character, camera focus, or aiming area often lives there. Centered UI is acceptable for intentional overlays such as menus, popups, dimmers, loading screens, or tutorial blockers.

## Recommended Workflow

1. Browse the current UI hierarchy.
2. Find `StarterGui` and the target `ScreenGui`, or create a new `ScreenGui` if needed.
3. Create a root container first, such as `GameHUDRoot`, `MainMenuRoot`, or `PopupRoot`.
4. Create panel-level children.
5. Create labels, buttons, images, and layout helpers under the panels.
6. Apply layout rules:
   - Position mostly with Scale.
   - Size mostly with Offset.
   - Use ZIndex bands clearly.
   - Use DisplayOrder for `ScreenGui` groups.
   - Use consistent padding and a cohesive color palette.
   - Respect the default mobile menu, joystick, and jump button regions.
7. Read or browse the result if needed and respond to tool warnings.
8. Add behavior only when requested.
9. Save and report the final hierarchy.

## Common Classes

- `ScreenGui`
- `Frame`
- `TextButton`
- `TextLabel`
- `ImageButton`
- `ImageLabel`
- `ScrollingFrame`
- `UIListLayout`
- `UIGridLayout`
- `UIAspectRatioConstraint`

## Parent-First Rule

Always create parent containers first, then child objects one level at a time.

Do not mix add operations and update operations in the same `studiorpc_instance_upsert` call. Create first, then update separately if needed.

Good:

1. Create `GameHUDRoot`.
2. Create `ScoreboardPanel` inside it.
3. Create `HomeScoreLabel`, `TimerLabel`, and `AwayScoreLabel` inside the panel.

Avoid creating a deeply nested hierarchy in one batch.

## Naming Pattern

- Root: `GameHUDRoot`, `MainMenuRoot`, `PopupRoot`
- Panel: `ScoreboardPanel`, `ActionPanel`, `StatusPanel`
- Button: `ShootButton`, `ConfirmButton`
- Text: `TimerLabel`, `ScoreLabel`
- Bar: `HealthBarBackground`, `HealthBarFill`

## Verification

After creation:

- Read back the hierarchy.
- Confirm all major UI objects are visible.
- Confirm safe areas are respected.
- Check any warnings or suggestions returned by Studio tools.
- Confirm normal HUD stays in the `0-99` ZIndex band and intentional overlays use `100+`.
- Save the level.

