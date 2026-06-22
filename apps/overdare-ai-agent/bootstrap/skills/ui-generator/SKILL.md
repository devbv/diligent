---
name: ui-generator
description: "Use for OVERDARE Studio GUI work, but check overdare-ui-templates FIRST — if the request matches an official template (HUD, popup/modal, loading, leaderboard, boss HP, character select, result screens), use that skill first; use ui-generator only for non-template UI or what it cannot solve. Covers screen-space and lightweight world-space GUI: menus, action buttons, health/stamina/cooldown bars, scoreboards, quick slots, popups, toasts, overlays, nameplates, signs, and UI_ELEMENTS/worldAsset import. Not for non-UI gameplay, physics, backend, 3D placement, or ActionSequencer/PvP TPA unless the task clearly includes UI."
---

# ui-generator

## MUST: Check `overdare-ui-templates` First (Gate)

**Before doing ANY UI work in this skill, you MUST run this gate. Do not create, import, or edit a single GUI instance until the gate is resolved.**

This skill overlaps heavily with the `overdare-ui-templates` skill. When an official OVERDARE template fits the request, the template path is authoritative and MUST be used; this skill is only the GUI executor for it, or the fallback when no template fits.

**Step 1 — MUST classify the request against the official templates.**
Check whether the request corresponds to any of these `overdare-ui-templates` templates:

- `IngameHUD` — persistent HUD (HP, currency, action, menu)
- `PopupGui` — text modal (notification, warning, confirmation, announcement)
- `IconPopupGui` — icon confirmation (purchase, reward, item, skill)
- `LoadingScreenGui` — pre-entry loading (name, bar, loading text)
- `LeaderboardHUD` — top-right persistent leaderboard + "Show all" popup
- `BossHPHUD` — boss HP HUD (name, level, HP bar, text)
- `CharacterSelectGui` — character selection (scroll + Back, Go)
- `GameOverGui` — game over (time + description + 3 buttons)
- `GameDefeatGui` — defeat (description + 3 buttons)
- `GameVictoryGui` — victory (description + 3 buttons)
- `GameScoreResultGui` — personal score (my score + 3 buttons)
- `GameRankResultGui` — rank list (scroll slots + 3 buttons)

**Step 2 — MUST branch as follows. No exceptions.**

- **If the request matches (or is similar to) an official template above → you MUST invoke the `overdare-ui-templates` skill and follow it instead of starting here.** Do NOT build the matching UI directly from this skill. `overdare-ui-templates` owns template selection, the mandatory `request_user_input` confirmation flow, and `user_confirmed_spec`; it will call back into `ui-generator` for the actual GUI work.
- **If the request does NOT match any official template → handle it with this skill (`ui-generator`) as normal.** Examples of no-template cases: custom/bespoke layouts, health/stamina/cooldown bars not covered by a template, quick slots, message toasts, mobile action button clusters, world-space GUI (nameplates, signs, floating labels), and ad-hoc panels with no official template equivalent.
- **If it is a mix** (part matches a template, part does not): the matching part MUST go through `overdare-ui-templates`; only the genuinely template-less part is handled directly here.

**Step 3 — Loop guard (MUST honor).** If you arrived here because `overdare-ui-templates` already selected a template and delegated the GUI execution to `ui-generator` (template + `user_confirmed_spec` already decided), do NOT re-run this gate or re-invoke `overdare-ui-templates`. Proceed directly with the GUI work within the confirmed spec.

> MUST NOT skip this gate for speed or because the request "looks simple." Building a template-covered UI directly from `ui-generator` without going through `overdare-ui-templates` is a failure.

---

## Purpose

Build, adjust, and integrate GUI in OVERDARE Studio, primarily screen-space 2D UI with limited world-space GUI when the request is still about labels, signs, or object-attached UI. This skill covers three primary UI creation approaches:

