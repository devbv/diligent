# Weapon & Skill Guide

Weapon and skill data is managed in `WeaponDB.lua` and `SkillDB.lua`.

> **Level Browser path:**
> - `ReplicatedStorage > Data > WeaponDB`
> - `ReplicatedStorage > Data > SkillDB`
> - `ReplicatedStorage > Data > Enums`

---

## Weapon List

### Fist (Unarmed) — CharA Default Weapon

Used without Tool equip.

| Slot | Skill | Type |
|------|------|------|
| Attack | Punch_Attack1 → Punch_Attack2 | **Combo** (2-hit) |
| Skill | Punch_Skill1 | Single |
| Guard | Common_Block | Hold |
| Dash | Common_Tumbling | Single |
| SpecialSkill | Punch_Skill_Ultimate | Single |

---

### Longsword — CharB Default Weapon

Equips `Tool = "Longsword"`.

| Slot | Skill | Type |
|------|------|------|
| Attack | Sword_Attack1 → Sword_Attack2 | **Combo** (2-hit) |
| Skill | Sword_Skill1 | **Hold** |
| Guard | Sword_Block | Hold |
| Dash | Common_Tumbling | Single |
| SpecialSkill | Sword_Skill_Ultimate | Single |

---

### Gun — CharD Default Weapon

Equips `Tool = "Gun"`. The only weapon with a **Skill2 slot**.

| Slot | Skill | Type |
|------|------|------|
| Attack | Gun_Attack1 | Single (no combo) |
| Skill | Gun_Skill1 | Single |
| **Skill2** | **Common_Buff** | Single (ActiveHandler: IceAoE) |
| Guard | Common_Block | Hold |
| Dash | Common_Tumbling | Single |
| SpecialSkill | Gun_Skill2 | Single |

> Skill2 is **auto-derived** from the Skill slot definition — no separate SlotDef file needed.

---

## Slot System

There are 5 base slots. Additional slots (e.g. Skill2) may be auto-derived depending on the weapon.

| Slot | Priority | Input | Behavior |
|------|:---:|------|------|
| Attack | 10 | Press | Combo |
| Guard | 15 | Hold | Hold |
| Skill | 20 | Press | Action |
| Dash | 25 | Press | Action |
| SpecialSkill | 30 | Press | Action |

Higher-priority slots can interrupt lower-priority ones. (e.g. Dash (25) can cancel Attack (10))

> **Level Browser path:** `ServerStorage > Module > SlotDef > [Attack, Guard, Skill, Dash, SpecialSkill]`

---

## Skill Details

### Fist-Exclusive Skills

| Skill | Damage | Cooldown | Energy Cost | Movement | Knockback | Notes |
|-------|:---:|:---:|:---:|------|:---:|------|
| Punch_Attack1 | 10 | — | — | Lock | — | Combo hit 1 |
| Punch_Attack2 | 15 | — | — | Lock | 30 | Combo hit 2, knockback |
| Punch_Skill1 | 30 | 5s | 20 | Lock | 50 | Strong knockback |
| Punch_Skill_Ultimate | 50 | 8s | 100 | Lock | 80 | Ultimate, full Energy cost |

### Longsword-Exclusive Skills

| Skill | Damage | Cooldown | Energy Cost | Movement | Notes |
|-------|:---:|:---:|:---:|------|------|
| Sword_Attack1 | 12 | — | — | Lock | Combo hit 1 |
| Sword_Attack2 | 40 | — | — | Lock | Combo hit 2, SelfCost=30 / Lifesteal=30 |
| Sword_Skill1 | 5×8hit | 6s | 25 | Slow (Speed=100) | **Hold** skill, 8 multi-hits |
| Sword_Block | — | — | — | Lock | Exclusive block, 60% damage reduction |
| Sword_Skill_Ultimate | 50 | 8s | 100 | Lock | Ultimate, knockback 80 |

### Gun-Exclusive Skills

