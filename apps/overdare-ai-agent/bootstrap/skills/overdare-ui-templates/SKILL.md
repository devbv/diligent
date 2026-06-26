---
name: overdare-ui-templates
description: When generating UI, first determine template fit. Structure confirmation requires request_user_input (choice UI); do not prompt free-text input. Element add/remove forbidden until user_confirmed_spec is finalized. If fit, edit via ui-generator; if not, switch to ui-generator.
---

# OVERDARE UI Template Guide

## Core Principles

1. **Before judgment**, do not create or edit UI instances. Complete `Required procedure for UI generation requests` in full (do not skip for speed or completeness).
2. Use official templates first only when they are **similar** to the request. If they do not fit, switch to **`ui-generator`** without forcing a match (this skill alone must not produce UI on a blank canvas).
3. Template path: preserve **skeleton, layout, and frames**; GUI work **requires `ui-generator`**.
4. **Structural changes** (delete, add, button count, slot removal) are allowed only for items **explicitly listed in `user_confirmed_spec`**. Before that and outside that scope, **no inference** (e.g., “notification → one button”, “RPG → remove currency”).
5. Before confirmation or explicit specification: keep **all default template elements**, and change only **L2** (text, numbers, icons, GUI names, data, script bindings).
6. **Position / Size / Anchor / appearance / colors**: do not change unless present in the prompt or spec. Do not encroach on **reserved areas** for joystick, jump, or mobile dashboard.
7. Variations stay **within frames and screen boundaries**. Do not hide overflow with `ClipsDescendants = false`. Removal uses **Destroy** (do not leave elements with `Visible` turned off only).
8. Rename the root `ScreenGui` and clearly role-defined child GUIs **to match their purpose** (keep layout values).
9. **Before a completion response**, pass `Pre-response self-check`. Failure if structural add/remove was needed but proceeded without spec.
10. **Fixed-choice confirmation** uses **`request_user_input` only**. Do not list choices in chat and ask the user to type a reply.

## Structural Add/Remove — User Confirmation

### Questions Required (before asset add · Destroy · button reconfiguration)

- Popup · modal · notification · confirmation with **button count or types** not specified
- Broad requests for HUD · RPG · in-game UI with **included regions** (HP, currency, actions, menu, etc.) not specified
- Buttons to keep such as Lobby / Back / Retry not specified
- **Targets to reduce or expand** vs. the template not stated in the request

### Questions May Be Skipped

- Buttons · regions · removal targets **already specified in the request** (e.g., “confirm only”, “remove Lobby”, “HP and currency only”)
- **L2-only** changes
- **“Keep template as-is / maintain default layout”** explicitly stated

### Questions · Recording (Deterministic)

1. One-line template candidate + reason (in chat body).
2. Present the **fixed choices** below **only via the `request_user_input` tool** — **do not list bullets or numbered options in chat and ask the user to type a reply or give “reply examples”**.
3. Record `request_user_input` responses **verbatim** in **`user_confirmed_spec`** and edit **only within that scope**.

#### Choice UI (`request_user_input`) — Required

| Rule | Content |
|---|---|
| **Tool** | When fixed choices exist, you must call **`request_user_input`**. Run before UI creation or asset add on the confirmation turn. |
| **Forbidden** | Showing choices only as a markdown list and asking the user to “type like below”, “reply example:”, etc. — **requiring free-text input**. |
| **Chat** | Short context only (template recommendation · reason). Put choice item bodies in the **tool question**. |
| **Multiple questions** | If there are **2 or more questions**, include **all** in the `questions` array in **one `request_user_input` call** and show the question UI **at once**. **No sequential calls** (no second call after first response · confirmation). |
| **Multiple selection** | Use `allow_multiple: true` for items that allow multiple regions · buttons. |
| **IngameHUD · RPGIngameHUD** | Apply the **multiple questions** rule above. **One call** with `hud_regions` + `hud_layout` **shown together**. **First-choice options follow the template-specific table** (do not mix IngameHUD and RPGIngameHUD options). |
| **Skip** | If `Questions May Be Skipped` applies, you may proceed without `request_user_input`. |