1. Creating GUI instances directly in Studio, such as `ScreenGui`, `Frame`, `TextButton`, `ImageButton`, `TextLabel`, `ImageLabel`, `ScrollingFrame`, and layout helpers.
2. Searching and importing reusable UI assets from worldAsset / Asset Drawer, especially assets in the `UI_ELEMENTS` category, then adjusting their placement, hierarchy, and behavior.
3. Creating lightweight world-space GUI, such as nameplates, floating labels, simple floating bars, or signs, when the requested result is still GUI rather than 3D model placement.

Use this skill to produce visible, mobile-friendly UI that can be inspected in Studio and tested in-game.

---

## Additional References

This skill has focused reference files. Read only the files needed for the current request.

Patterns:

- `patterns/studio-tools.md` — use when choosing which `studiorpc_*` tool to call for GUI get, add, update, delete, move, or script operations.
- `patterns/direct-gui.md` — use when creating UI directly with GUI instances.
- `patterns/worldasset-ui.md` — use when searching/importing UI from worldAsset or Asset Drawer.
- `patterns/layout-rules.md` — use when deciding Position, Size, TextSize, ZIndex, DisplayOrder, or mobile safe area placement.
- `patterns/script-integration.md` — use when connecting UI behavior with `LocalScript`, `Activated`, or `PlayerGui`.
- `patterns/world-space-gui.md` — use for `BillboardGui`, `SurfaceGui`, floating labels, nameplates, in-world signs, or object-attached UI.

Templates:

- `templates/main-menu.md` — use for title screens, start menus, lobby menus, team select, shop entry panels, settings panels, or pause-style menu layouts.
- `templates/action-buttons.md` — use for attack, skill, shoot, pass, sprint, or mobile action button clusters.
- `templates/scoreboard.md` — use for scoreboards, timers, rounds, quarters, shot clocks, or match state displays.
- `templates/health-bar.md` — use for health, stamina, shield, energy, cooldown, or charge bars.
- `templates/popup-dialog.md` — use for modal dialogs, alerts, confirmation popups, pause panels, or tutorial popups.
- `templates/quick-slot.md` — use for item slots, skill slots, inventory shortcuts, or ability hotbars.
- `templates/message-toast.md` — use for temporary messages, alerts, objective updates, or item pickup notices.

When a request matches one of these focused references, consult the relevant file before implementing.

---

## Use When

> **MUST run the `Check overdare-ui-templates First (Gate)` above before using this list.** Several items below — HUDs, Main menus, Scoreboards, Popup dialogs, and Loading screens — are covered by official `overdare-ui-templates` templates. For those you MUST go through `overdare-ui-templates` first and only fall back here if no template fits. The list below describes this skill's overall GUI scope; it is NOT a license to skip the gate.

Use this skill when the user asks to create, improve, import, arrange, or wire up GUI, including:

- HUDs
- Main menus
- Mobile action buttons
- Attack / skill / jump-like custom buttons
- 3-button or 4-button action clusters
- Health bars
- Stamina bars
- Scoreboards
- Timers
- Shot clocks or cooldown displays
- Popup dialogs
- Message banners
- Quick slots
- Inventory-like panels
- Status panels
- Main menu, lobby, team select, shop, settings, pause-style panels
- Loading screens, dimmers, tutorial blockers, and modal overlays
- BillboardGui or SurfaceGui UI such as nameplates, floating labels, object labels, or in-world signs
- UI made from imported worldAsset UI packs
- UI asset search in `UI_ELEMENTS`

Typical trigger phrases:

- "UI 만들어줘"
- "HUD 구성해줘"
- "버튼 추가해줘"
- "월드에셋에서 UI 가져와줘"
- "worldAsset UI category에서 찾아줘"
- "점수판 만들어줘"
- "체력바 넣어줘"
- "팝업 다이얼로그 만들어줘"
- "퀵 슬롯 만들어줘"
- "메인 메뉴 만들어줘"
- "로딩 화면 만들어줘"
- "머리 위 이름표 만들어줘"
- "상호작용 안내 UI 붙여줘"

---

## Do Not Use When

Do not use this skill when the request is mainly about:

- Server-only gameplay rules with no UI work
- Physics-only systems
- Ball trajectory or simulation logic with no UI
- Animation sequence timing, collision tracks, trigger tracks, or ActionSequencer JSON editing
- PvP action template code architecture unless the request explicitly mentions PvP TPA work
- Backend data storage only
- Pure art/model placement in `Workspace` that is not UI

