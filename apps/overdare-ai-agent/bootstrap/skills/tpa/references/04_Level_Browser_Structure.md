# Level Browser Structure

The project instance structure as viewed in OVERDARE Studio's Level Browser (explorer).

---

## Top-Level Service Structure

```
├── Workspace              ← Game world objects (parts, models, spawns, etc.)
├── ReplicatedStorage      ← Shared data, modules, UI, events, templates (server + client)
├── ServerStorage          ← Server-only modules (Model, Controller, View, Plugin)
├── StarterGui             ← Client GUI (loading screen, etc.)
├── StarterPlayerScripts   ← LocalScripts that auto-run on player join
└── ActionSequenceService ← Action Sequence asset management
```

---

## ReplicatedStorage (Server + Client Shared)

```
ReplicatedStorage/
├── 📁 Data/                         ← Game data (core config files)
│   ├── 📜 Enums                     ← Enum constants (InputType, StatusType, AoECenter)
│   ├── 📜 SkillDB                   ← All skill definitions (17 skills)
│   ├── 📜 CharDB                    ← Character stat definitions (3 characters)
│   ├── 📜 WeaponDB                  ← Weapon-skill slot mappings (3 weapons + None)
│   └── 📜 AssetDB                   ← Visual assets (icons, portraits, preload resources)
│
├── 📁 Module/
│   ├── 📁 Util/                     ← Utility modules
│   │   ├── 📜 ConfigUtil            ← CharDB + WeaponDB merge
│   │   ├── 📜 SlotUtil              ← Slot lookup, sequence reverse lookup
│   │   ├── 📜 AssetLoaderUtil       ← Animation load/preload
│   │   ├── 📜 ButtonUtil            ← Touch button binding (Press/Hold)
│   │   ├── 📜 CooldownUtil          ← Cooldown display/auto-release
│   │   ├── 📜 GaugeUtil             ← Gauge UI (HP, Energy, etc.)
│   │   ├── 📜 MovementUtil          ← Client movement (dash impulse)
│   │   ├── 📜 OverlapUtil           ← Area detection
│   │   ├── 📜 RayMoveUtil           ← Raycast-based movement
│   │   ├── 📜 TargetSnapUtil        ← Target snap/tracking
│   │   ├── 📜 ToggleGroupUtil       ← Group Show/Hide management
│   │   └── 📜 DropdownUtil          ← Dropdown UI
│   │
│   ├── 📁 View/                     ← Client view modules
│   │   ├── 📜 ButtonLayout          ← Button creation/placement (weapon override support)
│   │   ├── 📜 BtnController         ← Touch input → RequestAbility dispatch
│   │   ├── 📜 FeedbackView          ← Cooldown/deny/resource feedback
│   │   ├── 📜 HpBarView             ← HP bar display
│   │   └── 📜 CharSelectView        ← Character selection UI
│   │
│   └── 📜 ClientBridge              ← ClientRuntime binder (ClientDash/Teleport)
│
├── 📁 Event/                        ← RemoteEvents
│   ├── ⚡ RequestAbility            ← Client → Server skill request
│   ├── ⚡ StopAbility               ← Client → Server hold skill release
│   └── ⚡ SelectCharacter           ← Client → Server character selection
│
├── 📁 Model/
│   └── 📁 VFX/                      ← Server-spawned hit VFX Part templates
│       ├── 📜 FlashHit              ← Part with child VFXPreset
│       └── 📜 SwordSlash            ← Part with child ParticleEmitter
│
├── 📁 Pooling/                      ← Idle pooled runtime Parts returned by server systems
│
├── 📁 Template/
│   └── 📁 ActionSequence/           ← Runtime script templates
│       ├── 📄 ServerRuntime         ← SequencerController.Bind(script) (1 line)
│       └── 📄 ClientRuntime         ← ClientBridge.Bind(script) (1 line)
│
└── 📁 UI/
    └── 📁 Weapon/                   ← (Optional) Per-weapon custom button layouts
        └── 📁 {WeaponId}/           ← Folder name matches weapon name
            ├── AttackButton
            ├── SkillButton
            └── ...
```

> 📜 = ModuleScript, 📄 = Script/LocalScript, ⚡ = RemoteEvent, 📁 = Folder

---

## ServerStorage (Server Only)

