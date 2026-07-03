# Action Sequence Guide

Details of all **31 pre-built action sequence assets** included in the project.

> **Level Browser path:** `ActionSequenceService > {Category} > {SequenceName}`

---

## Overview

Action Sequences are timeline-based assets that integrate animation, effects, hit detection, camera direction, and more.
Each sequence is composed of the following track types.

| Track Type | Role | Range Type |
|-----------|------|-----------|
| AnimationTrack | Character animation playback | Clip (start~end) |
| ControlTrack | VFX enable/disable | Clip (start~end) |
| CollisionTrack | Hit detection (area sensing) | Key (single point) |
| TriggerTrack | State transition control (Sequence, KeyInput, CancelWindow, etc.) | Clip (start~end) |
| EventTrack | Custom callbacks (ActiveTrigger, etc.) | Key (single point) |
| CameraShakeTrack | Camera shake | Clip (start~end) |
| CameraFOVTrack | FOV change | Key (single point) |
| SoundTrack | Sound playback | Clip (start~end) |

---

## TriggerTrack Naming Rules

TriggerTrack names that must be included or optionally added when creating sequences.

| Name | Role | Required |
|------|------|:---------:|
| Sequence | Sequence lifetime management. Start=movement lock, End=unlock+FSM Idle | **Required** |
| ActiveSkill | Skill active window | Conventional |
| KeyInput | Combo input acceptance window. Start=ready, End=clear | Combo only |
| CancelWindow | Late-sequence cancel window. Enables instant combo transition + general cancel | Optional |

---

## CollisionTrack / HitTrigger Rules

CollisionTrack markers are used when the skill needs to hit targets.

| SkillDB Field | Role | Default |
|------|------|------|
| `HitTriggers` | CollisionTrack names to bind. Can be a string or an array. | `{ "HitTrigger" }` |
| `HitHandler` | Optional custom handler from `SequenceHandler/Hit/{Name}.lua`. | `DefaultHit` |

Examples:

```lua
-- Single default hit timing
HitTriggers = "HitTrigger"

-- Multiple custom hit timings in one Action Sequence
HitTriggers = { "SlashHit", "LastHit" }

-- Use a custom hit handler
HitHandler = "ProjectileHit"
```

If `HitHandler` is omitted, `DefaultHit` applies normal damage using the detected target.

When using a custom hit handler, both names must line up:

```lua
Punch_Attack2 = {
    Damage = 15,
    HitHandler = "CustomHit",       -- ModuleScript name in SequenceHandler/Hit
    HitTriggers = { "CustomHit" },  -- CollisionTrack name in the Action Sequence
}
```

`HitHandler` selects the Lua module. `HitTriggers` selects which CollisionTrack names fire hit detection.

---

## Target Hit Motion Rules

`TargetHitMotion` is a `SkillDB` field on the attacking skill. It tells the target which hit reaction state to enter and which hit reaction Action Sequence to play.

```lua
Punch_Attack2 = {
    Damage = 15,
    Knockback = 500,
    TargetHitMotion = {
        TargetState = "Hit",       -- Hit / Stun / Down
        SequenceId = "Common_Hit2",
    },
}
```

Rules:

- If `TargetHitMotion` is omitted, the target enters the normal `Hit` state and uses its `CharDB.HitReaction`.
- If `TargetState` is omitted, it defaults to `Hit`.
- If `SequenceId` is omitted, `Hit` uses the target character's `CharDB.HitReaction`.
- `TargetState = "Stun"` enters `StunState`.
- `TargetState = "Down"` enters `DownState`.
- `Knockback` is separate from `TargetHitMotion`; it applies horizontal velocity to the target.

Hit reaction sequences can still contain the normal `ServerRuntime` one-line binder:

```lua
SequencerController.Bind(script)
```

When a sequence such as `Common_Hit2` is not connected to an active weapon slot, `SequencerController` treats it as a standalone sequence. It reads `SkillDB.Common_Hit2` directly and only binds basic sequence settings such as `WalkSpeed` and `RotationSpeed`. Attack-only wiring such as Hit, Combo, CancelWindow, Hold, SequenceEnd, and ActiveTrigger is skipped.

This lets hit reaction sequences use movement lock settings without pretending to be an Attack/Skill slot.

