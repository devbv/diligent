---
name: vfx-recipe
description: "Use for every OVERDARE Studio visual effect (VFX) request: creating effects (explosions, bursts, splashes, smoke, fire, sparks, magic hits, slime, frost, electric shocks, auras, 'make an effect where …'), and editing effects that already exist in the level (change colors/intensity/duration, swap or add a source in a placed VFXRecipe, restructure its layers). Asks the user upfront whether to use a ready-made preset, adapt a recipe template, or compose from raw sources, then searches the reference data bundled in this skill. Not for particle work on Beam/Trail/ParticleEmitter instances."
---

# vfx-recipe

Owns all VFX effect work in OVERDARE Studio. All VFX reference data is bundled in this skill's `references/` directory — search it with the built-in `grep`/`read` tools. Never search the network for VFX data.

| Unit | Reference | What it is | How it's used |
|---|---|---|---|
| **Preset** | `references/presets.md` | Ready-made named effect | Create a `VFXPreset` instance with its resource name as `PresetName` — used as-is, no internal editing |
| **Template** | `references/templates/` | A recipe pre-composed from several sources | Copy its Original Payload JSON as a `VFXRecipe` — verbatim, or with sources swapped / structure modified |
| **Source** | `references/sources.md` | One raw ingredient asset for a recipe layer (Base/Detail/Extra) | Placed as items inside a `VFXRecipe`'s layer arrays |

A **recipe** is the placed `VFXRecipe` instance itself — created and edited through `studiorpc_instance_upsert` like any other Studio instance. Runtime scripts tune a placed recipe via `SetParam` / `SetParamAt` using each source item's `Name`.

## Routing — ask the user first

For a **new effect request**, ALWAYS start by asking how to build it, via `request_user_input`:

- question: `이 이펙트를 어떻게 만들까요?`
- options (labels/descriptions verbatim):
  1. **기성 이펙트 사용** — `공식 이펙트 중 가장 잘 맞는 걸 바로 적용해요. 가장 빠르고 안정적이지만 내부 구조는 못 바꿔요.`
  2. **레시피 기반 커스텀 (권장)** — `비슷한 공식 레시피를 복사한 뒤 요청에 맞게 수정해요 (색·강도 조절, 파티클 교체·추가).`
  3. **완전 커스텀** — `파티클 재료를 골라 레이어를 직접 조합해요. 자유도가 가장 높아요.`

Skip the question only when:
- the request already names the method ("프리셋으로 해줘", "직접 조합해서 만들어줘") — proceed with that method, or
- the request edits a VFXRecipe that already exists in the level — go straight to the edit flow below.

If the chosen path yields no acceptable match, say so and offer the next path down (preset → template → custom).

## Flow: preset

1. `grep` `references/presets.md` case-insensitively with English keywords from the request (element, mood, purpose — e.g. `muzzle|gunfire`, `heal|buff`). Try synonyms before concluding there is no match. Each row is `| Resource | DisplayName | Category | Subcategory | Genre | Keywords |`.
2. Present the top 2–4 matching presets via `request_user_input` — label = DisplayName (fall back to Resource), description = category + keywords — **plus one extra option: `레시피 기반 커스텀으로 만들기` (switch to the template flow)**.
3. On selection, `studiorpc_instance_upsert` with `class: "VFXPreset"`, `PresetName` = the Resource value, parented under the target Workspace object.

## Flow: template-based recipe

1. Read `references/templates/00_INDEX.md` and pick the 2–3 templates closest to the request (match on title, category, elements, keywords).
2. Present them via `request_user_input` — label = template title, description = elements + sources — **plus one extra option: `완전 커스텀으로 만들기` (switch to the direct-composition flow)**.
3. Read the chosen `combo_*.md` file and copy its **Original Payload JSON** as the upsert `properties`. Pasting verbatim is safe: the top-level `LoopDuration` (read-only derived value) is accepted and ignored, and `Alpha` arrays pass through.
4. Adapt as requested:
   - **Theme/element change**: swap **Color / Alpha keypoints only** (e.g. all layers toward `#FF3000` for lava, `#3080FF` for frost). Keep the sources.
   - **Motion/shape change**: swap a source item's `NiagaraSystem` for another source **from the same layer** (check `references/sources.md`), or add/remove source items — keep at least one BaseLayer item.
   - **Intensity**: scale `SpawnCount` / `SpawnRate` together across layers.
5. `studiorpc_instance_upsert` with `class: "VFXRecipe"`, parented under the target Workspace object.

## Flow: direct composition

1. Read `references/sources.md` and plan layers: **BaseLayer** carries the effect's body (at least one item; `neutral`-element sources are the universal fallback), DetailLayer/ExtraLayer add accents and residue.
2. Use each source's short name as `NiagaraSystem` — the resource name minus its `VFX_UGC_<Layer>_` prefix (e.g. `VFX_UGC_Base_FireRise_A` → `FireRise_A`). Full resource names and full serving-asset paths also validate.
3. Set per-source parameters the chosen source supports (its catalog entry lists them; unsupported ones are silently ignored).
4. Create the `VFXRecipe` via `studiorpc_instance_upsert` — prefer one call when the composition is already decided.

## Flow: edit an existing recipe

1. `studiorpc_instance_read` the placed VFXRecipe to get its current layer arrays.
2. Modify in place: swap a `NiagaraSystem` (same layer only), tweak parameters, add/remove source items. Layer arrays are replaced whole on update — always send the complete modified array, not a delta.
3. `studiorpc_instance_upsert` **update** form (by `guid`) with the changed layer properties.

## Rate vs Burst sources

Sources with `_R` in the name are **Rate emitters**: set `Duration` (seconds) and `SpawnRate` (particles/sec). All others are **Burst emitters**: set `SpawnCount` (particles per activation). Never set Burst parameters on a Rate source or vice versa.

## Gotchas

- Some short names exist in **multiple layers** as distinct assets — `LiquidScatter_R_A` and `LightRise_R_A` (Base and Extra), `SmokeBurst_A` (Base and Detail); the layer you place one in decides which asset plays.
- `EmptySprite` / `EmptySprite_R` (Element: Empty) are blank templates for manual authoring in the editor — never pick them when composing an effect.
- A source from another layer is rejected by schema validation — the error lists the layer's valid sources.
- `ObjectType` tags (`Vector3` / `Color3` / `Content`) are injected by the sidecar — author plain `{X,Y,Z}`, `{R,G,B,Time}`, `{Content}` values; tagged values from template payloads also pass.
- Playback: `AutoActivate` (default true), `InfiniteLoop` (default true), `LoopCount` (used when `InfiniteLoop=false`). One-shot effects: `InfiniteLoop: false, LoopCount: 1`.
- Total recipe length is derived (`LoopDuration` is read-only): to shorten an effect, adjust source `Duration`/`Delay` or swap the longest source — don't try to set `LoopDuration`.
