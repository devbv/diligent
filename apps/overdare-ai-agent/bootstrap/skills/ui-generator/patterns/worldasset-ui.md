# Pattern: worldAsset UI Import

Use this pattern when the user wants to use existing UI assets or when an asset pack can provide better visual quality than direct primitive GUI creation.

## When to Use

- The user explicitly asks to use worldAsset or Asset Drawer.
- The UI is icon-heavy, such as action buttons or skill buttons.
- A themed HUD, icon pack, panel, or button pack likely exists.
- The task is to upgrade visual style while preserving an existing layout.

## Relevant Category

Treat only `UI_ELEMENTS` as the main 2D UI category.

Useful subcategories may include:

- `UI_ELEMENTS_ICONS`
- `UI_ELEMENTS_HUD`

## Search Rules

Use short English noun-based queries with the asset search source.

Good queries:

- `basketball icon button`
- `sports action button`
- `health bar`
- `scoreboard hud`
- `popup panel`
- `quick slot`
- `mobile skill button`

Do not over-specify the query. Check results for:

- `assetId`
- `assetType`
- `categoryId`
- `subCategoryId`
- title
- description

Prefer assets where `categoryId` is `UI_ELEMENTS`.

## Import Workflow

1. Search candidate assets.
2. Pick one or more promising UI assets.
3. Import with Asset Drawer import.
4. Inspect the returned root GUID.
5. Read the imported hierarchy recursively.
6. If the asset imports under `Workspace`, move it under `StarterGui` or another correct UI parent.
7. Keep the imported hierarchy unless there is a strong reason to restructure.
8. Adjust Position, Size, ZIndex, DisplayOrder, and naming as needed.
9. Preserve existing user-created UI unless replacement is explicitly requested.
10. Read tool warnings after moving or adjusting the imported UI. Imported packs may have hidden or transparent touch areas that still overlap default mobile controls.

## Hybrid Use

The recommended approach is often hybrid:

- Build the overall layout directly.
- Use worldAsset UI for icons, buttons, frames, or decorative panels.
- Place imported asset UI into the existing structure or visually align it with the custom UI.

## Common Issues

### Imported UI appears under Workspace

Move it to `StarterGui`.

### Imported asset is not a full UI system

Treat it as a visual component, not a complete gameplay feature.

### Imported buttons have no behavior

Connect behavior separately with `LocalScript` and `Activated`.

### Imported layout overlaps default mobile HUD

Adjust placement to avoid system menu, joystick, and jump button areas.

### Imported UI uses a different naming style

Rename only the important integration points, such as `ShootButton`, `HealthBarFill`, or `TimerLabel`. Keep the rest of the imported hierarchy intact unless restructuring is needed.

### Imported UI looks good but has poor mobile spacing

Keep the art, but place it inside a direct GUI container with safe-area-aware `Position`, `AnchorPoint`, and `Size`.

