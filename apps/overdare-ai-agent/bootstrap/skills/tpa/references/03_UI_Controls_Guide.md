# UI & Controls Guide

## Button Layout

Skill buttons are automatically generated based on the character's weapon.

### Default Button Configuration

Button names follow the `{SlotName}Button` convention.

| Slot | Button Name | Input |
|------|-----------|-----------|
| Attack | AttackButton | Touch (Press) → auto-chains combo |
| Skill | SkillButton | Touch (Press) |
| Skill2 | Skill2Button | Touch (Press) — Gun only |
| Guard | GuardButton | **Press & Hold** → releases on lift |
| Dash | DashButton | Touch (Press) |
| SpecialSkill | SpecialSkillButton | Touch (Press) |

### Button Icons

- Skill icons (ovdrassetid) are registered in the Skills section of `AssetDB.lua`.
- If an icon exists, text and background are hidden and only the icon image is shown.
- If no icon exists, the slot name text is displayed.

### Button Visual Feedback

| State | Feedback |
|------|--------|
| Button pressed | ImageColor3 darkens (180,180,180) → restores after 0.15s |
| Holding | Stays dark → restores on release |
| On cooldown | ImageColor3 darkens (100,100,100) + cooldown overlay |
| Unavailable (insufficient resource, etc.) | Red flash (150,30,30) → restores after 0.2s |

### Per-Weapon Custom UI

Custom button layouts can be created per weapon.

> **Level Browser path:** `ReplicatedStorage > UI > Weapon > {WeaponName} > {SlotName}Button`

If the folder exists, default buttons are hidden and custom buttons are cloned.
If no folder exists, default buttons are used (current project uses default buttons).

> Related code:
> - `ReplicatedStorage > Module > View > ButtonLayout` (button creation/placement)
> - `ReplicatedStorage > Module > View > BtnController` (input handling)
> - `ReplicatedStorage > Module > View > FeedbackView` (visual feedback)

---

## HP Bar System

### Local Player HP Bar

- Displayed as a ScreenGui at the top-center of the screen.
- Text size auto-scales with TextScaled.
- Color changes based on HP ratio: Green (100%) → Yellow (50%) → Red (0%)

### Other Player HP Bars

- Displayed as a BillboardGui above HumanoidRootPart (overhead).
- Same HP ratio → color interpolation applies.

> **Level Browser path:** `StarterPlayerScripts > CharacterHpBar` (LocalScript)
>
> Related utility:
> - `ReplicatedStorage > Module > Util > GaugeUtil` (gauge size/text updates)

---

## Character Selection UI

- Character selection buttons are auto-generated in CharDB's `Order` sequence.
- Pressing a button sends the `SelectCharacter` RemoteEvent to the server.
- The server swaps the character configuration and default weapon accordingly.

| Order | Character | Display Name |
|:---:|--------|-----------|
| 1 | CharA | Punch |
| 2 | CharB | Sword |
| 3 | CharD | Gunner |

> **Level Browser path:** `ReplicatedStorage > Module > View > CharSelectView`

---

## Loading Screen

A loading screen is shown at game start to preload animation resources.

### Loading Flow

1. Wait for character spawn → get Humanoid
2. Batch preload animation resources from `AssetDB.Resource` via `AssetLoaderUtil.PreloadAnimations`
3. Loading progress displayed as bar gauge + percentage text
4. Loading screen deactivated 0.3s after completion

### Currently Preloaded Resources

A total of **41** animation resources (ovdrassetid) are registered in `AssetDB.Resource`.

| Category | Count | Notes |
|----------|:---:|------|
| Punch | 5 | Brawler animations |
| Sword | 6 | Sword animations |
| TwoHandedSword | 2 | Two-handed sword animations |
| Bow | 5 | Bow animations |
| Spear | 3 | Spear animations |
| Gun | 5 | Gun animations |
| Common | 15 | Shared (hit, dodge, down, etc.) |

### UI Structure

```
ScreenGui (script.Parent)
  └── Frame
       └── LoadingFrame
            ├── Bar          ← Gauge (width 0→1)
            ├── LoadingText  ← "N %" text
            └── Loading      ← Loading indicator text
```

> **Level Browser path:** `StarterGui > LoadingScreen`
>
> Related utility: `ReplicatedStorage > Module > Util > AssetLoaderUtil`

---

## Resource Gauge (Energy)

- The character's Energy value is displayed as a gauge.
- `FeedbackView` reads the resource value and updates the gauge.
- The server syncs to the Player's NumberValue every Heartbeat.

> Related code:
> - `ServerStorage > Module > Model > ResourceModel` (server-side resource management)
> - `ReplicatedStorage > Module > View > FeedbackView` (client-side gauge display)