If the task includes both UI and non-UI logic, use this skill for the UI portion and coordinate separately for gameplay/server logic.

---

## Required Context

OVERDARE Studio UI should be designed for a mobile landscape screen first.

Core assumptions:

- Use mobile landscape as the default target. A useful reference size is about `1386 x 640`.
- 2D game UI should normally be placed under `StarterGui` in Studio.
- At runtime, UI under `StarterGui` is copied into each player's `PlayerGui`; behavior scripts should usually look up runtime UI from `PlayerGui`.
- `UI_ELEMENTS` worldAsset category should be treated as the main source for 2D UI assets.
- GUI and camera-related behavior should run in a `LocalScript`.
- Static UI layout should usually be created with Studio instance tools instead of runtime code.
- Parent UI containers should be created first, then children one level at a time.
- Existing UI should be preserved unless the user explicitly asks to replace or delete it.
- Imported UI assets may arrive under an unexpected parent, often `Workspace`; move them to an appropriate UI parent such as `StarterGui` when needed.
- Follow warnings and suggestions returned by Studio tool results. Those warnings may reflect runtime layout conflicts that are not obvious from the instance tree alone.

Visual design assumptions:

- Use consistent padding between UI elements and screen edges.
- Use a cohesive color palette: choose a small set of base, accent, success, danger, and neutral colors, then reuse them consistently.
- Ensure strong contrast between text and background. If the game view behind the UI is visually busy, add a dark panel, dimmer, or translucent backing frame.
- Do not rely on keyboard input. Player actions should be reachable through on-screen touch buttons.
- Avoid placing persistent gameplay HUD directly in the center of the screen because the player character and aiming focus often sit there. Center placement is fine for modal dialogs, menus, loading screens, and short intentional overlays.
- Skill and action buttons should usually be square or circular, with large touch targets.

System-default mobile HUD safe areas:

- Avoid the top-left system menu area.
- Avoid the bottom-left joystick area.
- Avoid the bottom-right default jump button area.
- Place custom action buttons above or inward from the bottom-right default jump area.

Useful screen reference points:

- Top-center HUD: `Position = (0.5, 0)`, `AnchorPoint = (0.5, 0)`, with about `18px` Y offset.
- Left safe status area: `Position = (0, 0.4)`, `AnchorPoint = (0, 0.5)`, with about `40px` X offset.
- Bottom-center safe area: `Position = (0.5, 1)`, `AnchorPoint = (0.5, 1)`.
- Right action area: `Position = (1, 0.5)`, `AnchorPoint = (0.5, 0.5)`, with about `-230px` X offset.
- Default jump button reference: approximately `Position = (1, 1)`, `AnchorPoint = (0.5, 0.5)`, `Offset = (-230px, -160px)`, `Size = 180px x 180px`.

---

## UI Creation Approaches

### Approach A: Direct GUI Creation

Use direct GUI creation when:

- The user needs a custom layout.
- The user requests a scoreboard, HUD, popup, quick slot, or menu structure.
- There is no suitable worldAsset UI pack.
- The UI must follow strict safe-area placement.
- The UI needs clean naming and predictable hierarchy for later scripting.

Common Studio tools:

- `studiorpc_level_browse` to inspect hierarchy.
- `studiorpc_instance_read` to inspect GUI properties.
- `studiorpc_instance_upsert` to add or update GUI instances.
- `studiorpc_instance_move` to reparent imported or existing UI.
- `studiorpc_instance_delete` to remove UI when explicitly requested.
- `studiorpc_script_add`, `studiorpc_script_edit`, `studiorpc_script_read`, and `studiorpc_script_delete` for UI behavior scripts.
- `validatelua` after script changes.

Tool usage rules:

- Use `studiorpc_level_browse` first to find `StarterGui`, existing `ScreenGui`, and any existing custom UI.
- Use `studiorpc_instance_read` when exact properties or recursive children are needed.
- Do not mix new-instance adds and existing-instance updates in the same `studiorpc_instance_upsert` call.
- Use `studiorpc_instance_move` for hierarchy/parent changes; do not delete and recreate UI just to move it.
- Use `studiorpc_instance_delete` only after confirming the deletion target, because deleting a parent removes its children.
- Read tool warnings and layout suggestions before continuing.

Common GUI classes:

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
- `BillboardGui`
- `SurfaceGui`

### Approach B: worldAsset / Asset Drawer UI Import

Use worldAsset import when:

- The user asks to use existing assets.
- A UI template or icon pack is likely available.
- The UI type is common, such as action buttons, icon packs, HUD elements, or themed panels.
- A visual style is more important than building primitive UI from scratch.

Search rules:

- Search assets with `overdaresearch` source `assets`.
- Prefer assets whose `categoryId` is `UI_ELEMENTS`.
- Treat `UI_ELEMENTS` as the relevant 2D UI category.
- Favor assets with subcategories like `UI_ELEMENTS_ICONS` or `UI_ELEMENTS_HUD` when available.
- Use short noun-style asset queries such as:
  - `basketball button icon`
  - `sports HUD`
  - `health bar`
  - `scoreboard`
  - `quick slot`
  - `popup panel`

Import rules:

- Import worldAsset UI with `studiorpc_asset_drawer_import`.
- After import, inspect the returned GUID with `studiorpc_instance_read`.
- If the imported UI appears under `Workspace`, move it under `StarterGui` or another proper UI parent.
- Keep the original imported hierarchy unless there is a clear reason to reorganize.
- Do not delete the user's existing custom UI unless explicitly requested.
- When replacing direct GUI buttons with asset buttons, preserve clear names or rename carefully.

### Approach C: World-Space GUI

Use world-space GUI when:

- The user asks for labels, nameplates, floating health bars, interaction hints, shop signs, object labels, or signs attached to a world object.
- The requested object is still UI/text/image information, not a 3D model or environment prop.

Common world-space GUI classes:

- `BillboardGui` for camera-facing UI such as nameplates or floating labels.
- `SurfaceGui` for UI drawn on a part face, such as a signboard, poster, keypad, or wall panel.

Keep normal HUD under `StarterGui`; use world-space GUI only when the UI is intentionally attached to something in the world.

---

## Layout Rules: Position and Size

`Position` and `Size` use UDim2-style values with four components:

- X Scale
- X Offset
- Y Scale
- Y Offset

Meaning:

- `Scale` is a relative value, normally between `0` and `1`.
- `Offset` is an absolute pixel value.

### Position Rules

Default strategy:

- Define and control `Position` primarily with `Scale`.
- Use `Offset` as padding, margin, or fine adjustment inside the viewport.
- Avoid building whole layouts using only large Offset values.

Examples:

- Top-center scoreboard: use X scale around `0.5` and `AnchorPoint.X = 0.5`.
- Right-side action buttons: use X scale near `1`, with negative X offset for margin.
- Left-side status panel: use X scale near `0`, with positive X offset for margin.

### Size Rules

Default strategy:

- Define `Size` primarily with `Offset` for most concrete UI elements.
- Use `Scale` for intentionally relative sizes such as full width, 100%, half, one-third, or panels that should stretch with parent size.
- Image-based UI, icon packs, and image-dependent UI should usually use Offset-based sizes to preserve visual fidelity.

Examples:

- Fixed action button: Offset size such as 84x84 or 100x100.
- Full-screen root frame: Scale size `1, 0, 1, 0`.
- Half-width panel: Scale X `0.5`, Offset as needed.

### Viewport Responsiveness

For current mobile-first work:

- Do not over-optimize for many viewport classes unless the user asks.
- Mobile device sizes are assumed to be similar enough for the first implementation.
- If desktop, tablet, or very different viewport classes must be supported, consider creating separate UI structures or layout profiles instead of endlessly adjusting one layout.

Use viewport calculations only when needed:

- `workspace.CurrentCamera.ViewportSize` gives the current client screen size in a `LocalScript`.
- Use this for advanced responsive layout or pixel-to-scale conversion only when requested.

