# OVERDARE UI Template — Per-Template Details

Read this **after** you have selected a template (via the selection tables in `SKILL.md`). It holds each template's confirmation questions, option sets, and fixed behavior — detail you only need once the template is chosen, so it lives here instead of the main flow.

## Contents

- [Per-template confirmation questions](#per-template-confirmation-questions) — IngameHUD, RPGIngameHUD, PopupGui, DailyAttendanceGui
- [DailyAttendanceGui slot-count variation](#dailyattendancegui--slot-day-count-variation)
- [Layout after add/remove](#layout-after-addremove)
- [Fixed behavior per template](#fixed-behavior-per-template)

## Per-template confirmation questions

Put **every** question for a template into one `request_user_input` call (the one-call rule is in `SKILL.md`). The tables below give the exact `id`, prompt, and options to use.

### IngameHUD

Default layout: HP bar · menu/settings · 2 currency slots · 5 attack buttons.

| Question id | prompt | options | allow_multiple |
|---|---|---|---|
| `hud_regions` | Regions to include | HP / resources (gold · crystal ×2) / actions (5 attacks) / menu · settings | true |
| `hud_layout` | Layout | use as-is / tweak later / custom layout | false |

Ask both even when the request only partially specifies regions (exception: L2-only changes). Do **not** offer energy · XP · level · quickslots · dash here — those belong to RPGIngameHUD.

### RPGIngameHUD (separate option set from IngameHUD)

Default layout: HP bar · energy bar · XP bar · level · 2 currency slots · 3 skill buttons · 2 quickslot buttons · dash button (**no** menu · settings).

| Question id | prompt | options | allow_multiple |
|---|---|---|---|
| `hud_regions` | Regions to include | HP / energy / XP · level / resources (gold · crystal ×2) / skills (3) / quickslots (2) / dash | true |
| `hud_layout` | Layout | use as-is / tweak later / custom layout | false |

Ask both even when the request only partially specifies regions (exception: L2-only). Do **not** offer menu · settings here.

For both HUDs: **unselected regions are kept.** The user must explicitly exclude a region for it to be removed.

### PopupGui

| Question id | prompt | options | allow_multiple |
|---|---|---|---|
| `popup_buttons` | Button layout | confirm only / confirm + cancel / keep default 2 | false |
| `popup_body` | Body form | level number / fixed text only / include icon area | false |

A title copy may be the one allowed free-text field if the request needs it.

### DailyAttendanceGui

Prefer this template whenever the purpose is daily attendance / reward claim (Claimed/Claim/Locked), **even if the requested day count differs** from the default 31 — day count is a variation, not a reason to exclude the template.

| Question id | prompt | options | allow_multiple |
|---|---|---|---|
| `attendance_days` | Attendance day count | 7 days / 14 days / 31 days (default) | false |

Skip this question if the day count is already stated in the prompt; record `N days` (e.g. `7 days`) in `content_notes`.

For any other template, move its fixed items into `request_user_input` options the same way.

## DailyAttendanceGui — slot (day) count variation

| Situation | Handling |
|---|---|
| Requested days **< 31** | **Destroy** excess slots (do not only set `Visible` off). Renumber remaining slot day labels · L2 to 1~N |
| Requested days **= 31** | Keep slot count; change L2 · state only |
| Requested days **> 31** | **Duplicate** existing slots to add more. Keep slot structure · Claimed/Claim/Locked · `SlotBorderImage` (today's day) rules |
| Common | Vary inside vertical scroll · parent frame. Keep existing slot Position/Size/Anchor **pattern** (no arbitrary coordinates without explicit spec). Do not hide overflow with `ClipsDescendants` |

## Layout after add/remove

- After removing a button, **re-center** the remaining ones — no empty gaps or one-sided clustering.
- Added content stays **inside the parent frame**; if it doesn't fit, expand the frame `Size` only within screen and reserved-area limits.

## Fixed behavior per template

Before spec, keep the default structure and the **designed `Visible`** state below. Change `Position`/`Size`/`Anchor` only when the prompt or spec says so.

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
| DailyAttendanceGui | Vertical scroll; default days 1–31 slots (**add/remove slots to match requested days**). **Today's day** `SlotBorderImage` active; button states Claimed/Claim/Locked; time until next day. Day-count-only requests are **template variation** (shrink · grow slots), not new UI |
| EquipmentGui | Weapon · ability · head · body · accessory equip slots; **keep center empty for character display — do not place UI there** |
| InventoryGui | Top 4 tabs; current tab top-left; left vertical scroll item slots; equipped slots `EquippedBadgeLabel` active; on select `DetailFrame` active |
| EnhancementGui | Top prev/next level; level-up XP progress bar; center enhancement material area; bottom enhancement gold cost |
| ShopGui | Left 4 tabs; current tab top-left; left vertical scroll item slots; on select `DetailFrame`; Sell in `DetailFrame` → `ConfirmPopupFrame` active |
| SkillTreeGui | Skill points top-left; center tree (multiple columns when branched); on skill slot select `DetailPopupFrame` active |
| QuestProgressionHUD | Quest slots top-left; per slot name · description · progress; **persistent in-game quest status while playing** |
| QuestGui | Top 2 tabs; tab with claimable quests `NotificationDotLabel`; vertical scroll; slot states In Progress/Claimed/Claim; footer overall progress rewards |
