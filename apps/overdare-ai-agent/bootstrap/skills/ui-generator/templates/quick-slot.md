# Template: Quick Slot

Use for inventory shortcuts, skill slots, item slots, weapon slots, or ability hotbars.

## Recommended Approach

- Direct GUI creation for predictable slot naming.
- worldAsset icon frames can be used for polish.

## Common Hierarchy

```text
QuickSlotPanel
 ├─ Slot1Button
 ├─ Slot2Button
 ├─ Slot3Button
 └─ Slot4Button
```

Optional slot internals:

```text
Slot1Button
 ├─ ItemIcon
 ├─ CooldownOverlay
 └─ CountLabel
```

## Placement

- Usually lower center, right side, or upper-right depending on the game.
- Avoid bottom-left joystick and bottom-right jump button.
- For mobile, do not place too close to screen edges.
- Bottom-center is often safe with `Position = (0.5, 1)` and `AnchorPoint = (0.5, 1)`, as long as it does not overlap joystick or jump controls.
- For skill-like quick slots on the right, follow the action button safe-area rules instead.

## Size

- Slot size: Offset 64-92px.
- Slot spacing: Offset 8-18px.
- Count text: 18px-24px.

## Layout

- Use `UIListLayout` for simple horizontal or vertical rows.
- Use manual positioning when exact mobile safe area placement is needed.
- Use `UIGridLayout` for inventory-style slot grids.
- Add `UIAspectRatioConstraint` to keep slots square when needed.

## ZIndex

- Slot background: 20
- Icon: 21
- Cooldown overlay: 22
- Count label: 23

