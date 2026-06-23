---
name: overdare-ui-templates
description: When generating UI, first determine whether a template is appropriate. For structure confirmation, request_user_input (choice UI) is mandatory; prompting free-text input is prohibited. Adding/removing elements is prohibited before user_confirmed_spec is finalized. If appropriate, edit with ui-generator; if not possible, switch to ui-generator.
---

# OVERDARE UI Template Guide

## Core Principles

1. **Before judgment**, do not create or edit a UI instance. Complete `Required Procedure for UI Creation Requests` to the end (do not skip for speed or completeness).
2. Official templates are prioritized **only when similar** to the request. If not a fit, switch to **`ui-generator`** without forcing application (do not create a blank canvas with this skill alone).
3. Template path: keep **skeleton, layout, and frame**; GUI work **requires `ui-generator`**.
4. **Structural add/remove** (deletion, addition, button count, slot removal) is allowed **only for items explicitly stated** in `user_confirmed_spec`. Before/outside that scope, **no inference** (e.g., "notification -> 1 button", "RPG -> remove currency").
5. Before confirmation/explicit statement: keep **all default template elements**, and only **L2** (text, numbers, icons, GUI names, data, script linkage) may be changed.
6. **Position / Size / Anchor / appearance and color**: if not in the prompt or spec, do not change. Do not invade reserved areas for joystick, jump, or mobile dashboard.
7. Transformations must stay **inside frame and screen boundaries**. Do not hide overflow with `ClipsDescendants = false`. For removal, use **Destroy** (do not just disable `Visible` and leave objects).
8. Rename root `ScreenGui` and clearly purposed child GUIs **appropriately to their usage** (keep layout values).
9. **Before final response**, pass `Self-check Before Responding`. If structural add/remove was needed but done without spec, it is a failure.
10. For **fixed-choice confirmation**, use **`request_user_input` only**. Do not list options in chat and ask users to type them.

## Structural Add/Remove - User Confirmation

### Questions required (before asset addition, Destroy, or button reconfiguration)

- Popup/modal/notification/confirmation request where **button count/types** are unspecified
- Broad request like HUD/RPG/in-game where **included areas** (HP, currency, action, menu, etc.) are unspecified
- **Buttons to keep** such as Lobby / Back / Retry are unspecified
- Compared to template, the sentence does not specify what to reduce or increase

### Questions can be skipped

- Buttons/areas/removals are **already specified in the sentence** (e.g., "confirm only", "remove Lobby", "HP and currency only")
- Change **L2 only**
- Explicitly states **"use template as-is / keep default composition"**

### Questions and recording (deterministic)

1. One-line template candidate + reason (chat body).
2. Present the fixed choices below **only through the `request_user_input` tool** - **do not** enumerate as bullets/numbered lists in chat and ask for direct input with "reply example."
3. Copy `request_user_input` responses verbatim into **`user_confirmed_spec`** and edit **only within that scope**.

#### Choice UI (`request_user_input`) - Required

| Rule | Content |
|---|---|
| **Tool** | If fixed choices exist, must call **`request_user_input`**. Execute in the confirmation turn, **before** UI creation or asset addition. |
| **Prohibited** | Showing only a markdown option list and requiring **free-text input** such as "please write like below" or "reply example:". |
| **Chat** | Keep only short context (template recommendation/reason). Put the actual options in the **tool question**. |
| **Multi-select** | For fields that allow multiple selections (areas/buttons), set `allow_multiple: true`. |
| **Split** | By default, one call is allowed. **However, IngameHUD is an exception and must call `request_user_input` exactly twice** (1st: `hud_regions` only, 2nd: `hud_layout` only), showing **two separate question dialogs**. In each call, use option labels **identical** to this skill table. |
| **Skip** | If it falls under `Questions can be skipped`, proceeding without `request_user_input` is allowed. |

**IngameHUD** - enforced `request_user_input` procedure (fixed labels, exactly 2 dialogs required):

| Call order | Question id | prompt (gist) | options | allow_multiple |
|---|---|---|---|---|
| 1st (modal 1) | `hud_regions` | Areas to include | HP / Resources (gold, coin) / Actions (attack, skill) / Menu, Settings | true |
| 2nd (modal 2) | `hud_layout` | Layout | Use as-is / Slightly modify later / Directly desired composition | false |