**IngameHUD** — mandatory `request_user_input` procedure (fixed labels, **2 question panels shown together**):

**Default layout:** HP bar · menu/settings · 2 currency slots · 5 attack buttons

**One `request_user_input` call** — put both below in `questions` and show **together**:

| Question id | prompt (summary) | options | allow_multiple |
|---|---|---|---|
| `hud_regions` | Regions to include | HP / resources (gold · crystal ×2) / actions (5 attacks) / menu · settings | true |
| `hud_layout` | Layout | use as-is / tweak later / custom layout | false |

- For IngameHUD, **do not skip the 2 request_user_input calls above** even if the request partially specifies regions (exception: L2-only change requests). **No 2 sequential calls**.

**RPGIngameHUD** — mandatory `request_user_input` procedure (fixed labels, **2 question panels shown together**; **separate from IngameHUD**):

**Default layout:** HP bar · energy bar · XP bar · level · 2 currency slots · 3 skill buttons · 2 quickslot buttons · dash button (**no menu · settings**)

**One `request_user_input` call** — put both below in `questions` and show **together**:

| Question id | prompt (summary) | options | allow_multiple |
|---|---|---|---|
| `hud_regions` | Regions to include | HP / energy (energy bar) / XP · level / resources (gold · crystal ×2) / skills (3) / quickslots (2) / dash | true |
| `hud_layout` | Layout | use as-is / tweak later / custom layout | false |

- For RPGIngameHUD, **do not skip the 2 request_user_input calls above** even if the request partially specifies regions (exception: L2-only change requests). **No 2 sequential calls**.
- Do **not** offer menu · settings in RPGIngameHUD `hud_regions`. Do **not** offer energy · XP · level · quickslots · dash in IngameHUD `hud_regions`.

**PopupGui** — `request_user_input` example (**one `request_user_input` call**, 2 questions **shown together**):

| Question id | prompt (summary) | options | allow_multiple |
|---|---|---|---|
| `popup_buttons` | Button layout | confirm only / confirm + cancel / keep default 2 | false |
| `popup_body` | Body form | level number / fixed text only / include icon area | false |

(For other templates, move items from the **template-specific question examples** table into `request_user_input` options the same way. **If 2+ questions, one call · show together**.)

**`user_confirmed_spec` mapping:** Record `request_user_input` `id` and selected `label` **verbatim** in `keep_elements` / `remove_elements` / `content_notes`, etc. The rule “unselected IngameHUD · RPGIngameHUD regions are kept” still applies.

| Field | Content |
|---|---|
| `template` | Template name in use |
| `keep_elements` | Regions · buttons to keep (if omitted, **full template default**) |
| `remove_elements` | Elements to delete (only what the user chose) |
| `add_elements` | Elements to add (only what the user chose) |
| `content_notes` | L2 (copy · icons, etc.) |

**Do not Destroy or add items not in `remove_elements` · `add_elements`.** Put “not needed” in `remove_elements` only when the user **chose or stated it in text**.

### Template-Specific Question Examples (fixed items → `request_user_input` option)

**PopupGui — “Level-up notification popup”** — use the **PopupGui `request_user_input` table** above + title copy if needed (only one free-text field allowed)

**IngameHUD — “Action game HUD”** — use the **IngameHUD mandatory `request_user_input` procedure** as-is (`hud_regions` + `hud_layout` **one call · shown together**)

**RPGIngameHUD — “RPG in-game HUD”** — use the **RPGIngameHUD mandatory `request_user_input` procedure** as-is (`hud_regions` + `hud_layout` **one call · shown together**). For RPG genre · HP · energy · XP · level · currency · skills · quickslots · dash requests, prefer this template over IngameHUD.

- **Unselected regions are kept** (user must explicitly say “exclude” to delete)

**DailyAttendanceGui — “Attendance / daily reward”**

- The template default is **days 1–31** slots, but if the request differs only in **day count** while the purpose is attendance · reward claim (Claimed/Claim/Locked), **prefer DailyAttendanceGui**. Do **not** exclude the template or build anew with `ui-generator` solely because day count differs.
- If day count is **not** in the prompt, confirm with `request_user_input`.

