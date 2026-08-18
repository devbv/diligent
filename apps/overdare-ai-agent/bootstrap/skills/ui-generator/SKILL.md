---
name: ui-generator
description: "Use for OVERDARE Studio screen-space 2D UI work — the flat interface overlaid on the player's screen. When adding new UI, check overdare-ui-templates first — if it matches an official template (HUD, popup/modal, loading, leaderboard, boss HP, character select, result/rank, or an RPG screen: RPGIngameHUD, inventory, shop, equipment, enhancement, skill-tree, quest, attendance, reward-toast), use that skill; if not, or when editing existing UI (move/align/rename/recolor/show-hide/retext), handle it here directly. Covers menus, action buttons, health/stamina/cooldown bars, scoreboards, quick slots, popups, toasts, overlays, and UI_ELEMENTS/worldAsset UI import. Not for decorating the 3D world (BillboardGui/SurfaceGui, nameplates, signs, surface images/decals), non-UI gameplay, physics, backend, 3D/model placement, or ActionSequencer/PvP TPA unless the task clearly includes screen UI."
---

# ui-generator

Build, adjust, and integrate **screen-space 2D UI** in OVERDARE Studio — the flat interface overlaid on the player's screen: menus, HUDs, bars, buttons, popups, quick slots, toasts. Also imports and adjusts `UI_ELEMENTS` worldAsset packs. The goal is visible, mobile-friendly UI that can be inspected in Studio and play-tested.

