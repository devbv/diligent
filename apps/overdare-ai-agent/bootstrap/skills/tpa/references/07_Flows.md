# Execution Flows

## Input Flow

```
BtnController (Client)
  → Icon button press feedback (ImageColor3 dim → auto-restore after 0.15s)
  → RequestAbility:FireServer("Skill")
    → ServerController
      → model:HandleInput("Skill")
        → SlotManager.Validate() — cooldown + resource + SlotDef
          → FAIL: _sendFeedback → rejection UI
          → OK:
            → fsm:RequestChange("Skill") → pending registered
            → resource:Spend(cost)
            → resource:StartCooldown(slot, duration)
            → fsm:FlushPending() → GenericActionState:Enter committed
            → humanoid:GetActionRunner():Play(sequencerId)
              → ServerRuntime → SequencerController.Bind(script)
                → _findCharacter() walks ancestor chain (depth-independent)
                → seqName suffix (_N) fallback for Config lookup
                → Auto-binds Movement, Hit, Combo, CancelWindow, Hold, End
```

Key: Controller calls `HandleInput` once. It handles validation, FSM, resource, and sequence internally.

## Combat Flow

```
SequencerController._bindHit → DefaultHit.Bind
  → actionSequencer:Hit("HitTrigger") fires
    → charModel:OnHit(target, skillConfig)
      → DefaultHit.ProcessHit
        → CombatModel.ApplyDamage(attacker, target, params)
          → CreateIntent
          → OnBeforeDamage hooks (guard reduction)
          → CombatView.ApplyDamage (HP subtraction)
          → MovementView.Knockback (optional)
          → StatusEffectModel.Apply (effects, optional)
          → OnDamageDealt hooks (energy gain)
          → target CharacterModel:OnDamaged → FSM Hit/Down/Stun
```

## Combo Flow

**Mode A — Wait for sequence end:**
1. HandleInput("Attack") → FSM enters Attack → Play "Punch1"
2. User presses Attack again → FSM rejects (same state) → `buffered = true`
3. Punch1 sequence ends → OnSequenceEnd → AdvanceCombo → FSM → Idle
4. Next HandleInput → _resolveCombo picks step 2 → Play "Punch2"

**Mode B — CancelWindow instant transition:**
1. HandleInput("Attack") → Play "Punch1"
2. User presses Attack → `buffered = true`
3. TriggerTrack "CancelWindow" Started → checks buffered → AdvanceComboImmediate → Play "Punch2" immediately
4. `_comboAdvancing = true` → previous sequence's OnSequenceEnd skips Idle transition
5. Punch2 ends normally → FSM → Idle

**Mode C — General cancel (different slot):**
1. HandleInput("Skill") → Play "GroundSlam"
2. CancelWindow range entered → cancelable = true
3. User presses Dash → HandleInput checks cancelable → FSM Idle → re-invokes HandleInput("Dash")
4. "Tumbling" plays immediately

Key difference: Mode B uses CancelWindow TriggerTrack range for seamless combo transition. Mode C uses the same CancelWindow for cross-slot cancel.

## Hold Skill Release Flow

```
BtnController (Client) — button release
  → Icon button restore (ImageColor3 → 255,255,255)
  → StopAbility:FireServer("Guard")
    → ServerController
      → model:HandleStop("Guard")
        → verify _activeHold == "Guard"
        → charConfig["Guard"] → resolve sequencerId (e.g. "SwordGuard")
        → fsm:RequestChange("Idle") + FlushPending()
          → Hold.Exit → MovementView.Unlock (restore movement)
        → ActionRunner:Stop(sequencerId)
          → engine triggers delayed destroy (DelayedDestroy_...)
```

Key: FSM transition is committed before Stop via FlushPending. `ActionRunner:Stop(seqId)` requires the sequence ID — calling Stop() without args is a no-op.

## Character Select Flow

```
CharSelectView (Client) → SelectCharacter:FireServer(charId)
  → ServerController.OnSelectCharacter
    → CharDB[charId] validate
    → ConfigUtil.ResolveConfig(charId, defaultWeapon) — merge
    → model:SetCharacterConfig(mergedConfig) — swap config, keep model
    → _swapTool() — equip new Tool
    → Update StringValues (SelectedCharacter, EquippedWeapon)
```

Character change = merge new config + SetCharacterConfig. Model object is preserved.

## Weapon Equip Flow

`EquipWeapon(player, weaponId)` → validate → AddToBackpack → ConfigUtil merge → SetCharacterConfig(config, true) (HP preserved) → swap Tool → update StringValue.

## Resource Preload Flow (Loading Screen)

```
LoadingScreen (Client LocalScript, under StarterGui/LoadingScreen)
  → Bar.Size = UDim2.new(0,0,1,0), LoadingText.Text = "0 %"
  → Wait for localPlayer.Character (or CharacterAdded:Wait)
  → character:WaitForChild("Humanoid")
  → AssetLoaderUtil.PreloadAnimations(humanoid, AssetDB.Resource, options)
    → Batch-create one temp Animation instance per AssetDB.Resource entry (set ovdrassetid)
    → Animator:LoadAnimation(anim) for each entry (parallel download starts)
    → Wait for each track.Length > 0 (timeout 0.2s)
      → onProgress(i/total, i, total)
        → Bar.Size = UDim2.new(ratio, 0, 1, 0)
        → LoadingText.Text = "N %"
    → Destroy all temp Animation instances
    → onComplete()
      → task.wait(0.3)
      → screenGui.Enabled = false
```

Key: AssetLoaderUtil has no knowledge of AssetDB. The caller (LoadingScreen) passes `AssetDB.Resource` array directly. Util handles pure loading mechanics only.

## Spawn Flow

`CharacterAdded` → create CharacterModel → equip Tool → monitor ChildAdded for pickup → Humanoid.Died → Dead state.