| Question id | prompt (summary) | options | allow_multiple |
|---|---|---|---|
| `attendance_days` | Attendance day count | 7 days / 14 days / 31 days (default) | false |

- If day count is **already stated** in the prompt, the `request_user_input` above may be skipped. Record `N days` (e.g., `7 days`) in `user_confirmed_spec` `content_notes`.

**DailyAttendanceGui — slot (day) count variation rules**

| Situation | Handling |
|---|---|
| Requested days **< 31** | **Destroy** excess slots (do not only set `Visible` off). Renumber remaining slot day labels · L2 to 1~N |
| Requested days **= 31** | Keep slot count; change L2 · state only |
| Requested days **> 31** | **Duplicate** existing slots to add more. Keep slot structure · Claimed/Claim/Locked · `SlotBorderImage` (today’s day) rules |
| Common | Vary inside vertical scroll · parent frame. Keep existing slot Position/Size/Anchor **pattern** (no arbitrary coordinates without explicit spec). Do not hide overflow with `ClipsDescendants` |

### Popup · Modal Layout (when adding/removing)

- After button removal, **re-center** (no empty gaps · one-sided clustering)
- Added content stays **inside the parent frame**; if insufficient, expand frame `Size` only within screen · reserved-area limits

## Required Procedure for UI Generation Requests

1. Read this skill · **template table · exclusion criteria · conflict priority** below
2. Lock candidate template with **4 similarity questions** (asset add only after step 4)
3. If **structural add/remove needed** → **`request_user_input`** → receive `user_confirmed_spec` (**no Destroy · structural add until then**)
4. If **exclusion criteria** apply, reselect or use `ui-generator`
5. Asset add → GUI names → add/remove within **spec scope** → L2 → **`ui-generator`**
6. Verify reserved areas · frames · overflow → **self-check** → respond (include spec · judgment)

### 4 Similarity Questions

- Persistent HUD vs. temporary modal?
- Confirm · close vs. browse · repeat interaction?
- Text vs. icon · visual focus?
- Can it fit in the same slot · region?

## Official Templates · Selection · Conflicts

| Template | Summary | Fit (summary) | Poor fit (summary) | Asset ID |
|---|---|---|---|---|
| IngameHUD | Persistent HUD | HP · 2 currency · 5 attacks · menu/settings | Modal, RPG (energy · XP · quickslots) | `ovdrassetid://32883100` |
| PopupGui | Text modal | Alert · warning · confirm · notice | Icon · item visual focus | `ovdrassetid://32884100` |
| IconPopupGui | Icon confirm | Purchase · reward · item · skill | Text only | `ovdrassetid://32883200` |
| LoadingScreenGui | Pre-entry loading | Name · bar · loading text | Persistent HUD, end · result | `ovdrassetid://32911200` |
| LeaderboardHUD | Top-right HUD | Persistent + Show all popup | One-off modal, post-game rank only | `ovdrassetid://32912100` |
| BossHPHUD | Boss HP HUD | Name · level · HP bar · text | Player HP | `ovdrassetid://32913100` |
| CharacterSelectGui | Character select | Scroll + Back · Go | Inventory, simple confirm | `ovdrassetid://32914100` |
| GameOverGui | Game over | Time + description + 3 buttons | Win/loss · score · rank only | `ovdrassetid://32915100` |
| GameDefeatGui | Defeat | Description + 3 buttons | Victory · score · rank · time focus | `ovdrassetid://32912200` |
| GameVictoryGui | Victory | Description + 3 buttons | Defeat · score · rank | `ovdrassetid://32916100` |
| GameScoreResultGui | Personal score | My score + 3 buttons | Multi-player rank list | `ovdrassetid://32916200` |
| GameRankResultGui | Rank list | Scroll slots + 3 buttons | Personal score only | `ovdrassetid://32917100` |

**3 buttons** = Lobby · Okay · Retry (add/remove only after spec).

### RPG Templates

