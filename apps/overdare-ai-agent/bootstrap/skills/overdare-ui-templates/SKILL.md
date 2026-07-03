---
name: overdare-ui-templates
description: Use when creating a NEW UI screen matching an official OVERDARE template (HUD, popup/modal, loading, leaderboard, boss HP, character select, result/rank, or RPG inventory/shop/equipment/skill-tree/quest/attendance). Determine template fit first; structure confirmation via request_user_input (choice UI, no free-text); no element add/remove until user_confirmed_spec is finalized. NOT for editing an already-built UI (move/align/rename/recolor/show-hide/retext), world-surface decoration, gameplay/state logic, or one-off status tweaks.
---

# OVERDARE UI Template Guide

## Not for existing-UI edits (early exit)

Run this check first. This skill is only for building a **new** UI screen from an official template. If the request is any of the following, this skill does not apply — **stop here and handle it directly, without the template procedure below** (no RAG, no confirmation flow, no self-check):

- Editing an already-built UI: text, icon, color, position, size, show/hide, or adding a single element to an existing screen
- World-surface decoration (images/signs on walls, ceilings, floors)
- Gameplay/state logic (combat, movement, spawns, timers, data store)
- A one-off status check, handoff/plan continuation, or an empty/acknowledgment message

Proceed below only when the request is to create a new template-shaped screen.

**Structure-confirmation scope:** the `request_user_input` / `user_confirmed_spec` flow below applies **only while first building a new template screen** — deciding which buttons and regions it ships with (e.g. "confirm only", "keep HP and currency"). Once that screen exists, changing its buttons or elements (add/remove/reorder) is an **edit** — handle it directly, not through this skill's confirmation flow.

## How this skill works

The path is: **pick the closest official template → confirm any structural choices with the user → record them as `user_confirmed_spec` → build only within that spec.** The template gives you a correct, mobile-safe skeleton for free; your job is to fit the request to it without silently guessing at structure.

## Core Principles