`SuperArmor` and `Invincible` are read from the target's current skill, not from the attacking skill:

- `SuperArmor = true`: target still takes damage, but ignores hit reaction state changes and knockback.
- `Invincible = true`: target ignores damage, hit reaction state changes, and knockback.

---

## EventTrack / ActiveTrigger Rules

EventTrack markers are used to trigger extra behavior at a specific timeline moment.
Think of `ActiveTrigger` as "do something at this timing": spawn a projectile, create an AoE, teleport, heal, buff, or run any custom action.

| SkillDB Field | Role | Default |
|------|------|------|
| `ActiveHandler` | Custom handler from `SequenceHandler/Active/{Name}.lua`. | None |
| `ActiveTriggers` | EventTrack marker names to bind. Can be a string or an array. | `ActiveTrigger`, `ActiveTrigger1` ... `ActiveTrigger10` |

Examples:

```lua
-- One custom active timing
ActiveHandler = "Fireball"
ActiveTriggers = "ShootTrigger"

-- Multiple named timings for a staged skill
ActiveHandler = "ChargeSweep"
ActiveTriggers = { "ReadyTrigger", "StartTrigger", "EndTrigger" }
```

---

## Punch (Fist Weapon) — 4 Sequences

### Punch_Attack1 — Combo Hit 1

| Property | Value |
|------|------|
| Duration | ~0.77s |
| Collision | HitTrigger ×1 (Box) |
| TriggerTrack | Sequence, KeyInput, ActiveSkill, **CancelWindow** |
| VFX | VFX_Swing |
| Camera | CameraShake (Light) |

### Punch_Attack2 — Combo Hit 2

| Property | Value |
|------|------|
| Duration | ~0.70s |
| Collision | HitTrigger ×1 (Box) |
| TriggerTrack | Sequence, KeyInput, ActiveSkill |
| VFX | VFX_Swing |
| Camera | CameraShake (Light) |

### Punch_Skill1 — Skill

| Property | Value |
|------|------|
| Duration | ~1.57s |
| Collision | HitTrigger ×1 (**Sphere**, radius ~249) |
| TriggerTrack | Sequence, ActiveSkill |
| VFX | VFX_Punch, VFX_GloryExplosion |
| Camera | CameraShake (Ultimate) + **CameraFOV** (90→130→90) |
| Notes | Powerful skill with FOV zoom effect |

### Punch_Skill_Ultimate — Ultimate

| Property | Value |
|------|------|
| Duration | ~1.65s |
| Collision | HitTrigger ×2 (Sphere + Box, 2-stage detection) |
| AnimationTrack | 2 (chained) |
| TriggerTrack | Sequence, ActiveSkill |
| VFX | VFX_Punch, VFX_GroundCrack |
| Camera | CameraShake (Recoil) ×2 |
| Notes | 2-stage hit detection (Sphere → Box) |

---

## Sword (Longsword Weapon) — 5 Sequences

### Sword_Attack1 — Combo Hit 1

| Property | Value |
|------|------|
| Duration | ~0.57s |
| Collision | HitTrigger ×1 (Box) |
| TriggerTrack | Sequence, KeyInput, ActiveSkill, **CancelWindow** |
| VFX | SimpleTrail (sword trail) |
| Camera | CameraShake (Light) |

### Sword_Attack2 — Combo Hit 2

| Property | Value |
|------|------|
| Duration | ~0.70s |
| Collision | HitTrigger ×1 (Box) |
| TriggerTrack | Sequence, KeyInput, ActiveSkill, **CancelWindow** |
| VFX | SimpleTrail |
| Camera | CameraShake (Light) |

### Sword_Skill1 — Hold Skill (Spin Slash)

| Property | Value |
|------|------|
| Duration | **5.0s** |
| Collision | **HitTrigger ×9** (all Sphere, radius 120, ~0.5s intervals) |
| TriggerTrack | Sequence, ActiveSkill, **CancelWindow** |
| VFX | WindCast |
| Camera | CameraShake (Light, low intensity, long duration) |
| Notes | 8 multi-hit hold skill. Maintained while button is pressed |

### Sword_Block — Exclusive Block