| Template | Summary | Fit (summary) | Poor fit (summary) | Asset ID |
|---|---|---|---|---|
| RPGIngameHUD | Persistent in-game HUD | HP · energy · XP · level · 2 currency · 3 skills · 2 quickslots · dash | Modal, menu/settings, general action HUD | `ovdrassetid://35631100` |
| RewardToastHUD | In-game reward toast | Attendance · quest · achievement rewards (vertical, max 6 slots) | Persistent HUD, modal confirm | `ovdrassetid://35632100` |
| DailyAttendanceGui | Days 1–31 attendance (day count varies via slot add/remove) | Daily attendance · reward claim (Claimed/Claim/Locked). **Includes requests with only different day count (7 · 14 · 31, etc.)** | Inventory, shop, wholly different screen purpose | `ovdrassetid://35730100` |
| EquipmentGui | Equipment · character info | Weapon · ability · head · body · accessory slots, center character display | Inventory list, shop | `ovdrassetid://35634100` |
| InventoryGui | 4-tab inventory | Item storage · equipped display · detail (DetailFrame) | Shop, equipment-only equip screen | `ovdrassetid://35635100` |
| EnhancementGui | Item/skill enhancement popup | Level · XP bar · materials · gold cost | Shop, inventory list | `ovdrassetid://35636100` |
| ShopGui | 4-tab item shop | Tab products · detail · sell confirm (ConfirmPopupFrame) | Inventory, enhancement | `ovdrassetid://35634200` |
| SkillTreeGui | Tree skill screen | Skill points · branch tree · detail (DetailPopupFrame) | Quickslots only, inventory | `ovdrassetid://35637100` |
| QuestProgressionHUD | In-game quest progress HUD | Persistent quest name · description · progress | Quest detail · reward claim screen | `ovdrassetid://35639100` |
| QuestGui | Quest detail screen | Tabs · claim · progress · footer rewards | Persistent quest HUD | `ovdrassetid://35635200` |

**Conflict priority:** 
(1) Loading → LoadingScreenGui 
(2) End · result: time→GameOverGui, win→Victory, loss→Defeat, personal score→Score, rank→Rank 
(3) Persistent HUD: RPG→RPGIngameHUD, general→IngameHUD, leaderboard→LeaderboardHUD, boss→BossHPHUD, quest tracking→QuestProgressionHUD
(4) RPG features: attendance→DailyAttendanceGui, reward toast→RewardToastHUD, equipment→EquipmentGui, inventory→InventoryGui, enhancement→EnhancementGui, shop→ShopGui, skill tree→SkillTreeGui, quest detail→QuestGui
(5) CharacterSelectGui 
(6) Icon focus→IconPopupGui 
(7) Text modal→PopupGui

### Exclusion Criteria (if any apply → stop that template)

1. Context mismatch (forcing persistent↔modal) 2. Interaction model mismatch (browse · equip vs. confirm only) 3. Information overload · readability · touch degradation 4. Must change group · slot meaning to accept 5. Repeated elements impossible even with scroll · split 6. Requires reserved-area · boundary overflow · ClipsDescendants dependency 7. Request’s main feature replaces template purpose at scale

→ Reselect, switch to `ui-generator`, or split · prioritize via **`request_user_input`** (do not infer deletions).

**DailyAttendanceGui exception:** When the request is attendance · daily reward claim and **only day (slot) count** differs from the template default (31), the exclusion criteria above **do not apply**. Vary via slot Destroy · Duplicate and keep the template.

## Template Fixed Behavior (no changes outside spec)

Common: structural add/remove **only after spec**. Before spec, keep default structure and **designed Visible** below.

