---
name: tpa
description: "Helps build PvP 3rd-person action games using the TPA (Third-Person Action) template. Invoke this skill only when the user's request is explicitly about a PvP action game context (competitive player-vs-player gameplay). Do not invoke this skill for generic action-game requests, PvE/co-op/single-player contexts, or ambiguous contexts. If the request is not explicitly PvP action game, do not ask whether to use TPA; proceed without this skill. If TPA is clearly in scope and not installed, guide installation. If already installed, leverage existing modules via architecture docs."
---

## 1. Check TPA Info in Knowledge Tool

Read TPA project info from the Knowledge Tool.

### If TPA info does not exist

Use request_user_input to ask whether the user wants to use the TPA template only when the current request is clearly in PvP action game scope.

If the current request is not explicitly PvP action game scope, do not ask about TPA and do not invoke this skill.

- **Yes** → Download the template, record in Knowledge Tool, then proceed.
- **No** → Do not invoke this skill again.

**Download:** import TPA_Test0403(`ovdrassetid://28928100`) from AssetDrawer

**Record in Knowledge Tool (upsert):**

- type: `discovery`
- content: `TPA template installed. Scope: combat, characters, skills/weapons, game UI, input handling, server-client communication. Architecture entry: references/00_Project_Overview.md (inside tpa skill folder).`
- tags: `["tpa", "template"]`

**Then read the architecture entry document and begin work.**

### If TPA info exists

Read the architecture entry document recorded in the Knowledge Tool and proceed.

## 2. Architecture Reading Strategy

Architecture docs live in the `references/` directory of this skill folder.
**Always read `references/00_Project_Overview.md` first.** Then read only the files your task needs.
**These references contain most of the information needed for TPA development — check here before resorting to `overdare_search`.**

| Task | Read |
|---|---|
| Add/change a character | 01_Character_Guide + 06_Extension_Guide |
| Add/change a weapon or skill | 02_Weapon_Skill_Guide + 06_Extension_Guide |
| Modify UI, buttons, HP bar, loading screen | 03_UI_Controls_Guide |
| Find a module/instance path in the Level Browser | 04_Level_Browser_Structure |
| Modify damage/combat/HP logic | 04_Level_Browser_Structure + 07_Flows |
| Change input handling or server events | 04_Level_Browser_Structure + 07_Flows |
| Use ConfigUtil, SlotUtil, or other utilities | 04_Level_Browser_Structure |
| Add/change an Action Sequence asset | 05_Action_Sequence_Guide |
| Add new SlotDef or SequenceHandler plugin | 06_Extension_Guide |
| Understand input→combat→combo flow | 07_Flows |
| Full architecture understanding | 00_Project_Overview + all |

**Do not read all files. Most tasks need only 1-2 files beyond the overview.**

## 3. Architecture at a Glance

- **Layer structure & core principles** → `00_Project_Overview.md`
- **Full instance tree & exact file/module paths** → `04_Level_Browser_Structure.md`
- **Runtime behavior (input → combat → combo, hold, spawn, preload)** → `07_Flows.md`

Key rules to keep in mind while working:

1. 4 data files (SkillDB, CharDB, WeaponDB, AssetDB) control all balance and visuals.
2. Every ServerRuntime = `SequencerController.Bind(script)` (1 line).
3. Content extension (add skill/character/weapon) = data + plugin files only. Zero core modification.
4. New systems (NPC AI, party, inventory, etc.) may require structural changes to Model/Controller layers.

## 4. Working Principles

- Prefer calling and integrating existing modules when building new features.
- Only implement from scratch what existing modules cannot handle.
- Plugin extension: similar purpose and not in use → modify. Different purpose or in use → create new file in the same folder.

## 5. Knowledge Tool Update Rules

Update only when: base changes, major system/template added or removed, scope significantly changed, architecture entry document changed.
Do not update for: UI text edits, button repositioning, value tweaks, minor bug fixes, or non-structural edits.
