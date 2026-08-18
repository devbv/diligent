---
name: asset-pack-import
description: Import and place themed asset packs (pack_* collections) from the Asset Store. Use when a request needs many related assets at once — building a themed scene ("build a subway station", "add a forest", "fill this area with props"), or when an overdaresearch asset picker returns a pack member list instead of a single assetId.
---

# Asset Pack Import

Workflow for turning a themed request into imported, placed Asset Store content.

## 1. Search normally; the picker surfaces packs

Search with `overdaresearch(source=assets)` as usual. When the results belong to a
themed pack (shared `pack_*` keyword), the picker automatically offers an
"Import full pack" option alongside the single assets. If the user picks it, the tool
returns the full member list JSON (`{ pack, memberCount, members }`) instead of a
single assetId. **That member list is your palette — do not re-search per item.**

## 2. Select a subset; a pack is a palette, not a prefab

A pack is a themed collection (walls, floors, props, vehicles…), not a pre-assembled
scene. Composition is your job:

- Pick only the members the request actually needs. "Build a subway platform" might
  need 15 of 145 metro assets; never blind-import the whole pack just because it exists.
- Balance categories: structure first (floors, walls, pillars), then fixtures
  (machines, signs), then scatter props (cans, posters).
- If the request is ambiguous about scale ("add some metro stuff" vs "build a
  station"), ask before importing dozens of assets.

## 3. Branch on subset size

- **Fewer than 5 assets** — import each with `studiorpc_asset_drawer_import`, then
  position with `studiorpc_instance_move` / `studiorpc_instance_upsert`. No recipe
  needed.
- **5 or more assets** — import all with `studiorpc_asset_drawer_import_bulk`
  (one approval, returns an assetid→guids map), then place them with a procedural
  recipe (see the procedural-builder skill).

## 4. GUID discipline (mandatory)

Imported scene names differ from store titles (store "Can 01" spawns as
`Metro_Can01`), so **never locate imported models by name**. The bulk import output
maps every assetid to its scene GUIDs — pass those GUIDs into the placement recipe
via `parameters.Attributes`:

```json
{
  "Attributes": {
    "PlacementGuids": ["653B201E4C45D9CAAC1040A0D816D859", "..."]
  }
}
```

Check the bulk output's `failed` list before placement; only place the GUIDs that
actually imported.

## 5. Placement recipe pattern

Injected scene instances expose `.Guid`. Match against the GUID list and assign
CFrames; follow the procedural-builder skill's convergence rules for reruns.

```lua
--!strict
-- Places imported pack members on a grid. Attributes.PlacementGuids selects the
-- targets; edit the spacing constants to tune the layout.
local MathUtils = require(script.Dependencies.MathUtils)

local PlacePack = {}

PlacePack.OnGenerate = function(parameters, targetContainer)
	local guids = parameters.Attributes.PlacementGuids or {}
	local wanted = {}
	for _, guid in guids do
		wanted[guid] = true
	end

	-- Collect the imported roots by GUID (names are unreliable).
	local targets = {}
	for _, inst in workspace:GetDescendants() do
		if inst.Guid and wanted[inst.Guid] then
			table.insert(targets, inst)
		end
	end

	-- Simple grid layout in world centimeters; replace with pointsOnCircle /
	-- hand-authored CFrames when the scene calls for it.
	local spacing = 400
	local perRow = 5
	for i, inst in targets do
		local row = math.floor((i - 1) / perRow)
		local col = (i - 1) % perRow
		inst.CFrame = CFrame.new(col * spacing, 0, row * spacing)
	end
end

return PlacePack
```

Real scenes deserve real composition — walls along walls, rails in lines
(`pointsOnLine`), props scattered with deterministic `MathUtils.random` — but the
GUID lookup skeleton above stays the same.

## 6. Verify

After placement, read back the affected subtree (`studiorpc_instance_read` /
`studiorpc_level_browse`) and take a screenshot when visual arrangement matters.
Report any `failed` imports to the user instead of silently dropping them.