| Property | Value |
|------|------|
| Duration | **5.0s** |
| Collision | None |
| TriggerTrack | Sequence, ActiveSkill, **MoveLock** |
| VFX | Small_Barrier |
| Notes | Barrier VFX display. Hold guard |

### Sword_Skill_Ultimate — Ultimate

| Property | Value |
|------|------|
| Duration | ~2.27s |
| Collision | HitTrigger ×3 (Box, Box, Sphere) |
| AnimationTrack | 4 (multi-chained) |
| TriggerTrack | Sequence, ActiveSkill, **CancelWindow** |
| VFX | VFX_SimpleTrail, SkillSword, VFX_GroundCrack |
| Camera | CameraShake (Light ×2 + Heavy ×1) |
| Notes | 3-stage hit detection, multi-animation compositing |

---

## Gun — 3 Sequences

### Gun_Attack1 — Basic Shot

| Property | Value |
|------|------|
| Duration | **~0.27s** (very short) |
| Collision | HitTrigger ×1 (Box) |
| TriggerTrack | Sequence, ActiveSkill, **CancelWindow** |
| VFX | VFX_Muzzle (muzzle flash) |
| Camera | CameraShake (Light) |
| Notes | Fast fire possible (no combo, short sequence) |

### Gun_Skill1 — Skill

| Property | Value |
|------|------|
| Duration | ~2.33s |
| Collision | HitTrigger ×1 (Box) |
| AnimationTrack | 2 |
| TriggerTrack | Sequence, ActiveSkill, **CancelWindow** |
| VFX | VFX_StraightPunch, VFX_Portal, VFX_Muzzle |
| Camera | CameraShake (Recoil) |

### Gun_Skill2 — Ultimate-Tier Skill

| Property | Value |
|------|------|
| Duration | ~1.91s |
| Collision | HitTrigger ×1 (Box) |
| AnimationTrack | 3 |
| TriggerTrack | Sequence, ActiveSkill, **CancelWindow** |
| VFX | VFX_Muzzle, VFX_Cast, VFX_Portal, Gun |
| Camera | CameraShake (Recoil) |
| Notes | No KeyInput (no combo) |

---

## Bow — 2 Sequences (For Future Expansion)

Bow weapon is not currently registered in WeaponDB, but sequence assets are pre-built.

### Bow_Skill1

| Property | Value |
|------|------|
| Duration | ~0.47s |
| Collision | HitTrigger ×1 (Box) |
| VFX | VFX |
| Camera | CameraShake (Impact) |

### Bow_Skill2

| Property | Value |
|------|------|
| Duration | ~1.97s |
| Collision | HitTrigger ×1 (Box) |
| AnimationTrack | 4 (multi-stage bow combo) |
| VFX | Beam, Energy |

---

## Spear — 3 Sequences (For Future Expansion)

Spear weapon is not currently registered in WeaponDB, but sequence assets are pre-built.

### Spear_Attack1

| Property | Value |
|------|------|
| Duration | ~1.10s |
| Collision | HitTrigger ×1 (Sphere) |
| TriggerTrack | Sequence, KeyInput, ActiveSkill, **CancelWindow** |
| VFX | VFX_Trail |
| Camera | CameraShake (Light) |

### Spear_Skill1

| Property | Value |
|------|------|
| Duration | ~1.33s |
| Collision | HitTrigger ×1 (Sphere) |
| VFX | VFX_Trail |

### Spear_Skill_Ultimate — Ultimate

| Property | Value |
|------|------|
| Duration | ~2.86s |
| Collision | HitTrigger ×3 (Box + Sphere + Sphere) |
| AnimationTrack | 3 |
| VFX | VFX_SpinTrail, VFX_Punch, VFX_FireDrop |
| Camera | CameraShake (Heavy ×2) + **CameraFOV** |
| **EventTrack** | **Dash** (marker, ~0.31s mark) |
| Notes | Only sequence with an EventTrack "Dash" marker |

---

## TwoHandedSword — 2 Sequences (For Future Expansion)

Not currently registered in WeaponDB, but sequence assets are pre-built.

### TwoHandedSword_Attack

| Property | Value |
|------|------|
| Duration | ~0.87s |
| Collision | HitTrigger ×1 (Box) |
| TriggerTrack | Sequence, KeyInput, ActiveSkill, **CancelWindow** |
| VFX | VFX_Trail |

