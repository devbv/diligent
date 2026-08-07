---
name: vfx-recipe
description: "Use for OVERDARE Studio custom visual effect (VFX) requests — effects the user describes by look, mood, element, or composition rather than by a preset name: explosions, bursts, splashes, smoke, fire pillars, sparks, magic hits, toxic slime, frost, electric shocks, and any 'make an effect where …' request. Builds a VFXRecipe instance by adapting an official recipe template found via overdaresearch source=vfx, or composing serving VFX sources directly. NOT for ready-made named effects (fire, barrier, healing aura by simple selection) — those use VFXPreset via studiorpc_instance_upsert directly. Not for particle work on Beam/Trail/ParticleEmitter instances."
---

# vfx-recipe

Build custom layered effects as **VFXRecipe** instances: three layers (BaseLayer / DetailLayer / ExtraLayer), each an array of source items playing a serving VFX source asset with per-source user parameters. Runtime scripts can tune a placed recipe via `SetParam` / `SetParamAt` using each source item's `Name`.

## Gate: VFXPreset vs VFXRecipe

- The request names or clearly matches a **ready-made effect** applied by selection (quick fire, explosion, barrier, healing) → create a `VFXPreset` instead; do not use this skill.
- The request describes a **custom look or composition** (specific colors, mixed materials like "liquid splashing with smoke", tuned intensity/duration) → proceed here.

## Workflow (template-first)

1. **Search**: `overdaresearch` with `source: "vfx"`, `topK: 3`. Query by element, mood, or pattern in English (e.g. "acid liquid smoke burst", "fire pillar with ground decal"). Results carry the full doc text — no second fetch.
2. **Prefer a template**: a `docType: "recipe_combo"` hit that matches the request is the best starting point. Copy its **Original Payload JSON** section as the `properties` of the upsert.
3. **Adapt the payload**:
   - Change the element/theme by swapping **Color / Alpha keypoints only**, not sources (e.g. shift all layers to `#FF3000` tones for lava, `#3080FF` for frost). Swap a source only when the shape of the motion is wrong.
   - Scale intensity by adjusting `SpawnCount` / `SpawnRate` together across layers.
   - Keep `Alpha` arrays as-is unless fading differently.
   - The top-level `LoopDuration` in template payloads is a read-only derived value — the tool accepts and ignores it, so pasting the payload verbatim is safe.
4. **No template fits**: compose from `docType: "vfx_source"` catalog entries. Rules: at least one **BaseLayer** item (the effect's body); Detail/Extra are optional accents; `neutral`-element sources are the universal fallback base; use each result's `resourceName` directly as `NiagaraSystem`.
5. **Create**: `studiorpc_instance_upsert` with `class: "VFXRecipe"`, parented under the target Workspace object. `NiagaraSystem` takes the short source name (preferred) or a full serving-asset path — both validate against the layer's allowed sources.

## Rate vs Burst sources

Sources with `_R` in the name are **Rate emitters**: set `Duration` (seconds) and `SpawnRate` (particles/sec). All others are **Burst emitters**: set `SpawnCount` (particles per activation). Never set Burst parameters on a Rate source or vice versa — the source ignores unsupported parameters.

## Gotchas

- `LiquidScatter_R_A` exists in **both** BaseLayer and ExtraLayer as distinct assets; the layer you place it in decides which asset plays.
- A source from another layer is rejected by schema validation — the error lists the layer's valid sources.
- `ObjectType` tags (`Vector3` / `Color3` / `Content`) are injected by the sidecar — author plain `{X,Y,Z}`, `{R,G,B,Time}`, `{Content}` values; tagged values from template payloads also pass.
- Each source item supports only a subset of the user parameters (see the source's catalog entry); unsupported parameters are silently ignored.
- Playback: `AutoActivate` (default true), `InfiniteLoop` (default true), `LoopCount` (used when `InfiniteLoop=false`). One-shot effects: `InfiniteLoop: false, LoopCount: 1`.
