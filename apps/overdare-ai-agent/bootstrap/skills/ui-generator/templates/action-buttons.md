# Template: Action Buttons

Use for mobile gameplay actions such as attack, shoot, pass, sprint, skill, interact, or dodge.

## Recommended Approach

- Prefer `UI_ELEMENTS` worldAsset icon packs when visual quality matters.
- Use direct GUI creation when exact layout and naming are more important.
- Hybrid is often best: direct layout container + imported icon buttons.

## Common Layouts

### 3-Button Cluster

Use for simple games:

- Primary action
- Secondary action
- Movement/utility action

Example names:

- `PrimaryActionButton`
- `SecondaryActionButton`
- `UtilityActionButton`

### 4-Button Cluster

Use for sports or action games:

- Primary action
- Secondary action
- Special action
- Defensive or utility action

Example names:

- `ShootButton`
- `PassButton`
- `DunkButton`
- `StealButton`

## Placement

- Place on the right side.
- Avoid the bottom-right default jump button.
- Place above or inward from the jump area.
- Use fixed Offset sizes for image buttons.
- Use the right action reference point for many games: `Position = (1, 0.5)`, `AnchorPoint = (0.5, 0.5)`, `Offset = (-230px, 0px)`.
- Arrange multiple buttons in an arc or compact cluster with enough space between touch targets.
- Use a fully transparent layout panel when needed, but make sure child button touch areas do not overlap.
- If the cluster overlaps, prefer adjusting individual button offsets or shifting the cluster rightward/inward before moving it upward into the main play view.
- Do not rotate action buttons.

## Size

Recommended touch target sizes:

- Main button: 84px-110px
- Secondary buttons: 72px-96px
- Default jump button reference is about 180px x 180px, so custom skill buttons should be visually distinct and not sit on top of it.

Use `UIAspectRatioConstraint` for square or circular buttons.

Skill and action buttons should usually be square or circular.

## Visual Style

- Use a cohesive color palette across the whole action cluster.
- Make the primary action more visually prominent than secondary actions.
- Use consistent icon size, padding, and border treatment.
- Avoid unrelated colors unless they communicate a clear gameplay meaning.

## ZIndex

- Normal gameplay buttons: 20-40
- Button labels/icons: parent + 1

## Behavior

- Connect with `LocalScript`.
- Use `Activated`.
- Add visible feedback first, such as scale-up, shift, or image change.
- Do not depend on keyboard shortcuts for the action.

## Good Result

The player should immediately understand which button is primary and should not accidentally touch default mobile controls.