- For IngameHUD, even if some details are specified in the sentence, **do not skip the two request_user_input calls** (exception: L2-only changes).

**PopupGui** - `request_user_input` example:

| Question id | prompt (gist) | options | allow_multiple |
|---|---|---|---|
| `popup_buttons` | Button composition | 1 Confirm button / Confirm + Cancel / Keep default 2 buttons | false |
| `popup_body` | Body format | Level number / Fixed phrase only / Include icon area | false |

(For other templates as well, move the entries from each **template-specific question examples** table into `request_user_input` options identically.)

**`user_confirmed_spec` mapping:** Record `request_user_input` `id` and selected option `label` into `keep_elements` / `remove_elements` / `content_notes`, etc., **using labels exactly as-is**. Keep applying the rule: "unselected IngameHUD regions are kept."

| Field | Content |
|---|---|
| `template` | Template name used |
| `keep_elements` | Areas/buttons to keep (if omitted, **entire template default**) |
| `remove_elements` | Elements to remove (only what user selected) |
| `add_elements` | Elements to add (only what user selected) |
| `content_notes` | L2 (phrases, icons, etc.) |

**Do not Destroy or add items that are not in `remove_elements` or `add_elements`.** Put "not needed" into `remove_elements` only when the user **selected it or explicitly stated it in a sentence**.

### Template-specific question examples (fixed items -> `request_user_input` options)

**PopupGui - "Level-up notification popup"** - use the **PopupGui `request_user_input` table** above + title phrase if needed (allow only one free-text input)

**IngameHUD - "Action game/RPG HUD"** - use the **IngameHUD `request_user_input` enforced procedure** exactly (1st `hud_regions` -> 2nd `hud_layout`)

- **Unselected regions are kept** (to delete, user must explicitly state "exclude")

### Popup/Modal layout (when adding/removing)

- After deleting buttons, **re-center alignment** (no empty gap or one-sided bias)
- Added content must stay **inside parent frame**; if space is insufficient, expand frame `Size` only within limits that do not exceed screen/reserved regions

## Required Procedure for UI Creation Requests

1. Check this skill and the **template table, exclusion criteria, and conflict priorities** below
2. Confirm candidate template using **4 similarity questions** (asset addition only after step 4)
3. **If structural add/remove is needed** -> **`request_user_input`** -> receive `user_confirmed_spec` (**until then, no Destroy or structural additions**)
4. If exclusion criteria apply, reselect or switch to `ui-generator`
5. Add assets -> GUI naming -> add/remove within **spec scope** -> L2 -> **`ui-generator`**
6. Verify reserved regions, frame, and overflow -> **self-check** -> respond (including spec and judgment)

### 4 similarity questions

- Persistent HUD vs temporary modal?
- Confirm/close vs exploration/repeated interaction?
- Text-centric vs icon/visual-centric?
- Can it fit within the same slots/regions?

## Official Templates, Selection, and Conflicts

| Template | Summary | Fit (gist) | Not fit (gist) | Asset ID |
|---|---|---|---|---|
| IngameHUD | Persistent HUD | HP, currency, action, menu | Modal, icon purchase confirmation | `ovdrassetid://32883100` |
| PopupGui | Text modal | Notification, warning, confirmation, announcement | Icon/item visuals are core | `ovdrassetid://32884100` |
| IconPopupGui | Icon confirmation | Purchase, reward, item, skill | Text only | `ovdrassetid://32883200` |
| LoadingScreenGui | Pre-entry loading | Name, bar, loading text | Persistent HUD, end/result | `ovdrassetid://32911200` |
| LeaderboardHUD | Top-right HUD | Persistent + Show all popup | One-time modal, rankings only after end | `ovdrassetid://32912100` |
| BossHPHUD | Boss HP HUD | Name, level, HP bar, text | Player HP | `ovdrassetid://32913100` |
| CharacterSelectGui | Character selection | Scroll + Back, Go | Inventory, simple confirmation | `ovdrassetid://32914100` |
| GameOverGui | Game over | Time + description + 3 buttons | Win/loss, score, ranking only | `ovdrassetid://32915100` |
| GameDefeatGui | Defeat | Description + 3 buttons | Victory, score, ranking, time are core | `ovdrassetid://32912200` |
| GameVictoryGui | Victory | Description + 3 buttons | Defeat, score, ranking | `ovdrassetid://32916100` |
| GameScoreResultGui | Personal score | My score + 3 buttons | Multi-rank list | `ovdrassetid://32916200` |
| GameRankResultGui | Rank list | Scroll slots + 3 buttons | Personal score only | `ovdrassetid://32917100` |

