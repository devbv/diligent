# TPA Template — Project Overview

## Overview

**TPA (Third-Person Action) Template** is a third-person action game template for the OVERDARE engine.
It uses an Action Sequence-based skill timing system with MVC + Data-Driven + Plugin architecture.

## Included Content Summary

| Item | Count | Details |
|------|:---:|------|
| Playable Characters | 3 | Punch (Brawler), Sword (Swordsman), Gunner |
| Weapons | 3 (+None) | Fist, Longsword, Gun |
| Skills | 17 | Includes attacks, skills, guard, dash, ultimate, hit reactions |
| Action Sequence Assets | 31 | Punch, Sword, Gun, Bow, Spear, TwoHandedSword, Common categories |
| Slot Types | 5 | Attack, Skill, Guard, Dash, SpecialSkill |
| State Behaviors | 3 | Action, Combo, Hold |

## Tech Stack

| Component | Description |
|-----------|------|
| Engine | OVERDARE (similar to Roblox, separate API) |
| Language | Lua |
| Architecture | MVC + Data-Driven + Plugin |
| Skill System | Action Sequence (timeline-based assets) |
| State Management | Priority-based FSM (Finite State Machine) |

## Layer Structure

```
DATA         SkillDB · CharDB · WeaponDB · AssetDB · Enums
MODEL        CharacterModel · CombatModel · ResourceModel · StatusEffectModel · FSM
CONTROLLER   ServerController · SequencerController · SlotManager · PersistentEffectManager
VIEW         MovementView · CombatView · ButtonLayout · BtnController · CharSelectView · HpBar · LoadingScreen
PLUGIN       SlotDef/ · SequenceHandler/Hit/ · SequenceHandler/Active/ · StateBehavior/
RUNTIME      ServerRuntime · ClientRuntime (single-line binding)
```

## Core Principles

1. **Four data files** control all balance and visuals (SkillDB, CharDB, WeaponDB, AssetDB).
2. **Content expansion** (adding skills/characters/weapons) only requires data + plugin files. No core code modifications needed.
3. **Every ServerRuntime** is a single line: `SequencerController.Bind(script)`.
4. **System expansion** (NPC AI, party, inventory, etc.) may require structural code changes in the Model/Controller layer.

## Other Documents

| Document | Contents |
|------|------|
| [01_Character_Guide](./01_Character_Guide.md) | Stats, default weapons, resource system for 3 characters |
| [02_Weapon_Skill_Guide](./02_Weapon_Skill_Guide.md) | Weapon skill-slot mappings, detailed skill specs |
| [03_UI_Controls_Guide](./03_UI_Controls_Guide.md) | Buttons, HP bar, character select, loading screen |
| [04_Level_Browser_Structure](./04_Level_Browser_Structure.md) | Level Browser instance tree, file locations |
| [05_Action_Sequence_Guide](./05_Action_Sequence_Guide.md) | Details of all 31 pre-built action sequence assets |
| [06_Extension_Guide](./06_Extension_Guide.md) | How to add characters, weapons, and skills |
| [07_Flows](./07_Flows.md) | Runtime execution flows (input, combat, combo, hold, select, preload, spawn) |