---

## Text Rules

Text should remain readable on mobile.

Rules:

- Use absolute text sizes rather than relying only on automatic scaling.
- Minimum readable mobile text size should generally be `24px` or larger for important labels and buttons.
- Secondary labels may be smaller only if readability remains acceptable.
- Use `TextWrapped` when long text may exceed its box.
- Avoid emoji and special Unicode symbols because rendering may be inconsistent.
- Maintain strong contrast between text and background.

Recommended sizes:

- Main title: 32px or larger
- Important button text: 24px or larger
- Score/time numbers: 28px or larger when central to gameplay
- Secondary labels: 18px to 22px only when not critical

---

## Layering Rules: ZIndex and DisplayOrder

UI hierarchy is controlled visually by `ZIndex` and, for GUI groups, by `DisplayOrder`.

Rules:

- Use `ZIndex` to order elements inside a GUI group.
- Use `DisplayOrder` to order larger `ScreenGui` groups.
- Keep ZIndex in clear bands:
  - `0-99`: normal HUD / gameplay UI
  - `100-199`: intentional overlays such as menus, modal popups, loading screens, tutorial blockers
  - `200+`: debug or special layers
- Avoid mixing unrelated UI layers in the same ZIndex range without reason.
- Keep ordinary gameplay HUD elements in the normal band so overlap diagnostics can catch accidental collisions.
- Do not move normal action buttons into the overlay band just to silence overlap warnings; fix the layout instead.
- Full-screen loading screens, modal dimmers, cinematic fades, and tutorial blockers may intentionally cover the whole screen, but should use the overlay band `100+`.

Typical examples:

- Gameplay HUD root: ZIndex 1-30
- Button labels/icons: parent ZIndex + 1
- Menu overlay: ZIndex 120+
- Modal dimmer: ZIndex 100
- Modal content: ZIndex 110+

---

## UI Type Templates

> **Gate reminder:** Some types below (Main Menu, Scoreboard, Popup Dialog, and HUD-style layouts) overlap official `overdare-ui-templates` templates. If the request matches an official template you MUST handle it through `overdare-ui-templates` first; the styles below apply only to non-template UI, or as the GUI executor once `overdare-ui-templates` has delegated to this skill.

When creating UI, choose a template style based on the UI type.

### Main Menu / Lobby Menu

Used for title screens, start menus, lobby menus, team select, shop entry, settings panels, pause-style menus, or mode selection screens.

Default approach:

- Direct GUI creation is usually best for predictable button names and page hierarchy.
- Use worldAsset panels, icons, or decorative frames when visual polish matters.
- Menus may use the center of the screen because they are intentional overlays.
- Use overlay ZIndex band `100-199` when the menu blocks gameplay or dims the screen.
- Use normal HUD band `0-99` only for non-blocking lobby UI.

### Action Buttons

Used for attack, skill, pass, shoot, sprint, interact, or custom mobile controls.

Default approach:

- Prefer worldAsset icon packs from `UI_ELEMENTS` when available.
- Place custom buttons above or inward from the default jump button area.
- A strong default anchor is the right action area: `Position = (1, 0.5)`, `AnchorPoint = (0.5, 0.5)`, `Offset = (-230px, 0px)`.
- Arrange multiple action buttons in an arc or compact cluster with enough spacing.
- If action buttons overlap, first adjust the cluster horizontally/rightward or individual button offsets before pushing controls upward into important view space.
- Do not rotate action buttons.
- Use fixed Offset sizes for image buttons.
- Use `UIAspectRatioConstraint` for square/circular buttons if needed.
- Connect behavior with `LocalScript` and `Activated`.

Common structures:

- 3-button cluster
- 4-button cluster
- Primary large button + smaller secondary buttons

### Health / Stamina Bar

Default approach:

- Direct GUI creation is usually better.
- Use a background `Frame` and fill `Frame`.
- Use Scale X for fill amount.
- Use fixed Offset height for readability.

### Scoreboard / Timer

Default approach:

- Direct GUI creation is usually better.
- Place at top center.
- Use `AnchorPoint.X = 0.5` and `Position.X.Scale = 0.5`.
- Use high-contrast text.
- Keep away from top-left system menu.