**3 buttons** = Lobby / Okay / Retry (add/remove only after spec).

**Conflict priority:** (1) Loading -> LoadingScreenGui (2) End/result: time->GameOverGui, win->Victory, lose->Defeat, personal score->Score, ranking->Rank (3) Persistent HUD: general->IngameHUD, leaderboard->LeaderboardHUD, boss->BossHPHUD (4) CharacterSelectGui (5) Icon-centric->IconPopupGui (6) Text modal->PopupGui

### Exclusion criteria (if any one applies -> stop using that template)

1. Usage context mismatch (forcing persistent <-> modal mix) 2. Interaction model mismatch (exploration/equipment vs confirmation only) 3. Information density overload, readability, touch usability drop 4. Requires changing group/slot semantics to fit 5. Repeating elements cannot be handled even with scroll/splitting 6. Requires reserved-region/boundary overflow or dependency on ClipsDescendants 7. Requested main function is large enough to replace template purpose

-> Reselect, switch to `ui-generator`, or ask split/priority via **`request_user_input`** (do not force-fit by inferential deletion).

## Template-specific fixed behavior (changes outside spec prohibited)

Common: structural add/remove is allowed **only after spec**. Before spec, keep default structure and the **designed Visible states** below.

| Template | Fixed behavior the agent must follow |
|---|---|
| LoadingScreenGui | Keep name, loading bar, loading text; only progress and phrase in L2 |
| LeaderboardHUD | Show all -> popup; popup default `Visible=false`; my player `PlayerName` bold + Highlight |
| BossHPHUD | Boss HP only (do not mix with player HP bar) |
| CharacterSelectGui | Scroll slots; selected item shows name/description on the right |
| GameOverGui | Can display remaining/progress time (unique) |
| GameDefeatGui / GameVictoryGui / GameScoreResultGui / GameRankResultGui | Rank: scroll slots + my player Highlight |

`IngameHUD`: in the confirmation turn, **must call `request_user_input` exactly twice** (1st `hud_regions`, 2nd `hud_layout`) to open two dialogs, then finalize spec. `Position`/`Size`/`Anchor` only when **explicitly stated/in spec**.

## Prohibited

- **Handling fixed-choice confirmation only via chat text/free-text response** (skipping `request_user_input`, inducing "reply example")
- Destroy, structural additions, button count changes, hiding unconfirmed elements without spec/explicit statement
- Creating a blank canvas or equivalent new UI without template, without similarity/fit judgment/spec
- GUI placement/modification without `ui-generator`
- Not using official template when a suitable template exists
- Arbitrary coordinate/anchor/appearance changes without explicit statement/spec, reserved-region invasion, ClipsDescendants concealment

## Self-check Before Responding · Response Format

**Do not give a final completion response before passing.**

- [ ] If add/remove is needed, perform Destroy/addition **only after receiving spec via `request_user_input`** (if confirmed only by chat list/"reply example", **fail**)
- [ ] For IngameHUD, in confirmation turn, was `request_user_input` executed **exactly twice** (1st `hud_regions`, 2nd `hud_layout`)?
- [ ] Actual add/remove ⊆ `remove_elements` ∪ `add_elements` (everything else kept)
- [ ] No coordinate/anchor/appearance changes without spec/explicit statement
- [ ] Frame/reserved-region/ClipsDescendants compliance
- [ ] Record template, exclusion, `ui-generator`, spec (or "already explicit in prompt")

**A. Confirmation turn (before creation):** template candidate (1-2 chat sentences) + **fixed choices via `request_user_input`** -> reflect response in spec, then create (do not put options only in chat and collect input there)

**B. Completion turn:** 1 line each for structure/purpose | confirmation and `user_confirmed_spec` | template and asset ID | add/remove (remove/add/none) | L2, naming, boundaries, reserved regions | no inferential add/remove
