# Pattern: World-Space GUI

Use this pattern for GUI that appears in the 3D world rather than fixed on the player's screen.

Examples:

- Character nameplates
- Floating health bars
- Interaction labels such as `Tap to Open`
- Shop or NPC labels
- Object labels
- In-world signs
- Wall posters or keypad screens

---

## Choose the Right Class

### BillboardGui

Use `BillboardGui` when the UI should face the camera.

Good for:

- Nameplates above characters
- Floating object labels
- Quest markers
- Interaction prompts
- Floating health bars

Typical children:

- `Frame`
- `TextLabel`
- `ImageLabel`

### SurfaceGui

Use `SurfaceGui` when the UI should be drawn on a part face.

Good for:

- Signs
- Posters
- Scoreboards mounted in the world
- Shop boards
- Keypad panels

Typical children:

- `Frame`
- `TextLabel`
- `ImageLabel`
- `TextButton` only if interaction is intentionally supported and tested

---

## Parent and Adornee Rules

World-space GUI must be attached to or associated with a world object.

Common patterns:

- Put `BillboardGui` under the object or part it labels.
- Put `SurfaceGui` under the part whose face should display the UI.
- Set `Face` on `SurfaceGui` to the correct side, such as `Front`, `Back`, `Left`, `Right`, `Top`, or `Bottom`.

Keep normal screen HUD under `StarterGui`. Do not use world-space GUI for ordinary fixed HUD such as health bars, scoreboards, or action buttons unless the user specifically wants it in the world.

---

## BillboardGui Layout Rules

Useful properties:

- `AlwaysOnTop`: use carefully. It can make labels readable but may clutter the screen.
- `MaxDistance`: limit visibility so distant labels do not fill the screen.
- `Size`: use enough space for mobile readability.
- `PositionOffset` or `ExtentsOffsetWorldSpace`: lift labels above the object when needed.
- `LightInfluence`: lower values can make labels easier to read in dark scenes.

Recommended defaults:

- Use simple high-contrast text.
- Keep nameplates short.
- Avoid huge labels over the center of the screen.
- Use a translucent dark backing frame behind text.
- Use `MaxDistance` so the UI only appears when relevant.

---

## SurfaceGui Layout Rules

Useful properties:

- `Face`: choose the side of the part where the UI should render.
- `AlwaysOnTop`: usually false unless it must remain readable through clutter.
- `Brightness`: increase if the sign is too dark.
- `LightInfluence`: reduce when world lighting hurts readability.
- `ZOffset`: adjust if there is z-fighting or flicker.

Recommended defaults:

- Use large text.
- Use strong contrast.
- Keep signs simple.
- Use a dedicated flat part as the sign surface when possible.

---

## Behavior Rules

World-space GUI can be static or scripted.

Use `LocalScript` for player-local display behavior, such as showing a nearby interaction label.

Use server `Script` only for authoritative gameplay results.

If the UI is attached to a world object but triggered by player input, consider pairing it with a `ProximityPrompt` or an on-screen touch UI depending on the game's interaction design.

---

## Avoid

- Do not use `BillboardGui` for persistent screen HUD.
- Do not create huge nameplates for every object without distance limits.
- Do not use world-space buttons for core combat controls; mobile action buttons should be screen-space touch buttons.
- Do not place tiny text on signs. Mobile players need large readable text.