### TwoHandedSword_Skill

| Property | Value |
|------|------|
| Duration | ~0.87s |
| Collision | HitTrigger ×1 (Box) |
| VFX | VFX_SpearThrust |
| Camera | CameraShake (Impact) |

---

## Common (Shared) — 12 Sequences

General-purpose sequences shared across multiple characters/weapons.

### Common_Block — Shared Guard

| Property | Value |
|------|------|
| Duration | ~4.97s |
| Collision | None |
| VFX | Small_Barrier |
| Notes | Hold guard. No CollisionTrack |

### Common_Tumbling — Dodge

| Property | Value |
|------|------|
| Duration | ~0.80s |
| Collision | None |
| VFX | Landing |
| Notes | Client-side movement via ClientDash |

### Common_Hit — Hit Reaction

| Property | Value |
|------|------|
| Duration | ~0.40s |
| Collision | None |
| VFX | FlashHit |
| Notes | Short hit reaction |

### Common_Buff — AoE Buff

| Property | Value |
|------|------|
| Duration | ~0.73s |
| Collision | None |
| **EventTrack** | **ActiveTrigger** (~0.58s mark) |
| VFX | VFX_Portal |
| Notes | ActiveTrigger → IceAoE handler → AoE persistent damage |

### Common_Down — Knockdown

| Property | Value |
|------|------|
| Duration | ~3.85s |
| AnimationTrack | 3 (fall → ground → get up) |
| Collision | None |
| VFX | VFX, VFX2 |

### Common_Rolling — Roll

| Property | Value |
|------|------|
| Duration | **3.0s** |
| Collision | None |
| VFX | VFX_Dash |

### Common_Knockback_Back — Backward Knockback Reaction

| Property | Value |
|------|------|
| Duration | 1.0s |
| Collision | None |
| Tracks | AnimationTrack + TriggerTrack only (minimal) |

### Common_Knockback_Front — Forward Knockback Reaction

| Property | Value |
|------|------|
| Duration | ~1.17s |
| Collision | None |
| Tracks | AnimationTrack + TriggerTrack only (minimal) |

### Common_PowerPush — Push

| Property | Value |
|------|------|
| Duration | ~0.57s |
| Collision | HitTrigger ×1 (Box) |
| VFX | VFX_ImpactLink |

### Common_Stun — Stun

| Property | Value |
|------|------|
| Duration | ~2.77s |
| AnimationTrack | 2 |
| Collision | None |
| VFX | VFX_Stun, VFX_Hit |

### Common_Heal1 — Heal 1

| Property | Value |
|------|------|
| Duration | ~1.52s |
| AnimationTrack | 2 |
| Collision | None |
| **EventTrack** | **ActiveTrigger** (~0.52s mark) |
| VFX | VFX_SoftHeal |
| Notes | Heal logic via ActiveTrigger |

### Common_Heal2 — Heal 2

| Property | Value |
|------|------|
| Duration | ~1.35s |
| Collision | None |
| **EventTrack** | **ActiveTrigger** (~0.31s mark) |
| VFX | VFX_SoftHeal |

---

## Summary Statistics

| Category | Count | Status | Notes |
|----------|:---:|:---:|------|
| Punch | 4 | **In use** | Fist weapon exclusive |
| Sword | 5 | **In use** | Longsword weapon exclusive |
| Gun | 3 | **In use** | Gun weapon exclusive |
| Bow | 2 | Unused | Pre-built for future expansion |
| Spear | 3 | Unused | Pre-built for future expansion |
| TwoHandedSword | 2 | Unused | Pre-built for future expansion |
| Common | 12 | **Partial use** | Block, Tumbling, Hit, Buff, etc. currently used |
| **Total** | **31** | | |

### Sequences with EventTrack (ActiveTrigger)

| Sequence | Event Name | Purpose |
|--------|-------------|------|
| Common_Buff | ActiveTrigger | IceAoE area damage |
| Common_Heal1 | ActiveTrigger | Heal logic |
| Common_Heal2 | ActiveTrigger | Heal logic |
| Spear_Skill_Ultimate | Dash | Dash movement (special) |