| Template | Fixed behavior the agent must follow |
|---|---|
| LoadingScreenGui | Keep name · loading bar · loading text; L2 only for progress · copy |
| LeaderboardHUD | Show all → popup; popup default `Visible=false`; my player `PlayerName` bold + Highlight |
| BossHPHUD | Boss HP only (do not mix player HP bar) |
| CharacterSelectGui | Scroll slots; on select, name · description on the right |
| GameOverGui | May show remaining/elapsed time (only template that does) |
| GameDefeatGui / GameVictoryGui / GameScoreResultGui / GameRankResultGui | Rank: scroll slots + my player Highlight |
| IngameHUD | Keep HP bar · menu/settings · gold/crystal currency · 5 attack buttons |
| RPGIngameHUD | Keep HP bar · energy bar · XP bar · level · gold/crystal currency · 3 skill buttons · 2 quickslot buttons · dash button; **no menu · settings** |
| RewardToastHUD | Vertical layout; per slot icon · quantity gained · description; **max 6 slots on screen**, 7+ fades in previous slot · disables |
| DailyAttendanceGui | Vertical scroll; default days 1–31 slots (**add/remove slots to match requested days**). **Today’s day** `SlotBorderImage` active; button states Claimed/Claim/Locked; time until next day. Day-count-only requests are **template variation** (shrink · grow slots), not new UI |
| EquipmentGui | Weapon · ability · head · body · accessory equip slots; **keep center empty for character display — do not place UI there** |
| InventoryGui | Top 4 tabs; current tab top-left; left vertical scroll item slots; equipped slots `EquippedBadgeLabel` active; on select `DetailFrame` active |
| EnhancementGui | Top prev/next level; level-up XP progress bar; center enhancement material area; bottom enhancement gold cost |
| ShopGui | Left 4 tabs; current tab top-left; left vertical scroll item slots; on select `DetailFrame`; Sell in `DetailFrame` → `ConfirmPopupFrame` active |
| SkillTreeGui | Skill points top-left; center tree (multiple columns when branched); on skill slot select `DetailPopupFrame` active |
| QuestProgressionHUD | Quest slots top-left; per slot name · description · progress; **persistent in-game quest status while playing** |
| QuestGui | Top 2 tabs; tab with claimable quests `NotificationDotLabel`; vertical scroll; slot states In Progress/Claimed/Claim; footer overall progress rewards |

`IngameHUD` · `RPGIngameHUD`: on the confirmation turn, call the **template-specific** `request_user_input` **once** with `hud_regions` + `hud_layout` **2 questions shown together**, then finalize spec (**no 2 sequential calls**). Change `Position`/`Size`/`Anchor` **only when explicit in prompt · spec**.

## Forbidden

- **Handling fixed-choice confirmation only via chat text · free-text replies** (skipping `request_user_input`, prompting “reply examples”)
- **Sequential `request_user_input` calls when 2+ questions are needed** (second call after first response). **Must be one call · all in `questions` array · shown together**
- Destroy · structural add · button count change · hiding unconfirmed elements without spec · explicit statement
- New blank-canvas or equivalent UI without template when similarity · fit judgment · spec are missing
- GUI placement · edits without `ui-generator`
- Not using official templates when a fitting one exists
- Not using **DailyAttendanceGui** when it fits **only because day count differs** · building anew with `ui-generator`
- Arbitrary coordinates · anchors · appearance without explicit spec, reserved-area encroachment, ClipsDescendants concealment

## Pre-Response Self-Check · Response Format

**No completion response until all pass.**

- [ ] If add/remove was needed, Destroy · add only **after receiving spec via `request_user_input`** (failure if confirmed only via chat list · “reply examples”)
- [ ] If 2+ questions, were they in **one `request_user_input` call** with all in `questions` **shown together**? (**failure if 2 sequential calls**)
- [ ] For IngameHUD · RPGIngameHUD, were `hud_regions` + `hud_layout` **shown together at once**? **Do choices match the template-specific table**
- [ ] Actual add/remove ⊆ `remove_elements` ∪ `add_elements` (everything else kept)
- [ ] No coordinate · anchor · appearance changes without spec · explicit statement
- [ ] Frames · reserved areas · ClipsDescendants respected
- [ ] Template · exclusion · `ui-generator` · spec (or “already stated in prompt”) recorded
- [ ] For attendance requests with **only different day count** → used `DailyAttendanceGui` · varied slots (not new UI · not template exclusion)

**A. Confirmation turn (before build):** Template candidate (1–2 sentences in chat) + **fixed choices via `request_user_input`** → apply responses to spec, then build (do not list choices only in chat and collect typed input)

**B. Completion turn:** Structure · purpose one line each | confirmation · `user_confirmed_spec` | template · asset ID | add/remove (remove/add/none) | L2 · names · boundaries · reserved | no inferred add/remove