```
ServerStorage/
└── 📁 Module/
    ├── 📁 Model/                     ← Business logic & state
    │   ├── 📜 CharacterModel         ← Per-player OOP instance (FSM, resource, combat owner)
    │   ├── 📜 CombatModel            ← Damage pipeline (Before/After hooks)
    │   ├── 📜 ResourceModel          ← Energy/Mana management (consume, gain, cooldown)
    │   ├── 📜 StatusEffectModel      ← Status effects (Slow, SpeedBoost, DoT, HoT, Custom)
    │   └── 📜 StateMachine           ← Priority-based FSM
    │
    ├── 📁 Controller/                ← Input routing & system control
    │   ├── 📜 ServerController       ← Main server entry point (Init, RemoteEvent handling)
    │   ├── 📜 SequencerController    ← ServerRuntime binding (Movement, Hit, Combo, Hold, End auto-wiring)
    │   ├── 📜 SlotManager            ← Plugin scanner (SlotDef, Handler, Behavior auto-load)
    │   └── 📜 PersistentEffectManager ← Manages effects that persist beyond sequence lifetime
    │
    ├── 📁 View/                      ← Server views (physics manipulation)
    │   ├── 📜 MovementView           ← Movement lock/unlock, knockback, dash
    │   ├── 📜 CombatView             ← HP decrease/recovery application
    │   └── 📜 HitVFXView             ← Server-side pooled TargetHitVFX playback
    │
    ├── 📁 SlotDef/                   ← Slot definition plugins (5 types)
    │   ├── 📜 Attack                 ← Priority 10, Combo behavior
    │   ├── 📜 Guard                  ← Priority 15, Hold behavior
    │   ├── 📜 Skill                  ← Priority 20, Action behavior
    │   ├── 📜 Dash                   ← Priority 25, Action behavior
    │   └── 📜 SpecialSkill           ← Priority 30, Action behavior
    │
    ├── 📁 SequenceHandler/           ← Sequence handler plugins
    │   ├── 📁 Hit/
    │   │   └── 📜 DefaultHit         ← Default hit processing (CollisionTrack → CombatModel.ApplyDamage)
    │   └── 📁 Active/
    │       └── 📜 IceAoE             ← AoE persistent damage (uses PersistentEffectManager)
    │
    └── 📁 StateBehavior/             ← FSM behavior delegation (3 types)
        ├── 📜 Action                 ← Press → execute → end
        ├── 📜 Combo                  ← Sequential attack chain
        └── 📜 Hold                   ← Maintained while pressed → releases on lift
```

---

## StarterGui (Client GUI)

```
StarterGui/
├── 📁 LoadingScreen/
│   └── 📄 LoadingScreen              ← Loading screen LocalScript
│       └── ScreenGui
│           └── Frame
│               └── LoadingFrame
│                   ├── Bar            ← Loading gauge
│                   ├── LoadingText    ← Percentage text
│                   └── Loading        ← Loading indicator text
│
├── 📁 ActionButton/                   ← Skill button UI frame
│   └── ...
│
└── 📁 CharacterSelect/               ← Character selection UI
    └── ...
```

---

## StarterPlayerScripts (Player Scripts)

```
StarterPlayerScripts/
└── 📄 CharacterHpBar                 ← HP bar management LocalScript
```

---

## ActionSequenceService (Action Sequence Assets)

Action Sequence assets are organized by weapon/common category folders.

```
ActionSequenceService/
├── 📁 Punch/                     ← Fist weapon sequences
│   ├── 🎬 Punch_Skill1
│   ├── 🎬 Punch_Skill_Ultimate
│   ├── 🎬 Punch_Attack1
│   └── 🎬 Punch_Attack2
│
├── 📁 Gun/                       ← Gun weapon sequences
│   ├── 🎬 Gun_Attack1
│   ├── 🎬 Gun_Skill1
│   └── 🎬 Gun_Skill2
│
├── 📁 Bow/                       ← Bow sequences (for future expansion)
│   ├── 🎬 Bow_Skill1
│   └── 🎬 Bow_Skill2
│
├── 📁 Spear/                     ← Spear sequences (for future expansion)
│   ├── 🎬 Spear_Attack1
│   ├── 🎬 Spear_Skill1
│   └── 🎬 Spear_Skill_Ultimate
│
├── 📁 Common/                    ← Shared sequences
│   ├── 🎬 Common_Block
│   ├── 🎬 Common_Tumbling
│   ├── 🎬 Common_Hit
│   ├── 🎬 Common_Buff
│   ├── 🎬 Common_Down
│   ├── 🎬 Common_Rolling
│   ├── 🎬 Common_Knockback_Back
│   ├── 🎬 Common_Knockback_Front
│   ├── 🎬 Common_PowerPush
│   ├── 🎬 Common_Stun
│   ├── 🎬 Common_Heal1
│   └── 🎬 Common_Heal2
│
├── 📁 Sword/                     ← Longsword weapon sequences
│   ├── 🎬 Sword_Attack1
│   ├── 🎬 Sword_Skill1
│   ├── 🎬 Sword_Attack2
│   ├── 🎬 Sword_Block
│   └── 🎬 Sword_Skill_Ultimate
│
└── 📁 TwoHandedSword/            ← Two-handed sword sequences (for future expansion)
    ├── 🎬 TwoHandedSword_Skill
    └── 🎬 TwoHandedSword_Attack
```

> 🎬 = ActionSequence instance

---

## Quick Data File Reference

| Purpose | Level Browser Path |
|------|-------------------|
| Change skill balance | `ReplicatedStorage > Data > SkillDB` |
| Change character stats | `ReplicatedStorage > Data > CharDB` |
| Change weapon slots | `ReplicatedStorage > Data > WeaponDB` |
| Icons/portraits/preload resources | `ReplicatedStorage > Data > AssetDB` |
| Enum constants | `ReplicatedStorage > Data > Enums` |
| Hit VFX Part templates | `ReplicatedStorage > Model > VFX > {VFXName}` |
| Idle pooled runtime Parts | `ReplicatedStorage > Pooling` |
| Add/modify slot definitions | `ServerStorage > Module > SlotDef > {Name}` |
| Add hit handlers | `ServerStorage > Module > SequenceHandler > Hit > {Name}` |
| Add active handlers | `ServerStorage > Module > SequenceHandler > Active > {Name}` |
| Add state behaviors | `ServerStorage > Module > StateBehavior > {Name}` |
| Server hit VFX playback module | `ServerStorage > Module > View > HitVFXView` |
| Action Sequence assets | `ActionSequenceService > {Category} > {SequenceName}` |
