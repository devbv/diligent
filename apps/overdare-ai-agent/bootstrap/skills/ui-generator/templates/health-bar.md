# Template: Health / Stamina Bar

Use for health, stamina, mana, shield, energy, cooldown, or charge bars.

## Recommended Approach

Direct GUI creation is usually best.

## Common Hierarchy

```text
StatusPanel
 └─ HealthBarBackground
     ├─ HealthBarFill
     └─ HealthLabel
```

Optional stamina:

```text
StatusPanel
 └─ StaminaBarBackground
     ├─ StaminaBarFill
     └─ StaminaLabel
```

## Placement

- Avoid bottom-left joystick area.
- Put player status panels above the joystick area or near upper-left safe space.
- Keep away from top-left system menu.
- A good left-side reference is `Position = (0, 0.4)`, `AnchorPoint = (0, 0.5)`, with about `40px` X offset.
- Do not place large status bars in the exact center of the screen during gameplay.

## Size

- Bar width: Offset 180-320px.
- Bar height: Offset 18-36px.
- Labels: 18px-24px depending on importance.

## Fill Rule

Use Scale X for the fill amount.

Example concept:

```lua
HealthBarFill.Size = UDim2.new(healthPercent, 0, 1, 0)
```

## Visual Rules

- Background should be darker.
- Fill should be bright and easy to identify.
- Health is often green or red.
- Stamina is often yellow, blue, or green.
- Keep colors consistent with the rest of the HUD palette.
- Use a backing panel if the gameplay background makes the bar hard to read.

## ZIndex

- Background: 20
- Fill: 21
- Text: 22