**Scope:** this skill is 2D screen UI only. It does **not** decorate the 3D world — no `BillboardGui`/`SurfaceGui`, nameplates over characters, in-world signs, or images/decals on part surfaces. See [Do Not Use When](#do-not-use-when).

Two creation approaches, one per reference file — see [Reference Files](#reference-files-read-on-demand):

- **Direct GUI** — build instances (`ScreenGui`, `Frame`, `TextButton`, …) for custom layouts and predictable hierarchy.
- **worldAsset import** — search and import `UI_ELEMENTS` packs when a visual style already exists.

## Gate: Check `overdare-ui-templates` First

**Run this gate when adding new UI.** If the request only edits already-built UI — changing text, icon, color, position, size, or show/hide of existing instances — skip the gate and proceed directly (read the instance, then `studiorpc_instance_upsert`). When you add UI that doesn't exist yet, run the gate first, because an official template may already cover it.

Rebuild judgment for an existing screen: keep the current skeleton and adjust it → EDIT (skip the gate, handle directly); discard the skeleton and build it from scratch → NEW (run the gate).

This skill overlaps `overdare-ui-templates`. That skill owns template selection, the `request_user_input` confirmation flow, and `user_confirmed_spec`; it calls back into `ui-generator` for the actual GUI work. So before adding new UI, resolve this gate — building a template-covered UI directly here skips the confirmation flow and is a failure.

Classify the request against the official templates. Base: `IngameHUD` (persistent HP/currency/action/menu HUD), `PopupGui` (text modal), `IconPopupGui` (icon confirm: purchase/reward/item/skill), `LoadingScreenGui`, `LeaderboardHUD`, `BossHPHUD`, `CharacterSelectGui`, `GameOverGui`, `GameDefeatGui`, `GameVictoryGui`, `GameScoreResultGui`, `GameRankResultGui`. RPG: `RPGIngameHUD` (persistent RPG HUD: HP/energy/XP/level/currency/skills/quickslots/dash), `RewardToastHUD` (in-game reward toast), `DailyAttendanceGui` (daily attendance/reward), `EquipmentGui`, `InventoryGui`, `EnhancementGui`, `ShopGui`, `SkillTreeGui`, `QuestProgressionHUD` (persistent quest tracker), `QuestGui` (quest detail).

Then branch:

- **Matches (or resembles) a template** → invoke `overdare-ui-templates` and follow it instead of starting here.
- **No template fits** → handle it here. Typical no-template cases: custom/bespoke layouts, health/stamina/cooldown bars, quick slots, message toasts, mobile action-button clusters, ad-hoc panels.
- **Mixed** → route the matching part through `overdare-ui-templates`; handle only the genuinely template-less part here.

**Loop guard:** if you arrived here because `overdare-ui-templates` already selected a template and delegated GUI execution (template + `user_confirmed_spec` already decided), do not re-run this gate or re-invoke that skill — proceed with the confirmed spec.

## Reference Files (read on demand)

The body stays lean; the detail lives here. Read the file that matches the current step.

Patterns:

| File | Read it when |
|---|---|
| `patterns/studio-tools.md` | choosing which `studiorpc_*` tool to call (get, add, update, move, delete, script), and for tool-result warnings |
| `patterns/direct-gui.md` | building UI directly from GUI instances |
| `patterns/worldasset-ui.md` | searching / importing UI from worldAsset or Asset Drawer |
| `patterns/layout-rules.md` | deciding Position, Size, AnchorPoint, TextSize, ZIndex, DisplayOrder, or mobile safe-area placement — **the source of truth for all layout numbers** |
| `patterns/script-integration.md` | wiring behavior with `LocalScript`, `Activated`, `PlayerGui` |

Templates (concrete hierarchy, sizes, and ZIndex per UI type):

| File | UI type |
|---|---|
| `templates/main-menu.md` | title / start / lobby / team-select / shop-entry / settings / pause menus |
| `templates/action-buttons.md` | attack, skill, shoot, pass, sprint, mobile action clusters |
| `templates/scoreboard.md` | scoreboards, timers, rounds, shot clocks, match state |
| `templates/health-bar.md` | health, stamina, shield, energy, cooldown, charge bars |
| `templates/popup-dialog.md` | modal dialogs, alerts, confirmations, pause panels, tutorial popups |
| `templates/quick-slot.md` | item / skill slots, inventory shortcuts, ability hotbars |
| `templates/message-toast.md` | temporary messages, objective updates, pickup notices |

When a request matches a template, read that file before implementing.

## Use When

Create, improve, import, arrange, or wire up screen-space GUI: HUDs, main/lobby/settings/pause menus, mobile action buttons (attack/skill/jump-like, 3–4 button clusters), health/stamina bars, scoreboards/timers/shot clocks/cooldowns, popups and message banners, quick slots and inventory-like panels, status panels, loading screens / dimmers / tutorial blockers / modal overlays, UI from imported worldAsset packs, and `UI_ELEMENTS` asset search.

Typical trigger phrases: "UI 만들어줘", "HUD 구성해줘", "버튼 추가해줘", "월드에셋에서 UI 가져와줘", "점수판 만들어줘", "체력바 넣어줘", "팝업 다이얼로그 만들어줘", "퀵 슬롯 만들어줘", "메인 메뉴 만들어줘", "로딩 화면 만들어줘".

## Do Not Use When

The request is mainly:

- **Decorating the 3D world** — `BillboardGui`/`SurfaceGui`, nameplates over characters, floating world labels, in-world signs/posters/keypads, or plastering images/decals/textures onto part surfaces (walls, ceilings, boards). This skill is screen-space 2D UI only; world-attached GUI and surface art are out of scope.
- Server-only gameplay rules, physics/simulation with no UI, ActionSequencer JSON (animation/collision/trigger tracks), PvP TPA code architecture (unless it explicitly includes screen UI), backend/data storage only, or art/model placement in `Workspace`.

If a task mixes UI and non-UI logic, use this skill for the screen-UI portion and coordinate the rest separately.

## Core Context

OVERDARE Studio UI is designed mobile-landscape first. Cross-cutting assumptions (layout numbers and safe-area coordinates live in `patterns/layout-rules.md`):

- Default target is mobile landscape, reference viewport about `1386 x 640`.
- Screen-space UI goes under `StarterGui`. At runtime it is copied into each player's `PlayerGui`; behavior scripts read runtime UI from `PlayerGui`.
- `UI_ELEMENTS` is the main worldAsset category for 2D UI.
- Create static layout with Studio instance tools, not runtime code. Create parents first, then children one level at a time.
- Preserve existing UI unless the user explicitly asks to replace or delete it.
- Attach new UI to the screen root and script that already own that flow. Read the owning controller/server script first, hang the UI off the existing screen root, and let that script drive it — do not spin up a competing script or a stray new `ScreenGui`. Reusing the current owner is the most reliable outcome; a new floating root is the least.
- When the user gives asset names, IDs, atlas cell offsets, or image sizes, bind them to the real properties — `Image`, `ImageRectOffset`, `ImageRectSize`, button images. Building the layout but leaving these unbound is a common, immediately-reported failure.
- Border and frame art reused at several sizes — popup backgrounds, panels, speech bubbles, button frames — needs `ScaleType = "Slice"` with `SliceCenter` in source-image pixels, not plain stretching.
- Imported assets often land under `Workspace` — move them to `StarterGui` (or the right UI parent) with `studiorpc_instance_move`.
- GUI input and camera behavior run in a `LocalScript`.
- Read and act on warnings from Studio tool results — they catch runtime layout conflicts (safe-area overlap, ZIndex band misuse) not visible in the instance tree.
- Prefer a hybrid approach when useful: build layout directly, then use worldAsset icons/panels for polish.

## Naming

Use clear, stable names so later scripts can find UI reliably. Suffix by role: `Root`, `Panel`, `Frame`, `Button`, `Label`, `Image`, `List`, `Bar`/`Fill`/`Background`.

Examples: `GameHUDRoot`, `ScoreboardPanel`, `HomeScoreLabel`, `ShotClockLabel`, `RightActionPanel`, `ShootButton`, `HealthBarBackground`, `HealthBarFill`, `PopupDialogRoot`, `MainMenuRoot`.

## Workflow

**First decide the mode — most requests are edits of UI that already exists, not new screens.** Match the procedure to the request size; running the full create flow for a small tweak wastes reads, asset searches, and script churn.

### Edit existing UI (fast path — default for most requests)

Use this when the target UI already exists and the change is: fix alignment/size/position, recolor, rename, change text or image, toggle visibility, restyle a button, or add one element into a panel that is already there. Do **not** run asset search or rebuild structure.

1. Resolve the [Gate](#gate-check-overdare-ui-templates-first).
2. Locate the target: `studiorpc_level_browse` scoped to the relevant subtree, or go straight to `studiorpc_instance_read` if you already know the path/guid. Read **only** the target instance/subtree, not the whole UI.
3. Apply the change: `studiorpc_instance_upsert` with the existing `guid` (or `_move` / `_delete`). To add a single element, create just that one child under the existing parent — no new root or panel scaffolding.
4. Only search worldAsset if the user explicitly asks for an asset you don't already have; otherwise reuse existing assets/instances.
5. If you touched a script, validate with `validatelua`. Save, then report exactly what changed.

### Create new UI (full flow — only when the screen/panel doesn't exist yet)

1. Resolve the [Gate](#gate-check-overdare-ui-templates-first).
2. Browse the current hierarchy with `studiorpc_level_browse`; find `StarterGui` and any existing UI so you don't overwrite it.
3. Find or create the UI parent — normally a `ScreenGui` under `StarterGui`.
4. Pick the approach (direct / worldAsset import / hybrid) and read the matching reference file.
5. **worldAsset:** search `assets` with `overdaresearch` (prefer `categoryId = UI_ELEMENTS`), import with `studiorpc_asset_drawer_import`, inspect the imported hierarchy, move to `StarterGui` if needed. See `patterns/worldasset-ui.md`.
6. **Direct:** create the root container first, then children one level at a time; use clear names; do not mix adds and updates in one `studiorpc_instance_upsert`. See `patterns/direct-gui.md`.
7. Apply layout per `patterns/layout-rules.md` (Position mostly Scale, Size mostly Offset, ≥24px important text, ZIndex bands, safe areas). For a specific UI type, follow its `templates/` file.
8. Add behavior only if requested — `LocalScript` + `Activated`, referencing runtime UI from `PlayerGui`; validate with `validatelua`. See `patterns/script-integration.md`.
9. Read back or browse the result and address any tool warnings.
10. Save the level, then tell the user what was created and how to test it.

## Output

Before reporting done, scan the result for the defects users actually catch: text overlap, labels overflowing their frame, elements hidden behind the wrong `DisplayOrder`/ZIndex, and collisions with the reserved joystick/jump/action regions. Most "it's broken" follow-ups are visual, not functional — a quick read-back of positions and sizes catches them. If you couldn't fully verify a visual detail, say so in the report.

When finishing, report:

- Approach used (direct / worldAsset import / hybrid).
- Created or modified hierarchy paths and important UI names.
- Any imported asset name + assetId, and any script added/modified.
- Any tool warnings or safe-area conflicts handled.
- How to visually verify the result, plus any known limitation or next step.

Example: *Created `StarterGui > ScreenGui > GameHUDRoot`; imported `Basketball Icon Pack` from `UI_ELEMENTS` and moved it under `StarterGui`; connected `ShootButton` via a `LocalScript`. Test by playing and pressing Shot.*

## Ambiguous Requests

Ask a short clarifying question before building when the UI type, target screen, or approach would significantly change the result — e.g. "게임 예쁘게 만들어줘", "UI 아무거나 넣어줘", "전체 시스템 만들어줘", "에셋 다 가져와줘", "모든 해상도 완벽 지원해줘".
