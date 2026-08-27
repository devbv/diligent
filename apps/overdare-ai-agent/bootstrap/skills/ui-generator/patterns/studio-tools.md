# Pattern: Studio GUI Tool Usage

Use this pattern when deciding which `studiorpc_*` tool to use for GUI work in OVERDARE Studio.

## Core Rule

GUI work should usually be done directly in Studio with instance tools, not by creating normal HUD objects at runtime with scripts.

Use scripts only when the UI needs behavior, such as button activation, visibility toggles, animations, or live text/bar updates.

---

## Tool Selection

| Task | Tool |
|---|---|
| Browse the level tree or find GUI objects | `studiorpc_level_browse` |
| Read one GUI object's properties | `studiorpc_instance_read` |
| Read a whole GUI subtree | `studiorpc_instance_read` with `recursive = true` |
| Add GUI instances | `studiorpc_instance_upsert` with `parentGuid`, `class`, `name` |
| Update existing GUI instances | `studiorpc_instance_upsert` with `guid` |
| Move GUI to another parent | `studiorpc_instance_move` |
| Delete GUI instances | `studiorpc_instance_delete` |
| Import Asset Drawer UI | `studiorpc_asset_drawer_import` |
| Add a UI behavior script | `studiorpc_script_add` |
| Read a UI behavior script | `studiorpc_script_read` |
| Edit a UI behavior script | `studiorpc_script_edit` |
| Delete a UI behavior script | `studiorpc_script_delete` |
| Validate changed UI scripts | `validatelua` |

---

## Get: Inspect Existing GUI

Use `studiorpc_level_browse` when you need the tree:

- Find `StarterGui`.
- Find existing `ScreenGui` objects.
- Check what frames, labels, and buttons already exist.
- Avoid accidentally replacing user-created UI.

Use `studiorpc_instance_read` when you need exact properties:

- `Position`
- `Size`
- `BackgroundColor3`
- `BackgroundTransparency`
- `Text`, `TextSize`, `TextColor3`
- `Image`, `PressImage`, `HoverImage`
- `ZIndex`, `Visible`, `DisplayOrder`

Use `recursive = true` when inspecting an imported UI pack or a full UI subtree.

---

## Add: Create New GUI

Use `studiorpc_instance_upsert` with `parentGuid`, `class`, and `name`.

Parent-first creation is required:

1. Create or locate `ScreenGui`.
2. Create a root frame such as `GameHUDRoot`, `MainMenuRoot`, or `PopupRoot`.
3. Create panel-level children.
4. Create labels, buttons, images, layout helpers, and constraints under those panels.

Do not create deeply nested structures in one step. Create one hierarchy level at a time so the returned GUIDs can be used as parents for the next level.

Do not mix adds and updates in the same `studiorpc_instance_upsert` call.

---

## Update: Change GUI Properties

Use `studiorpc_instance_upsert` with an existing `guid`.

Common update cases:

- Move or resize UI with `Position`, `AnchorPoint`, and `Size`.
- Change colors or transparency.
- Rename objects for clearer script access.
- Change text labels.
- Change image asset IDs.
- Adjust `ZIndex`, `DisplayOrder`, or `Visible`.

For hierarchy changes, do not use delete plus recreate. Use `studiorpc_instance_move`.

---

## Move: Change Parent Hierarchy

Use `studiorpc_instance_move` when:

- An imported UI asset appears under `Workspace` and should live under `StarterGui`.
- A panel should move under a different root frame.
- You need to reorganize UI without losing children.

Moving changes the parent-child hierarchy. It does not change the UI's `Position` property.

---

## Delete: Remove GUI

Use `studiorpc_instance_delete` only when the user clearly asks to remove something or when replacing a known temporary object.

Deletion rules:

- Confirm the exact target GUID before deleting.
- Remember that deleting a parent deletes its children.
- Preserve existing UI unless the user explicitly requests replacement or cleanup.

---

## Common GUI Classes

Screen-space UI (this skill is screen-space 2D UI only):

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
- `UIStroke`

---

## Minimal Property Patterns

### ScreenGui

Use for a full UI group under `StarterGui`.

```text
DisplayOrder: 0 for normal HUD, higher for menus/overlays
Enabled: true
```

### Frame

Use as root containers, panels, bars, dimmers, and overlays.

Important properties:

- `AnchorPoint`
- `Position`
- `Size`
- `BackgroundColor3`
- `BackgroundTransparency`
- `ClipsDescendants`
- `Visible`
- `ZIndex`
- `BorderPixelSize`

### TextButton / TextLabel

Use `TextButton` for clickable text UI and `TextLabel` for read-only text.

Important properties:

- `Text`
- `TextSize`
- `TextColor3`
- `TextWrapped`
- `TextXAlignment`
- `TextYAlignment`
- `Bold`
- All common frame layout properties

### ImageButton / ImageLabel

Use `ImageButton` for clickable image UI and `ImageLabel` for decorative or read-only images.

Important properties:

- `Image`
- `PressImage`
- `HoverImage`
- `ImageColor3`
- `ImageTransparency`
- `BackgroundTransparency`
- `ScaleType`
- `SliceCenter`
- `SliceScale`
- All common frame layout properties

Asset paths must use `ovdrassetid://[number]`.

### ScrollingFrame

Use for inventory lists, shop lists, quest lists, or any overflow content.

Common properties:

- `AutomaticCanvasSize = "Y"` for vertical lists when supported.
- `ScrollingDirection = "Y"` for vertical scrolling.
- `ScrollBarThickness` large enough for mobile readability.

### Layout Helpers

Use `UIListLayout` for simple rows or columns.

Use `UIGridLayout` for inventory grids, shop grids, or icon grids.

Use `UIAspectRatioConstraint` to keep skill buttons, item slots, and icons square.

### UIStroke

Visual decorator that adds an outline stroke to its parent GuiObject — use for button borders, panel outlines, and text emphasis. Parent it under the target GuiObject; it does not affect layout or sizing.

Important properties:

- `Color`
- `Thickness`
- `Transparency`
- `ApplyStrokeMode` (`"Contextual"` or `"Border"`)
- `BorderStrokePosition` (`"Inner"`, `"Center"`, `"Outer"`)
- `LineJoinMode` (`"Round"`, `"Bevel"`, `"Miter"`)

---

## Recommended Workflows

### Create a New HUD

1. Browse level tree and find `StarterGui`.
2. Create or reuse a `ScreenGui`.
3. Create `GameHUDRoot` as a transparent full-screen root frame.
4. Create panel-level objects: scoreboard, status panel, action panel.
5. Create labels/buttons/images under each panel.
6. Read or browse the result.
7. Save the level.

### Modify Existing UI

1. Browse or read the existing UI hierarchy.
2. Identify the target GUID.
3. Update properties with `studiorpc_instance_upsert` using `guid`.
4. Read back the changed object if the change is important.
5. Save the level.

### Connect a Button

1. Confirm the button hierarchy and name.
2. Add or edit a `LocalScript`.
3. Reference runtime UI from `PlayerGui` using `WaitForChild`.
4. Connect `Activated`.
5. Run `validatelua`.
6. Play test and check logs if needed.

---

## Tool Result Warnings

Follow warnings and suggestions returned by Studio tools.

Warnings may identify:

- Overlap with the top-left system menu.
- Overlap with the bottom-left joystick.
- Overlap with the bottom-right jump button.
- Normal HUD incorrectly placed in an overlay band.
- Touch areas overlapping even when backgrounds are transparent.

Do not ignore warnings just because the instance properties look correct.