1. **Judge before you touch.** Do not create or edit UI instances until you have completed the [Required Procedure](#required-procedure). Skipping ahead "to save time" is where wrong structure gets built.
2. Use an official template only when it is genuinely **similar** to the request. If none fits, don't force one.
3. On the template path, preserve the template's **skeleton, layout, and frames** — that is what makes the result correct on mobile.
4. **Structural changes** (delete, add, change button count, remove a slot) are allowed only for items the user explicitly chose in `user_confirmed_spec`. Do not infer them — guesses like "a notification, so one button" or "an RPG, so drop the currency" are the single most common way these screens come out wrong.
5. Before confirmation or an explicit spec, keep **all default template elements** and change only **L2**: text, numbers, icons, GUI names, data, and script bindings.
6. Leave **Position / Size / Anchor / appearance / color** as the template defines them unless the prompt or spec says otherwise, and never encroach on the **reserved areas** for the joystick, jump, or mobile dashboard — the player needs those.
7. Keep variations **within frames and screen bounds**. Don't mask overflow with `ClipsDescendants`; remove elements with **Destroy** rather than leaving them `Visible = false`, so the tree reflects reality.
8. Rename the root `ScreenGui` and clearly role-defined child GUIs to match their purpose (keep the layout values).
9. Pass the [Self-Check](#pre-response-self-check--response-format) before any completion response.
10. Confirm fixed choices with `request_user_input`, not by listing options in chat and asking the user to type — see [Confirming structure](#confirming-structure-before-you-build) for why.

## Confirming structure before you build

**Why this exists:** the template already knows the right skeleton; what it can't know is which optional parts *this* request wants. Rather than guess (Principle 4), you ask once and record the answer. The confirmation is a choice UI, not a chat question, so the answer is unambiguous and replayable as `user_confirmed_spec`.

**Confirm** — before adding assets, Destroying, or changing button count — when any of these is unspecified:

- a popup/modal/notification's button count or types
- a HUD/RPG/in-game screen's included regions (HP, currency, actions, menu, …)
- which buttons to keep (Lobby / Back / Retry)
- what to reduce or expand versus the template

**Skip confirmation** when:

- the buttons/regions/removals are already specified in the request ("confirm only", "remove Lobby", "HP and currency only")
- the change is **L2-only**
- the user said "keep the template as-is / default layout"

**How to ask:**

- Put one line in chat — the candidate template and why. Keep the rest of the chat minimal.
- Present the choices through a `request_user_input` call. Never render them as a markdown list with "reply like this" / "reply example:" — requiring free-text for a fixed choice is a failure.
- **One call per confirmation turn.** If you have two or more questions, put them all in the `questions` array and show them together; do not fire a second call after the first answer. The user should see every question at once, decide, and move on. (Use `allow_multiple: true` for regions/buttons where several can apply.)
- Record each answer's `id` and selected `label` **verbatim** into `user_confirmed_spec`, and edit only within that scope.

**After selecting a template, read `references/template-details.md`** for that template's exact confirmation questions and option sets (IngameHUD, RPGIngameHUD, PopupGui, DailyAttendanceGui) — and, once chosen, its fixed behavior.

### `user_confirmed_spec`

Record the user's choices here; anything not chosen keeps the template default.

| Field | Content |
|---|---|
| `template` | Template name in use |
| `keep_elements` | Regions · buttons to keep (if omitted, **full template default**) |
| `remove_elements` | Elements to delete (only what the user chose) |
| `add_elements` | Elements to add (only what the user chose) |
| `content_notes` | L2 (copy · icons, etc.) |

Do not Destroy or add anything outside `remove_elements` / `add_elements`. Put "not needed" in `remove_elements` only when the user chose or stated it.

## Required Procedure

1. Read the [template selection tables](#official-templates--selection--conflicts) below (fit, conflict priority, exclusion criteria).
2. Lock a candidate template using the [4 similarity questions](#4-similarity-questions). Add assets only after step 4.
3. If structural add/remove is needed, [confirm](#confirming-structure-before-you-build) and receive `user_confirmed_spec` — no Destroy or structural add until then.
4. If exclusion criteria apply, reselect a suitable template.
5. Add assets → set GUI names → add/remove within spec scope → apply L2.
6. Verify reserved areas, frames, and overflow → run the [Self-Check](#pre-response-self-check--response-format) → respond (include spec and judgment).

### 4 Similarity Questions

- Persistent HUD vs. temporary modal?
- Confirm/close vs. browse/repeat interaction?
- Text vs. icon/visual focus?
- Can it fit in the same slot/region?

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

1. Context mismatch (forcing persistent↔modal) 2. Interaction model mismatch (browse · equip vs. confirm only) 3. Information overload · readability · touch degradation 4. Must change group · slot meaning to accept 5. Repeated elements impossible even with scroll · split 6. Requires reserved-area · boundary overflow · ClipsDescendants dependency 7. Request's main feature replaces template purpose at scale

→ Reselect, or split · prioritize via `request_user_input` (do not infer deletions).

**DailyAttendanceGui exception:** when the request is attendance · daily reward claim and **only the day (slot) count** differs from the default 31, the exclusion criteria above **do not apply**. Vary the slots (Destroy · Duplicate) and keep the template.

## Per-Template Detail

Once a template is selected, its confirmation questions, slot-variation rules, and fixed behavior live in **`references/template-details.md`** — read the section for your chosen template before building. Keeping it there keeps this file focused on selection and confirmation.

## Forbidden

- Confirming fixed choices only via chat text or free-text replies (skipping `request_user_input`, prompting "reply examples").
- Firing sequential `request_user_input` calls when 2+ questions are needed — it must be one call with all questions in the `questions` array, shown together.
- Destroy, structural add, button-count change, or hiding elements without a spec or an explicit statement.
- Building new blank-canvas UI without a template when similarity, fit judgment, and spec are all missing.
- Not using an official template when a fitting one exists.
- Not using **DailyAttendanceGui** when it fits and only the day count differs.
- Arbitrary coordinates, anchors, or appearance without an explicit spec; reserved-area encroachment; `ClipsDescendants` concealment.

## Pre-Response Self-Check · Response Format

No completion response until all pass:

- [ ] If add/remove was needed, Destroy/add happened only **after** a spec via `request_user_input` (not a chat list or "reply examples").
- [ ] If there were 2+ questions, they were in **one** `request_user_input` call, shown together (not sequential calls).
- [ ] For IngameHUD / RPGIngameHUD, `hud_regions` + `hud_layout` were shown together, with options matching the template (from `references/template-details.md`).
- [ ] Actual add/remove ⊆ `remove_elements` ∪ `add_elements` (everything else kept).
- [ ] No coordinate/anchor/appearance change without a spec or explicit statement.
- [ ] Frames, reserved areas, and `ClipsDescendants` respected.
- [ ] Template, exclusion, and spec (or "already stated in prompt") recorded.
- [ ] For attendance requests where only the day count differs → used `DailyAttendanceGui` and varied slots (not new UI, not template exclusion).

**A. Confirmation turn (before build):** template candidate (1–2 sentences in chat) + fixed choices via `request_user_input` → apply the answers to the spec, then build. Do not collect typed input for fixed choices.

**B. Completion turn:** structure · purpose (one line each) | confirmation · `user_confirmed_spec` | template · asset ID | add/remove (remove/add/none) | L2 · names · boundaries · reserved | no inferred add/remove.