| Skill | Damage | Cooldown | Energy Cost | Movement | Notes |
|-------|:---:|:---:|:---:|------|------|
| Gun_Attack1 | 3 | — | — | Lock | Low single-hit damage |
| Gun_Skill1 | 30 | 2s | — | Lock | Short cooldown |
| Gun_Skill2 | 50 | 8s | 100 | Lock | Ultimate-tier, knockback 80 |

### Common Skills

| Skill | Damage | Cooldown | Energy Cost | Movement | Notes |
|-------|:---:|:---:|:---:|------|------|
| Common_Block | — | — | — | Lock | **Hold** guard, 50% damage reduction |
| Common_Tumbling | — | 2s | — | Lock | Dodge, ClientDash Speed=1000 |
| Common_Buff | — | 5s | — | — | **ActiveHandler=IceAoE**, AoE damage 10, radius 150, duration 4s, tick interval 1s |
| Common_Hit | — | — | — | Lock | Hit reaction (no damage) |

---

## Special Field Reference

| Field | Description |
|------|------|
| Damage | Base damage |
| Cooldown | Cooldown (seconds) |
| EnergyCost | Energy cost |
| WalkSpeed | Temporary walk speed while the skill is active. Omit to keep current speed |
| RotationSpeed | Temporary turn speed while the skill is active. Omit to keep current speed |
| InputType | `Hold` = maintained while pressed, `Press` = default (omitted = Press) |
| Knockback | Horizontal knockback speed applied to the target |
| SuperArmor | Takes damage, but ignores hit reaction state changes and knockback while this skill is active |
| Invincible | Ignores damage, hit reaction state changes, and knockback while this skill is active |
| TargetHitMotion | Hit reaction requested by this attack: `TargetState` (`Hit`, `Stun`, `Down`) and optional `SequenceId` |
| TargetHitVFX | Hit visual effect name from `ReplicatedStorage > Model > VFX`. Plays through server-side `HitVFXView` pooling |
| SelfCost | HP self-cost |
| Lifesteal | Recovers HP from a portion of damage dealt |
| ClientDash | Client-side dash movement (`Speed` value) |
| HitTriggers | CollisionTrack names to bind. Can be a string or array. Defaults to `HitTrigger` |
| HitHandler | Custom hit plugin name from `SequenceHandler/Hit` |
| ActiveHandler | Custom active plugin name from `SequenceHandler/Active` |
| ActiveTriggers | EventTrack marker names to bind. Can be a string or array. Defaults to the `ActiveTrigger` series |
| HitCount | Multi-hit count (e.g. Sword_Skill1) |
| AoEDamage / AoERadius / AoEDuration / AoETickInterval | AoE (area-of-effect) parameters |

---

## Target Hit VFX

Use `TargetHitVFX` on an attacking skill when a hit should spawn a visual effect on the target.

```lua
Punch_Attack1 = {
    Damage = 10,
    TargetHitVFX = "FlashHit",
}

Sword_Attack1 = {
    Damage = 12,
    TargetHitVFX = "SwordSlash",
}
```

The value must match a VFX Part under `ReplicatedStorage > Model > VFX`.

```text
ReplicatedStorage
└─ Model
   └─ VFX
      ├─ FlashHit (Part)
      │  └─ VFXPreset
      └─ SwordSlash (Part)
         └─ ParticleEmitter
```

Runtime handling is server-side: `ServerStorage > Module > View > HitVFXView` clones and pools the Part, parents active effects under `workspace > FXRuntime`, then returns idle effects to `ReplicatedStorage > Pooling`.

`VFXPreset` effects play by setting `Enabled = true`. `ParticleEmitter` effects play by setting `Enabled = true`, waiting briefly for OVERDARE Studio stability, then calling `Emit(1)`. On release, effects are disabled, wait one tick, then move back to the pooling folder.

---

## Enum Reference

Enum values used by skills are defined in `Enums.lua`.

> **Level Browser path:** `ReplicatedStorage > Data > Enums`

| Enum | Values | Purpose |
|------|------|------|
| InputType | Press, Hold, Charge | Button input mode branching |
| StatusType | Slow, SpeedBoost, DoT, HoT, Custom | Status effect logic branching |
| AoECenter | Self, Forward | AoE center point calculation |
