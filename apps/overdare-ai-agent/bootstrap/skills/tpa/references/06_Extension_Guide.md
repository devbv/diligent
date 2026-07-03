# Extension Guide

Content additions (skills, characters, weapons) can be done with **only data file edits + plugin file additions**.
No core code modifications needed.

---

## Quick Reference

| Goal | Files to Modify | Layer |
|------|------------|--------|
| Change skill damage/cooldown | SkillDB | Data |
| Change character stats | CharDB | Data |
| Assign different skills to weapon | WeaponDB | Data |
| Add new skill | SkillDB + Action Sequence asset | Data |
| Add new character | CharDB + AssetDB | Data |
| Add new weapon | WeaponDB (+ Tool model) | Data |
| Additional slot (Skill2) | WeaponDB + SkillDB (SlotDef auto-derived) | Data |
| New button type (Ultimate, etc.) | Create SlotDef/{Name}.lua | Plugin |
| New behavior type (Charge, etc.) | Create StateBehavior/{Name}.lua | Plugin |
| Custom hit handler | Create SequenceHandler/Hit/{Name}.lua | Plugin |
| Custom active handler | Create SequenceHandler/Active/{Name}.lua | Plugin |
| Custom hit timing names | Set `HitTriggers` in SkillDB | Data |
| Hit VFX on target | Set `TargetHitVFX` in SkillDB + add VFX Part under `ReplicatedStorage/Model/VFX` | Data + Editor |
| Custom active timing names | Set `ActiveTriggers` in SkillDB | Data |
| Persistent effect (AoE zone/projectile/trap) | Active handler + PersistentEffectManager.Register | Plugin |
| Custom weapon UI | Place button prefabs in UI/Weapon/{WeaponName}/ | Editor |
| Smooth combo/recovery cancel | Add CancelWindow TriggerTrack in Action Sequence editor | Editor |
| Custom action timing | Add EventTrack marker and list it in `ActiveTriggers` | Editor + Data |

---

## Adding a New Skill

### Step 1: Add Skill Data to SkillDB

> **Level Browser:** `ReplicatedStorage > Data > SkillDB`

```lua
FireBreath = {
    Damage = 15, Cooldown = 4, EnergyCost = 20,
    WalkSpeed = 0,
    RotationSpeed = 0,
    Knockback = 30,
    TargetHitVFX = "FireHit",
    HitTriggers = { "FlameHit" },
    ActiveHandler = "FireBreath",
    ActiveTriggers = { "SpawnFlame" },
},
```

### Step 2: Create Action Sequence Asset

Create an Action Sequence asset named **"FireBreath"** in OVERDARE Studio.

Required/optional tracks:

| Track | Required | Purpose |
|------|:---------:|------|
| AnimationTrack | **Required** | Character animation |
| TriggerTrack "Sequence" | **Required** | Sequence lifetime management |
| TriggerTrack "ActiveSkill" | Conventional | Skill active window |
| CollisionTrack "HitTrigger" | Required for attacks | Hit detection. Rename freely when listed in `HitTriggers` |
| TriggerTrack "CancelWindow" | Optional | Late-sequence cancel |
| TriggerTrack "KeyInput" | Combo only | Combo input acceptance window |
| EventTrack "ActiveTrigger" | Optional | Custom action callback. Rename freely when listed in `ActiveTriggers` |

### Step 3: Place Runtime Scripts

Place ServerRuntime + ClientRuntime templates inside the Action Sequence asset.

> **Template path:** `ReplicatedStorage > Template > ActionSequence`

### Step 4: Assign in WeaponDB

> **Level Browser:** `ReplicatedStorage > Data > WeaponDB`

```lua
Staff = {
    Attack = { "StaffAttack1", "StaffAttack2" },
    Skill = "FireBreath",    -- newly added skill
    Guard = "Common_Block",
    Dash = "Common_Tumbling",
    SpecialSkill = "StaffUltimate",
},
```

---

## Adding a New Character

### Step 1: Add Character to CharDB

> **Level Browser:** `ReplicatedStorage > Data > CharDB`

```lua
CharE = {
    Order = 4,
    DisplayName = "Assassin",
    MaxHp = 90,
    WalkSpeed = 700,
    RotationSpeed = 10,
    ResourceType = "Energy",
    ResourceMax = 80,
    ResourceRegen = 0,
    ResourceGainOnHit = 12,
    HitReaction = "Common_Hit",
    DefaultWeapon = "Dagger",
},
```

### Step 2: Add Weapon to WeaponDB

```lua
Dagger = {
    Tool = "Dagger",
    Attack = { "DaggerSlash1", "DaggerSlash2" },
    Skill = "ShadowStrike",
    Guard = "Parry",
    Dash = "Common_Tumbling",
    SpecialSkill = "Assassination",
},
```

### Step 3: Add Skills to SkillDB