### Popup Dialog

Default approach:

- Direct GUI creation or imported panel asset depending on style needs.
- Use overlay ZIndex band `100-199`.
- Consider a dim background frame.
- Center the dialog with `AnchorPoint = 0.5, 0.5` and `Position = 0.5, 0, 0.5, 0`.

### Quick Slot

Default approach:

- Direct GUI creation for predictable layout.
- Use fixed icon sizes with consistent spacing.
- Use `UIListLayout` or manual positioning depending on required precision.
- Avoid default joystick and jump areas.

### Message / Toast

Default approach:

- Direct GUI creation.
- Position near upper-middle or center-lower safe area.
- Use ZIndex above normal HUD but below modal overlays when possible.

### World-Space GUI

Default approach:

- Use `BillboardGui` for camera-facing labels such as nameplates, floating interaction labels, quest markers, or floating health bars.
- Use `SurfaceGui` for UI drawn on a part face, such as signs, posters, shop boards, or wall panels.
- Keep normal gameplay HUD under `StarterGui`; use world-space GUI only when the UI should be attached to a world object.
- Use large, high-contrast text and distance limits for mobile readability.

---

## Workflow

Follow this workflow for UI tasks.

1. Save or preserve current work when appropriate.
2. Inspect current hierarchy with `studiorpc_level_browse`.
3. Find or create the proper UI parent:
   - Screen-space UI usually goes under `StarterGui`.
   - World-space GUI usually goes under or onto the target `Part` or `Model`.
4. Decide creation approach:
   - Direct GUI creation
   - worldAsset `UI_ELEMENTS` import and adjustment
   - World-space GUI with `BillboardGui` or `SurfaceGui`
   - Hybrid approach
5. If using assets:
   - Search `assets` with `overdaresearch`.
   - Prefer `categoryId = UI_ELEMENTS`.
   - Import with `studiorpc_asset_drawer_import`.
   - Inspect imported hierarchy.
   - Move to `StarterGui` if needed.
6. If creating directly:
   - Create parent container first.
   - Create children one level at a time.
   - Use clear names.
   - Do not mix adds and updates in one upsert call.
7. Apply layout rules:
   - Position mostly Scale.
   - Size mostly Offset.
   - Text absolute size, usually 24px or larger for important mobile text.
   - ZIndex and DisplayOrder organized.
   - Normal HUD avoids default system controls and persistent center-screen obstruction.
   - Overlay UI uses ZIndex 100+ only when it intentionally covers other UI.
8. Add or update behavior only if requested:
   - Use `LocalScript` for GUI input.
   - Use `Activated` for button activation.
   - Validate with `validatelua` after script changes.
9. Read or browse the result when useful and address any warnings from tool output.
10. Save the level after meaningful changes.
11. Tell the user where the UI was created and how to test it.

---

## Naming Conventions

Use clear, stable names so later scripts can find UI elements reliably.

Recommended suffixes:

- Root containers: `Root`
- Main panels: `Panel`
- Frames: `Frame`
- Buttons: `Button`
- Text labels: `Label`
- Image labels: `Image`
- Lists: `List`
- Bars: `Bar`, `Fill`, `Background`

Examples:

- `GameHUDRoot`
- `ScoreboardPanel`
- `HomeScoreLabel`
- `ShotClockLabel`
- `RightActionPanel`
- `ShootButton`
- `HealthBarBackground`
- `HealthBarFill`
- `PopupDialogRoot`
- `MainMenuRoot`
- `NameplateBillboard`
- `InteractionSurfaceGui`

---

## Script Integration Rules

Use scripts only when behavior is required.

Rules:

- GUI input and camera operations must be in `LocalScript`.
- Server gameplay validation should be in `Script`.
- Use `Activated` for `TextButton` and `ImageButton` activation.
- Do not build UI behavior around keyboard keys; provide touch buttons for player actions.
- Use `WaitForChild` when locating UI copied from `StarterGui` to `PlayerGui`.
- For button action functions or dynamic content updates, first reference the actual runtime GUI from `PlayerGui` by walking the hierarchy with `WaitForChild`.
- Validate changed scripts with `validatelua`.
- Temporary `print()` logs are acceptable for verification but should be removed or minimized after confirmation.

