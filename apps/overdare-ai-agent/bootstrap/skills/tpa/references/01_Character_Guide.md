# Character Guide

The project currently includes **3 playable characters**.
Character data is managed in `CharDB.lua`.

> **Level Browser path:** `ReplicatedStorage > Data > CharDB`

## Character List

### CharA — Punch (Brawler)

| Property | Value |
|------|------|
| DisplayName | Punch |
| MaxHp | 100 |
| WalkSpeed | 600 |
| RotationSpeed | 8 |
| Resource Type | Energy |
| Resource Max | 100 |
| Resource Regen | 0 (no passive regen) |
| Resource Gain on Hit | 10 |
| Hit Reaction | Common_Hit |
| Default Weapon | **Fist** (unarmed) |

- Balanced brawler. Fights unarmed, gaining 10 Energy per hit.
- Standard stats with 100 HP and 600 move speed.

---

### CharB — Sword (Swordsman)

| Property | Value |
|------|------|
| DisplayName | Sword |
| MaxHp | 110 |
| WalkSpeed | 600 |
| RotationSpeed | 8 |
| Resource Type | Energy |
| Resource Max | 100 |
| Resource Regen | 0 |
| Resource Gain on Hit | 8 |
| Hit Reaction | Common_Hit |
| Default Weapon | **Longsword** |

- Tank-type swordsman. Has the highest HP at 110.
- Gains 8 Energy per hit (lower than Punch), but has a higher damage reduction of 0.6 on Sword_Block.

---

### CharD — Gunner

| Property | Value |
|------|------|
| DisplayName | Gunner |
| MaxHp | 80 |
| WalkSpeed | 600 |
| RotationSpeed | 8 |
| Resource Type | Energy |
| Resource Max | 100 |
| Resource Regen | 0 |
| Resource Gain on Hit | 8 |
| Hit Reaction | Common_Hit |
| Default Weapon | **Gun** |

- Ranged dealer. Lowest HP at 80, but the only character with a **Skill2 slot** (Common_Buff), giving 6 total slots.
- Gun weapon requires Tool equip.

---

## Character Comparison

| Property | CharA (Punch) | CharB (Sword) | CharD (Gunner) |
|------|:---:|:---:|:---:|
| HP | 100 | **110** | 80 |
| Move Speed | 600 | 600 | 600 |
| Energy Max | 100 | 100 | 100 |
| Gain on Hit | **10** | 8 | 8 |
| Default Weapon | Fist | Longsword | Gun |
| Tool Equip | None | Longsword | Gun |
| Slot Count | 5 | 5 | **6** (includes Skill2) |

## Resource System

All characters use the **Energy** resource.

- **Passive Regen**: None (ResourceRegen = 0)
- **Gain on Hit**: Energy is gained when attacks hit an enemy
- **Consumption**: Skills and ultimates deduct EnergyCost on use

> Resource code: `ResourceModel` (`ServerStorage > Module > Model > ResourceModel`)

## Character Selection System

- Characters can be changed in-game through `CharSelectView` (client UI).
- Characters appear in selection UI ordered by their `Order` value in CharDB (CharA=1, CharB=2, CharD=3).
- Changing a character also swaps the default weapon (DefaultWeapon).

> UI code: `ReplicatedStorage > Module > View > CharSelectView`