Add all skill entries used by the new weapon to SkillDB.

### Step 4: Add Assets to AssetDB

> **Level Browser:** `ReplicatedStorage > Data > AssetDB`

```lua
Characters = {
    CharE = {
        Portrait = "ovdrassetid://...",
        SelectImage = "ovdrassetid://...",
    },
},
Skills = {
    DaggerSlash1 = { Icon = "ovdrassetid://..." },
    ShadowStrike = { Icon = "ovdrassetid://..." },
    -- ...
},
```

### Step 5: Create Action Sequence Assets

Create an Action Sequence asset for each new skill.

---

## Adding a New Weapon (For Existing Characters)

1. Add weapon entry to `WeaponDB` (skill slot mappings)
2. Add new skills to `SkillDB` (if needed)
3. Create Action Sequence assets
4. Equip weapon in server code: `ServerController.EquipWeapon(player, "NewWeaponName")`

---

## Additional Slots (e.g. Skill2)

No separate SlotDef file needed — just modify WeaponDB.

1. Add slot to `WeaponDB`: `Skill2 = "IceBlast"`
2. Add skill to `SkillDB`: `IceBlast = { ... }`
3. SlotDef is **auto-derived** from "Skill" (only name and priority are adjusted)
4. If `Skill2Button` exists in the UI frame, it auto-maps

---

## Custom Weapon UI (Button Override)

Place custom buttons in `ReplicatedStorage > UI > Weapon > {WeaponName}/`.

```
ReplicatedStorage/UI/Weapon/Gun/
  ├── AttackButton
  ├── SkillButton
  ├── Skill2Button     ← Custom size/position
  ├── GuardButton
  ├── DashButton
  └── SpecialSkillButton
```

- Folder name = WeaponDB key (e.g. `Gun`, `Longsword`)
- Button name = `{SlotName}Button` convention
- If the folder exists, all default buttons are hidden and custom buttons are cloned
- Applied by editor folder placement only — no code changes needed

---

## Plugin Extension Principles

Existing plugins (DefaultHit, IceAoE, Combo, etc.) are **reference implementations provided by the template**.

| Scenario | Correct Approach |
|------|------------|
| Similar purpose + currently unused | Modify existing file |
| Different purpose or currently in use | **Create new file in same folder** |

### Examples

| Goal | Wrong Approach | Correct Approach |
|------|------------|------------|
| Multi-explosion | Modify IceAoE.lua | Create Active/MultiExplosion.lua |
| Projectile hit | Modify DefaultHit.lua | Create Hit/ProjectileHit.lua |
| Charge attack | Modify Combo.lua | Create StateBehavior/Charge.lua |

### HitHandler

Hit handlers live in `ServerStorage > Module > SequenceHandler > Hit`.

Use `HitTriggers` when the same skill has custom CollisionTrack names:

```lua
HeavySlash = {
    Damage = 40,
    HitTriggers = { "FirstSlash", "FinalSlash" },
}
```

Use `HitHandler` when the hit needs custom processing:

```lua
PiercingShot = {
    Damage = 25,
    HitHandler = "ProjectileHit",
    HitTriggers = { "ProjectileHit" },
}
```

Custom hit handlers can use one of three shapes:

- `Bind(actionSequence, character, charModel, config)` for full control over binding.
- `ProcessHit(charModel, target, config, hitContext)` to replace default hit processing while reusing default CollisionTrack binding.
- `Execute(ctx)` to run per hit with a context table. Return `true` when fully handled, or call `ctx.applyDefault()` to reuse default damage.

For most custom hit logic, start with `Execute(ctx)`.

Create a ModuleScript under:

```text
ServerStorage/Module/SequenceHandler/Hit/CustomHit.lua
```

Then connect it from SkillDB:

```lua
Punch_Attack2 = {
    Damage = 15,
    WalkSpeed = 0,
    RotationSpeed = 0,
    Knockback = 30,
    HitHandler = "CustomHit",
    HitTriggers = { "CustomHit" },
}
```

The Action Sequence CollisionTrack name must also be `CustomHit`.

Example `CustomHit.lua`: apply normal damage once, then force the same default damage again after 1 second.

```lua
local CustomHit = {}

local SECOND_HIT_DELAY = 1

local function isTargetStillValid(target)
    if not target then
        return false
    end

    local ok, parent = pcall(function()
        return target.Parent
    end)

    return ok and parent ~= nil
end

function CustomHit.Execute(ctx)
    ctx.applyDefault()

    local target = ctx.targetChar or ctx.target

    task.delay(SECOND_HIT_DELAY, function()
        if not isTargetStillValid(target) then
            return
        end

        ctx.applyDefault()
    end)

    return true
end

return CustomHit
```

`ctx` contains:

| Field | Description |
|------|------|
| `ctx.triggerName` | CollisionTrack name that fired |
| `ctx.skillConfig` | Current SkillDB config |
| `ctx.character` | Attacker character |
| `ctx.targetChar` / `ctx.target` | Hit target character |
| `ctx.hitContext` | Extra hit info such as `sequenceId` and `triggerName` |
| `ctx.applyDefault([overrideConfig])` | Reuse DefaultHit damage processing |

If `ctx.applyDefault()` is called, default `Damage`, `Knockback`, `HitEffects`, `SelfEffects`, and resource feedback are reused. Passing an override table lets the handler adjust values for that hit only:

```lua
ctx.applyDefault({
    Damage = (ctx.skillConfig.Damage or 0) * 2,
    Knockback = 100,
})
```

### Target Hit Motion, Super Armor, and Invincibility

Use `TargetHitMotion` when an attack should choose the target's hit reaction state or hit reaction Action Sequence.

```lua
HeavyPunch = {
    Damage = 25,
    Knockback = 500,
    TargetHitMotion = {
        TargetState = "Hit",       -- Hit / Stun / Down
        SequenceId = "Common_Hit2",
    },
}
```

Hit reaction sequences such as `Common_Hit2` may keep the normal one-line `ServerRuntime`.

If the sequence name is not connected to the current character's weapon slots, `SequencerController` falls back to `SkillDB[SequenceName]` and treats it as a standalone sequence. In that mode it binds only basic movement settings such as `WalkSpeed` and `RotationSpeed`; attack-specific wiring such as Hit, Combo, CancelWindow, Hold, SequenceEnd, and ActiveTrigger is skipped.

Use `SuperArmor` or `Invincible` on the skill being performed by the character who gets hit.

```lua
ChargeSlash = {
    Damage = 40,
    SuperArmor = true, -- takes damage, but ignores hit reaction and knockback
}

UltimateCut = {
    Damage = 80,
    Invincible = true, -- ignores damage, hit reaction, and knockback
}
```

`Knockback` applies horizontal velocity to the target. It is ignored if the target is currently using a `SuperArmor` or `Invincible` skill.

### Target Hit VFX

Use `TargetHitVFX` when an attack should play a hit visual effect on the target.

```lua
HeavySlash = {
    Damage = 40,
    TargetHitVFX = "SwordSlash",
}
```

The value must match a Part under:

```text
ReplicatedStorage/Model/VFX/{VFXName}
```

Required VFX Part structure:

```text
ReplicatedStorage
└─ Model
   └─ VFX
      └─ SwordSlash (Part)
         └─ ParticleEmitter
```

Recommended Part settings:

- `Anchored = true`
- `CanCollide = false`
- `CanQuery = false`
- `CanTouch = false`
- `Transparency = 1`
- Template `VFXPreset.Enabled = false` or `ParticleEmitter.Enabled = false`

Runtime module:

```text
ServerStorage/Module/View/HitVFXView
```

`HitVFXView` plays VFX on the server using `PoolingUtil`. It clones the Part, waits one tick after clone/acquire for Studio stability, places it at the target, and plays a direct child `VFXPreset` or `ParticleEmitter`.

- `VFXPreset`: set `Enabled = true`.
- `ParticleEmitter`: set `Enabled = true`, wait briefly, then call `Emit(1)`.
- Release: set effects to `Enabled = false`, wait one tick, move the Part to `ReplicatedStorage/Pooling`, then return it to the pool after a short reuse cooldown.

### ActiveHandler

Active handlers live in `ServerStorage > Module > SequenceHandler > Active`.

Use `ActiveTrigger` as the concept of "run this extra action at this exact timeline moment." It is good for projectiles, teleports, AoE zones, heals, buffs, summons, and staged skill logic.

```lua
Fireball = {
    Cooldown = 4,
    ActiveHandler = "Fireball",
    ActiveTriggers = { "ShootTrigger" },
}

ChargeSweep = {
    ActiveHandler = "ChargeSweep",
    ActiveTriggers = { "ReadyTrigger", "StartTrigger", "EndTrigger" },
}
```

---

## Utilizing Pre-Built Unused Assets

The project includes pre-built sequence assets that are not currently in use.
These can be leveraged when adding new weapons/characters.

| Category | Assets | Status |
|----------|------|------|
| Bow | Bow_Skill1, Bow_Skill2 | Unused — use when adding bow character |
| Spear | Spear_Attack1, Spear_Skill1, Spear_Skill_Ultimate | Unused — use when adding spear character |
| TwoHandedSword | TwoHandedSword_Attack, TwoHandedSword_Skill | Unused — use when adding two-handed sword character |
| Common | Common_Down, Common_Rolling, Common_Knockback_Back/Front, Common_PowerPush, Common_Stun, Common_Heal1, Common_Heal2 | Unused — usable as reaction/support skills |

To use: simply add entries to WeaponDB/SkillDB and the existing assets will auto-connect.