Common LocalScript pattern:

```lua
local Players = game:GetService("Players")

local localPlayer = Players.LocalPlayer
local playerGui = localPlayer:WaitForChild("PlayerGui")

local screenGui = playerGui:WaitForChild("ScreenGui")
local button = screenGui:WaitForChild("Button")

local function OnButtonActivated(): ()
	print("button activated")
end

button.Activated:Connect(OnButtonActivated)
```

Hierarchical GUI reference pattern for imported or nested UI:

```lua
local Players = game:GetService("Players")

local localPlayer: Player = Players.LocalPlayer
local playerGui = localPlayer:WaitForChild("PlayerGui")

local basketballIconPack = playerGui:WaitForChild("BasketballIconPack")
local basketballFrame = basketballIconPack:WaitForChild("BasketballFrame")
local actionFrame = basketballFrame:WaitForChild("ActionFrame")
local shotButton = actionFrame:WaitForChild("ShotButton")

local function OnShotButtonActivated(): ()
	print("shot")
end

shotButton.Activated:Connect(OnShotButtonActivated)
```

---

## Asset Search and Import Guidance

When searching worldAsset UI assets:

1. Search with short, direct English nouns.
2. Check `categoryId` and prefer `UI_ELEMENTS`.
3. Check `subCategoryId` when available.
4. Import only promising candidates.
5. Inspect hierarchy immediately after import.
6. Move imported UI to the correct UI service if necessary.
7. Keep the original custom UI unless the user requests replacement.

Recommended queries:

- `basketball icon button`
- `sports action button`
- `health bar`
- `scoreboard hud`
- `popup panel`
- `quick slot`
- `mobile skill button`

---

## Output Requirements

When finishing a UI task, report:

- Which approach was used:
  - Direct GUI creation
  - worldAsset import
  - World-space GUI
  - Hybrid
- Created or modified hierarchy paths.
- Important UI names.
- Any imported asset name and assetId.
- Any script added or modified.
- Any tool warnings or safe-area conflicts that were handled.
- How the user can visually verify the result.
- Any known limitations or next recommended step.

Example final summary:

- Created `StarterGui > ScreenGui > GameHUDRoot`.
- Imported `Basketball Icon Pack` from `UI_ELEMENTS` and moved it under `StarterGui`.
- Connected `ShotButton` with a `LocalScript` in `StarterPlayerScripts`.
- Test by playing the game and pressing the Shot button.

---

## Good Requests

- "농구게임 HUD 만들어줘"
- "UI_ELEMENTS에서 농구 버튼 에셋 찾아서 적용해줘"
- "기존 UI 유지하면서 worldAsset 버튼만 가져와줘"
- "상단 중앙 점수판 만들어줘"
- "체력바랑 스태미나바 추가해줘"
- "팝업 다이얼로그 UI 만들어줘"
- "ShootButton 누르면 로그 찍게 연결해줘"
- "메인 메뉴랑 Play 버튼 만들어줘"
- "캐릭터 머리 위 이름표 UI 만들어줘"
- "가게 표지판에 SurfaceGui 붙여줘"

---

## Bad or Ambiguous Requests

These need clarification before implementation:

- "게임 예쁘게 만들어줘"
- "UI 아무거나 넣어줘"
- "전체 시스템 만들어줘"
- "에셋 다 가져와줘"
- "모든 해상도 완벽 지원해줘"

Ask a short question when the UI type, target screen, or desired approach would significantly change the result.

---

## Additional Recommendations

- Prefer a hybrid approach when useful: build layout directly, then use worldAsset icons or panels for polish.
- Keep UI visible and testable after each meaningful change.
- Avoid placing custom UI over default mobile controls.
- Use strong contrast and large touch targets.
- Create stable hierarchy names before wiring scripts.
- Avoid dynamic runtime UI creation unless the UI truly needs to be generated during gameplay.
