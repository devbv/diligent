---
name: vfx-recipe
description: "Use for every OVERDARE Studio visual effect (VFX) request: creating effects (explosions, bursts, splashes, smoke, fire, sparks, magic hits, slime, frost, electric shocks, auras, 'make an effect where …'), and editing effects that already exist in the level (change colors/intensity/duration, swap or add a source in a placed VFXRecipe, restructure its layers). Routes across the three VFX units — presets (ready-made, used as-is), recipe templates (pre-composed recipes, usable as-is or modified), and VFX sources (raw per-layer ingredients for composing a VFXRecipe directly) — with escalation preset → template → direct composition, or straight to custom composition when the user wants it. Not for particle work on Beam/Trail/ParticleEmitter instances."
---

# vfx-recipe

Owns all VFX effect work in OVERDARE Studio. VFX comes in three searchable units, all served by `overdaresearch` with `source: "vfx"`:

| Unit | docType | What it is | How it's used |
|---|---|---|---|
| **Preset** | `vfx_preset` | Ready-made named effect | Create a `VFXPreset` instance with its `presetName` — used as-is, no internal editing |
| **Template (combo)** | `recipe_template` | A recipe pre-composed from several sources | Copy its Original Payload JSON as a `VFXRecipe` — verbatim, or with sources swapped / structure modified |
| **Source** | `vfx_source` | One raw ingredient asset for a recipe layer (Base/Detail/Extra) | Placed as items inside a `VFXRecipe`'s layer arrays |

A **recipe** is the placed `VFXRecipe` instance itself — created and edited through `studiorpc_instance_upsert` like any other Studio instance (the sidecar writes the .ovdrjm). Runtime scripts tune a placed recipe via `SetParam` / `SetParamAt` using each source item's `Name`.

## Routing

For a new effect request ("make a ~ effect"), escalate through the tiers — stop at the first that fits:

1. **Preset** — search `source: "vfx"` (no `vfxDocTypes` filter — presets rank naturally); a `vfx_preset` hit that matches the request as-is wins. Create `class: "VFXPreset"` with its `presetName`. If the user wants any customization a preset can't express (specific colors, composition, timing), skip this tier.
2. **Template** — search with `vfxDocTypes: ["recipe_template"]`; a hit close to the request wins. Copy its Original Payload JSON into `class: "VFXRecipe"` properties; adapt as needed (see below).
3. **Direct composition** — nothing fits, or the composition is genuinely novel: search with `vfxDocTypes: ["vfx_source"]` and build the recipe from the source entries.

When escalating past tier 1, always set `vfxDocTypes` — the preset corpus is much larger and dominates unfiltered results.

Shortcuts that skip the escalation:

- **User explicitly wants custom** ("don't use a preset/template", "compose it myself") → go straight to direct composition.
- **A recipe or template-based VFXRecipe already exists in the level** and the request is to modify it → source-level edit flow below; search only what you need (e.g. one replacement source via `vfxDocTypes: ["vfx_source"]`).

## Flow: template-based recipe

1. Search `overdaresearch` `source: "vfx"`, `topK: 3`, query by element/mood/pattern in English (e.g. "acid liquid smoke burst"). Results carry full doc text — no second fetch.
2. Copy the template's **Original Payload JSON** as the upsert `properties`. Pasting verbatim is safe: the top-level `LoopDuration` (read-only derived value) is accepted and ignored, and `Alpha` arrays pass through.
3. Adapt as requested:
   - **Theme/element change**: swap **Color / Alpha keypoints only** (e.g. all layers toward `#FF3000` for lava, `#3080FF` for frost). Keep the sources.
   - **Motion/shape change**: swap a source item's `NiagaraSystem` for another source **from the same layer** (search `vfx_source` if the catalog entry is needed), or add/remove source items — keep at least one BaseLayer item.
   - **Intensity**: scale `SpawnCount` / `SpawnRate` together across layers.
4. `studiorpc_instance_upsert` with `class: "VFXRecipe"`, parented under the target Workspace object.

## Flow: direct composition

1. Plan layers from `vfx_source` results: **BaseLayer** carries the effect's body (at least one item; `neutral`-element sources are the universal fallback), DetailLayer/ExtraLayer add accents and residue.
2. Use each result's `resourceName` directly as `NiagaraSystem` (short names preferred; full serving-asset paths also validate).
3. Set per-source parameters the chosen source supports (its catalog entry lists them; unsupported ones are silently ignored).
4. Create the `VFXRecipe` via `studiorpc_instance_upsert` — either in one call with the layers filled in, or create a minimal recipe first and add layers in a follow-up update; prefer one call when the composition is already decided.

## Flow: edit an existing recipe

1. `studiorpc_instance_read` the placed VFXRecipe to get its current layer arrays.
2. Modify in place: swap a `NiagaraSystem` (same layer only), tweak parameters, add/remove source items. Layer arrays are replaced whole on update — always send the complete modified array, not a delta.
3. `studiorpc_instance_upsert` **update** form (by `guid`) with the changed layer properties.

## Rate vs Burst sources

Sources with `_R` in the name are **Rate emitters**: set `Duration` (seconds) and `SpawnRate` (particles/sec). All others are **Burst emitters**: set `SpawnCount` (particles per activation). Never set Burst parameters on a Rate source or vice versa.

## Gotchas

- `LiquidScatter_R_A` exists in **both** BaseLayer and ExtraLayer as distinct assets; the layer you place it in decides which asset plays.
- A source from another layer is rejected by schema validation — the error lists the layer's valid sources.
- `ObjectType` tags (`Vector3` / `Color3` / `Content`) are injected by the sidecar — author plain `{X,Y,Z}`, `{R,G,B,Time}`, `{Content}` values; tagged values from template payloads also pass.
- Playback: `AutoActivate` (default true), `InfiniteLoop` (default true), `LoopCount` (used when `InfiniteLoop=false`). One-shot effects: `InfiniteLoop: false, LoopCount: 1`.
- Total recipe length is derived (`LoopDuration` is read-only): to shorten an effect, adjust source `Duration`/`Delay` or swap the longest source — don't try to set `LoopDuration`.
