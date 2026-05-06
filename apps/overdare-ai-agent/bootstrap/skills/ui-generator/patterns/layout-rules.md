# Pattern: Layout Rules

Use this pattern for Position, Size, text, ZIndex, and DisplayOrder decisions.

Default target is landscape mobile. A useful reference viewport is about `1386 x 640`.

Normal gameplay HUD should avoid the center of the screen when possible because the player character, crosshair, or camera focus often occupies that space. Intentional overlays such as main menus, loading screens, dimmers, tutorial blockers, and popups may use the center.

## Position

`Position` has four values:

- X Scale
- X Offset
- Y Scale
- Y Offset

Default strategy:

- Control Position primarily with Scale.
- Use Offset as padding, margin, or small correction.
- Avoid large Offset-only positioning for core layout.

Examples:

- Center top: `AnchorPoint.X = 0.5`, `Position.X.Scale = 0.5`
- Right side: `AnchorPoint.X = 1`, `Position.X.Scale = 1`, negative X Offset
- Left side: `AnchorPoint.X = 0`, `Position.X.Scale = 0`, positive X Offset

Recommended mobile reference points:

- Top-center HUD: `Position = (0.5, 0)`, `AnchorPoint = (0.5, 0)`, about `18px` Y offset.
- Left safe status area: `Position = (0, 0.4)`, `AnchorPoint = (0, 0.5)`, about `40px` X offset.
- Bottom-center safe area: `Position = (0.5, 1)`, `AnchorPoint = (0.5, 1)`.
- Right action area: `Position = (1, 0.5)`, `AnchorPoint = (0.5, 0.5)`, about `-230px` X offset.
- Default jump button reference: `Position = (1, 1)`, `AnchorPoint = (0.5, 0.5)`, `Offset = (-230px, -160px)`, `Size = 180px x 180px`.

## Size

`Size` has four values:

- X Scale
- X Offset
- Y Scale
- Y Offset

Default strategy:

- Use Offset for concrete UI element sizes.
- Use Scale for full, half, one-third, or parent-relative sizes.
- Image-dependent UI should usually use Offset sizes.

Examples:

- Full root: Scale `1, 0, 1, 0`
- Fixed action button: Offset `84, 84` or `100, 100`
- Half-width panel: X Scale `0.5`, Y Offset fixed as needed

## Text

Rules:

- Important mobile text should usually be at least 24px.
- Use absolute TextSize for readability.
- Use `TextWrapped` for longer text.
- Avoid emoji and special Unicode symbols.
- Ensure strong contrast.
- If the background is visually complex, add a dark or translucent backing panel behind text.

Suggested sizes:

- Title: 32px+
- Important button: 24px+
- Gameplay numbers: 28px+
- Secondary text: 18px-22px only when acceptable

## ZIndex

Use ZIndex to order elements within a GUI group.

Recommended bands:

- `0-99`: normal HUD and gameplay UI
- `100-199`: overlays, modals, menus, tutorial blockers
- `200+`: debug or special layers

Validation-aware rules:

- Keep ordinary gameplay HUD in the normal band so overlap diagnostics can detect accidental collisions.
- Put full-screen loading screens, dimmers, modal backgrounds, cinematic fades, and tutorial blockers in `100+` because they intentionally cover other UI.
- Do not move normal action buttons into `100+` just to silence overlap warnings. Fix placement instead.
- Put elements that should be checked together against normal HUD conflicts in the same band.

## DisplayOrder

Use DisplayOrder to order larger `ScreenGui` groups.

Examples:

- Main gameplay HUD ScreenGui: DisplayOrder 0
- Menu overlay ScreenGui: DisplayOrder 10 or higher
- Debug ScreenGui: DisplayOrder 50 or higher

## Mobile Safe Areas

Avoid placing custom UI over:

- Top-left system menu
- Bottom-left joystick
- Bottom-right default jump button

For custom action buttons, place them above or inward from the default jump area.

Action button clusters should usually anchor around the right action area and use enough spacing to avoid touch overlap. If an arc or cluster overlaps, prefer shifting individual buttons horizontally/rightward or adjusting offsets before pushing controls upward into the play view.

Exception: full-screen overlays such as loading screens, cinematic fades, dimmers, and tutorial blockers may intentionally cover system HUD areas. Use ZIndex `100+` for these.

## Color and Spacing

Rules:

- Use consistent padding between UI elements and the screen edge.
- Use a small, cohesive color palette instead of unrelated colors for every element.
- Pick a base/background color, text color, primary accent, secondary accent, success color, and danger color when needed.
- Keep touch buttons visually consistent, especially in action clusters.
- Use transparency carefully. Fully transparent containers are useful for layout, but their child buttons still need clear touch targets.

## Viewport Responsiveness

Current default assumption:

- Mobile viewport differences are not large enough to require multiple layout profiles.
- Do not over-engineer viewport-specific layouts unless the user asks.
- If desktop/tablet support is required, consider separate UI structures or layout profiles.

Use runtime viewport calculations only when the UI truly needs advanced responsive behavior. For most first-pass mobile UI, static scale/offset layout is easier to inspect and maintain.

