---
name: procedural-builder
description: Create, edit, and run reusable OVERDARE Studio procedural Luau recipes. Use for algorithmic, parametric, repeated, formula-driven, or bulk scene generation, property edits, deletion, and reparenting; use direct instance tools for only a few hand-picked changes.
---

# OVERDARE Studio Procedural Recipes

Use this skill to write, adapt, and run project-local procedural recipes through `studiorpc_procedural_run`.

## Recipe rules

- Luau procedural script is the source of truth.
- Generated objects are derived output.
- Create any non-Service class supported by `instance_upsert` with `Instance.new(className)`. Use only properties from that class's canonical upsert schema; values pass through unchanged and invalid values fail during apply.
- Do not add custom procedural metadata as scene properties.
- **Canonical recipe storage:** Before creating a recipe, search `.overdare/procedural/` for a reusable one. Store each recipe at `.overdare/procedural/<id>/main.lua`, use a meaningful stable id, and edit that same file for later requests or retries. Never put agent-authored procedural source in `/tmp` or another OS temporary directory.
- **Comment procedural intent:** Author generated Luau with useful comments that explain what each major group, helper, and non-obvious transform is for. Future edits should be able to identify “what this part represents” and “why these coordinates/orientations were chosen” without reverse-engineering the model.

## Supported Luau surface

Recipes can use these APIs:

- `Vector3.new`, axes, arithmetic, `.Magnitude`, `.Unit`, `:Cross`, `:Dot`, `:Lerp`
- `Color3.fromRGB`, `Color3.new`
- `CFrame.identity`, `CFrame.new`, `CFrame.fromMatrix`, `CFrame +/- Vector3`
- `Instance.new(className)` for every creatable class supported by `instance_upsert`
- instances with generic schema-backed properties, `Parent`, `Children`, navigation methods, `IsA`, and `Destroy`
- `GeometryPrimitives`: `model`, `sphere`, `block`, `cylinder`, `cylinderBetween`, `ellipsoid`, `panel`, `disc`, `taperedCylinder`, `capsule`, `regularPrism`, `boxBetween`, `triangle`, `quad`, `polyline`, `arc`, `ring`
- `MathUtils`: deterministic `deriveSeed`/`random` streams; interpolation/Bezier helpers; `pointsOnLine`, `pointsOnCircle`, `pointsOnArc`, `pointsOnEllipse`, `pointsOnGrid`, `pointsOnHelix`, `segmentsFromPoints`; `frameBetween`, `frameFromNormal`, `rotateAroundAxis`, `mirrorPoint`, `transformPoints`, `projectOnPlane`; and the `forEach*` wrappers

OVERDARE has no CSG (boolean geometry): there is no `ConstructiveSolidGeometry` dependency and no `subtract`/`union`/`intersect`. Build shapes additively from parts instead of carving them.

Geometry fidelity is approximate for complex primitives. Prefer apply-safe `Part` approximations over unsupported schema fields.

## Quick Library Spec

Use this as the authoring reference.

### Script contract

Write scripts so humans can safely revise them later:

- Add a short file/header comment describing the generated model and its main editable parameters.
- Add comments for non-obvious coordinates, rotations, scale factors, symmetry mirroring, or OVERDARE-specific workarounds.
- Prefer intent comments over line-by-line noise. Avoid comments that only restate the function name.

```lua
-- Builds a readable example model. Size/Attributes control high-level proportions;
-- individual part coordinates below are absolute OVERDARE world-space centimeters.
local GP = require(script.Dependencies.GeometryPrimitives)

local ScriptModule = {}

ScriptModule.OnGenerate = function(parameters, targetContainer)
	-- Root groups all visible geometry so apply can create a single movable model.
	local root = GP.model("ModelName", nil)

	-- Body group owns the primary readable silhouette pieces.
	local body = GP.model("Body", root)
	GP.sphere("BodyCore", Vector3.new(0, 100, 0), 50, Color3.fromRGB(255, 255, 255), "Plastic", body)

	root.Parent = targetContainer
end

return ScriptModule
```

`parameters` shape:

```lua
{
	Size = { X = number, Y = number, Z = number },
	Attributes = { [string] = any },
}
```

When omitted by the tool call, `Size` defaults to `{ X = 10, Y = 10, Z = 10 }` and `Attributes` defaults to `{}`.

### Instance-like behavior

```lua
local light = Instance.new("PointLight")
light.Name = "KeyLight"
light.Brightness = 125
light.Range = 900
light.Parent = parent -- fresh instances must join the final tree to be serialized

instance.Parent = parent
instance.Children
instance:GetDescendants()
instance:GetChildren()
instance:GetChildrenNum()
instance:IsA("Model")
instance:IsA("BasePart")
instance:Destroy()

-- tree navigation (useful for transform/edit scripts over the injected `workspace`)
instance:FindFirstChild(name, recursive?)
instance:FindFirstChildOfClass(className, recursive?)
instance:FindFirstChildWhichIsA(className, recursive?)
instance:WaitForChild(name)               -- resolves immediately (no yield)
instance:FindFirstAncestor(name)
instance:FindFirstAncestorOfClass(className)
instance:FindFirstAncestorWhichIsA(className)
instance:IsDescendantOf(ancestor)
instance:GetFullName()                    -- e.g. "Workspace.Model.Part"

part.CFrame -= Vector3.yAxis * amount
model.WorldPivot -= Vector3.yAxis * amount
```

Assigning `Parent` may target an existing or same-run generated instance. Existing instances retain their GUID when reparented. Do not destroy or reparent the injected `workspace` target root or any Service instance.

### GeometryPrimitives (`GP`)

```lua
local GP = require(script.Dependencies.GeometryPrimitives)

GP.model(name, parent?)

GP.sphere(name, center, radius, color, material, parent?)
GP.block(name, centerOrCFrame, size, color, material, parent?)

-- center/height form
GP.cylinder(name, center, height, radius, color, material, parent?)

-- two-point form
GP.cylinder(name, startPoint, endPoint, radius, color, material, parent?)

-- canonical two-point and direct-part forms use an options table
GP.cylinderBetween(name, startPoint, endPoint, radius, options?)
GP.ellipsoid(name, centerOrCFrame, size, options?)
GP.panel(name, centerOrCFrame, width, height, thickness, options?)
GP.disc(name, centerOrCFrame, radius, thickness, options?)

-- Composite helpers return a Model. Polyline thickness is the cylinder
-- diameter or square block cross-section size.
GP.polyline(name, points, thickness, options?)
GP.arc(name, center, radius, startAngle, endAngle, options)
GP.ring(name, center, radius, options)

-- Options use lower-camel-case keys. Property-style keys such as Color,
-- Material, and Parent are invalid and are rejected before instance creation.
local options = {
	color = Color3.fromRGB(255, 255, 255),
	material = "Plastic",
	parent = model,
	transparency = 0,
	canCollide = true,
}

local polylineOptions = {
	segmentShape = "Cylinder", -- default; may also be "Block"
	closed = false,
	color = Color3.fromRGB(255, 255, 255),
	material = "Metal",
	parent = model,
}

-- Arc/ring require thickness, segments, and a finite non-zero axis.
local curveOptions = {
	thickness = 10,
	segments = 24,
	axis = Vector3.yAxis,
	segmentShape = "Cylinder",
	parent = model,
}

GP.taperedCylinder(name, startPoint, endPoint, radiusTop, radiusBottom, color, material, parent?)
GP.capsule(name, endpoint1, radius1, endpoint2, radius2, color, material, parent?)
GP.regularPrism(name, startPoint, endPoint, radius, sides, color, material, parent?)
GP.boxBetween(name, startPoint, endPoint, thickness, height, color, material, parent?)
GP.triangle(name, point1, point2, point3, thickness, normal?, color, material, parent?)
GP.quad(name, point1, point2, point3, point4, thickness, normal?, color, material, parent?)
```

Geometry notes:

- `sphere` -> `Part` / `Shape = "Ball"`
- `ellipsoid` -> non-uniform `Part` / `Shape = "Ball"` (verify final appearance in Studio)
- `panel` -> thin `Block`; `disc` -> short Y-axis `Cylinder`
- `polyline`, `arc`, and `ring` -> faceted `Model` compositions, not continuous curved meshes
- composite segment names are deterministic (`<name>_1`, `<name>_2`, ...);
  a helper emits at most 4,999 parts plus its model node
- `polyline` skips coincident consecutive points; `arc` and `ring` use
  `options.segments` as the exact emitted part count
- `block`, `boxBetween`, `triangle`, `quad` -> `Part` / `Shape = "Block"` approximation
- `cylinder`, `taperedCylinder`, `capsule`, `regularPrism` -> `Part` / `Shape = "Cylinder"` approximation where possible
- Two-point `cylinder`, `taperedCylinder`, `capsule`, and `regularPrism` serialize the cylinder height on local Y along `startPoint -> endPoint`; verify sign-sensitive mirrored details such as whiskers, spokes, or rails.
- `capsule` may become a `Ball` if one endpoint radius fully dominates the segment
- no `WedgePart` / `CornerWedgePart` in the supported scene output
- no CSG / boolean geometry: holes, cutouts, and true cones/pyramids cannot be produced. Approximate additively with the primitives above, or omit the feature.

### MathUtils (`MU`)

```lua
local MU = require(script.Dependencies.MathUtils)

-- Deterministic map authoring. In OnGenerate, this seed can come from
-- parameters.Attributes.Seed with an explicit integer fallback.
local mapSeed = 12345
local terrainRng = MU.random(MU.deriveSeed(mapSeed, "terrain"))
local propsRng = MU.random(MU.deriveSeed(mapSeed, "props"))

terrainRng:nextNumber(-100, 100) -- half-open range
terrainRng:nextInteger(1, 10) -- inclusive range
propsRng:choice({ "Tree", "Rock", "Shrub" })
local shuffled = propsRng:shuffle({ "North", "East", "South", "West" })

-- Interpolation
MU.lerp(a, b, t)                         -- number, t clamped to 0..1
MU.lerpVector3(v1, v2, t)                -- Vector3
MU.lerpColor(c1, c2, t)                  -- Color3, interpolates 0-255 channels

-- Curves (return/take Vector3)
MU.pointOnCubicBezier(t, p0, p1, p2, p3)      -- one point on a cubic Bezier
MU.pointOnQuadraticBezier(t, p0, p1, p2)       -- one point on a quadratic Bezier
MU.pointsOnCubicBezier(p0, p1, p2, p3, segments) -- { Vector3 }, segments + 1 points

-- Coordinates
MU.polarToCartesian(center, radius, angle, plane) -- plane: "XZ" (default), "XY", "YZ"

-- Pure point/segment generation (count is returned point count; angles are radians)
MU.pointsOnLine(startPoint, endPoint, count) -- minimum 2, includes both endpoints
MU.pointsOnCircle(center, radius, count, axis) -- minimum 3, no duplicate endpoint
MU.pointsOnArc(center, radius, startAngle, endAngle, count, axis) -- minimum 2
MU.pointsOnEllipse(center, radiusX, radiusY, count, axis) -- minimum 3
MU.pointsOnGrid(origin, columns, rows, columnStep, rowStep) -- columns change fastest
MU.pointsOnHelix(center, radius, height, turns, count, axis) -- centered on height
MU.segmentsFromPoints(points, closed) -- { { startPoint = ..., endPoint = ... }, ... }

-- Orientation and transforms
MU.frameBetween(startPoint, endPoint, localAxis, up) -- frame is at segment midpoint
MU.frameFromNormal(position, normal, up) -- local Y follows normal
MU.rotateAroundAxis(point, pivot, axis, angle) -- radians
MU.mirrorPoint(point, planePoint, planeNormal)
MU.transformPoints(points, cframe)
MU.projectOnPlane(vector, normal)

-- Layout (invoke callback per placement)
MU.forEachPointOnLine(startPos, endPos, count, function(pos, i) end)
MU.forEachPointOnCircle(center, radius, count, axis, function(pos, i) end)
MU.forEachSegmentOnCircle(center, radius, count, axis, function(pos, i, nextPos) end)
```

Use the names above in new recipes. `MU` outputs interoperate with the
`Vector3`/`Color3` globals and with `GP` helpers. Interpolation helpers clamp
`t` to `0..1`; number and curve helpers reject `NaN`/infinite inputs.
Grid dimensions are positive integers and the product is capped at 20,000
points. Helix output includes both height endpoints, accepts signed non-zero
height/turns, requires at least two points, and is capped at 20,000 points.

Seeded random notes:

- `MU.random(seed)` requires an explicit safe-integer seed and creates an
  independent deterministic stream; do not use global `math.randomseed`
- `MU.deriveSeed(seed, scope)` requires a non-empty string scope and keeps map
  subsystems reproducible when another subsystem adds or removes random calls
- `nextNumber(minimum, maximum)` uses a half-open range;
  `nextInteger(minimum, maximum)` includes both integer bounds
- `choice` requires a non-empty dense array; `shuffle` returns a new array and
  does not modify its input; both accept at most 20,000 items
- the RNG is intended for reproducible procedural authoring, not cryptography
- when placing objects at random positions, guard against unintended overlap:
  uniform random sampling readily produces clipping, so enforce a minimum
  spacing (reject or nudge samples that collide, e.g. a Poisson-style check)
  and account for each part's full size, not just its center. Only allow
  overlapping placements when the user explicitly wants them.

There is no `SmartObject` dependency: read tunable inputs directly from
`parameters.Size` and `parameters.Attributes`.

### Materials

Material values pass through the procedural runtime unchanged. Use an exact value accepted by the canonical
`instance_upsert` material schema in `instance.params.ts`. Invalid values fail during apply; the runtime never aliases
or silently falls back to another material.

### Mobility (Static vs Movable)

Mobility is inherited from the top-level Workspace object, so set it once on the
recipe root — never per part (see the Mobility building rule for the inheritance
model). For a fixed map/terrain that never moves, set `Mobility = "Static"` on
the root and every generated part inherits it. Keep anything that must move,
animate, or be physics-/script-driven on a `"Movable"` root (the default).

```lua
-- Fixed map/terrain: mark the root Static; every generated part inherits it.
local root = GP.model("Terrain", nil)
root.Mobility = "Static" -- whole map never moves; descendants inherit Static
-- Build the static level geometry under `root` here.
root.Parent = targetContainer
```

## Workflow

### 1. Understand the script target

Before writing code, search `.overdare/procedural/{recipeId}/main.lua` for a recipe that already owns the requested model or edit.

- Stable recipe id and model name
- Expected `parameters.Size` and `parameters.Attributes`
- Which helper APIs the script needs from `GeometryPrimitives` or `MathUtils`
- Whether to patch existing instances or replace the owned root

If adapting a script that uses CSG (`subtract`/`union`/`intersect`), rework it additively first — OVERDARE cannot carve geometry.

Use only the APIs documented in this skill. If a requested primitive is unavailable, compose it from supported parts.

### 2. Author Luau in the supported pattern

Create or edit `.overdare/procedural/<id>/main.lua`. Keep one semantic recipe per directory and reuse it instead of creating request-specific files.

Use this script shape:

```lua
--!strict
-- Generates <ModelName>. Edit the constants near the top of OnGenerate to tune proportions.
local GP = require(script.Dependencies.GeometryPrimitives)

local ModelScript = {}

ModelScript.OnGenerate = function(parameters, targetContainer)
	-- Root model: one parent for all generated pieces.
	local root = GP.model("ModelName", nil)
	root.WorldPivot = CFrame.identity

	-- Example visible part: placed in absolute OVERDARE centimeters.
	GP.sphere("Example", Vector3.new(0, 2, 0), 1, Color3.fromRGB(255, 255, 255), "Plastic", root)

	root.Parent = targetContainer
end

return ModelScript
```

Guidelines:

- Parent generated objects into a root `Model`, then parent the root to `targetContainer`.
- Parent every fresh instance into the final tree. Unparented fresh instances are not serialized or applied.
- Use `parameters.Size.X/Y/Z` and `parameters.Attributes` for user-tunable generation.
- Use exact materials accepted by the apply schema. Invalid materials are rejected rather than rewritten.
- For fixed maps, terrain, and structures that never move, set `Mobility = "Static"` on the top-level root (see [Mobility](#mobility-static-vs-movable)); keep objects that must move `"Movable"`.
- Avoid unintended overlap: unless the user explicitly wants parts to intersect (e.g. deliberately fused or embedded geometry), lay pieces out so they do not overlap or clip into each other. Account for each part's full size — not just its center — when spacing, tiling, or stacking, and leave clearances between distinct objects.
- Keep shape generation deterministic.
- Comment every major generated group and every transform that is visually important or easy to break during edits.

### 3. Run the recipe

Call `studiorpc_procedural_run` with:

- `id`: the recipe directory name
- `targetGuid`: optional injected subtree and parent for new top-level objects; defaults to Workspace
- `parameters`: optional `Size` and `Attributes` values used by the recipe

The tool reads `.overdare/procedural/<id>/main.lua`, injects the current scene,
shows the derived add/update/move/delete counts for approval, and applies the
final diff in one document transaction. Property values are validated by the
same canonical class schemas used by `instance_upsert` before any scene change
is committed. It does not accept inline source or arbitrary paths. If execution
fails or the user requests a change, edit the same `main.lua` and rerun it.

The recipe source is host-side only. Do not create a `Script` instance in the
Studio scene; the result should be generated geometry or edits to existing
instances.

### 4. Make reruns converge

The selected scene subtree (`targetGuid`, or the whole Workspace) is available
as the `workspace` global. `targetContainer` is a separate temporary container:
fresh top-level children parented to it are attached directly under the selected
target when applied. A recipe can therefore:

- **Generate** — build fresh geometry under `targetContainer` (the `OnGenerate`
  second argument), exactly as before. Fresh nodes become `add`s.
- **Transform** — read and mutate existing objects via `workspace`
  (`workspace:GetDescendants()`, `part.CFrame -= …`, `inst:Destroy()`).

Rerunning a generator does not automatically remove its previous output. Make
the recipe converge explicitly: locate the instances it owns, then either patch
them or call `Destroy()` and build replacements. Scope lookups to the selected
target and use stable, distinctive root names to avoid touching unrelated
instances.

```lua
-- Convergent transform example: normalize all parts and remove obsolete markers.
local Move = {}

Move.OnGenerate = function(parameters, targetContainer)
	for _, inst in workspace:GetDescendants() do
		if inst:IsA("BasePart") then
			if inst.Name == "Marker" then
				inst:Destroy()
			else
				inst.Material = "Concrete"
			end
		end
	end
end

return Move
```

For replace-style generation, remove only the stable root owned by the recipe before rebuilding it:

```lua
local previous = workspace:FindFirstChild("OwnedRoot")
if previous then
	previous:Destroy()
end

local root = GP.model("OwnedRoot", nil)
-- Build the replacement subtree here.
root.Parent = targetContainer
```

Property edits use the same class schemas as `instance_upsert`. Reparenting uses
normal Luau assignment and keeps existing GUIDs:

```lua
local generated = Instance.new("Folder")
generated.Name = "GeneratedParent"
generated.Parent = workspace

local existing = workspace:FindFirstChild("ExistingChild", true)
existing.Parent = generated
```

### 5. Verify the result

After a successful run, check the returned add/update/move/delete counts,
generated GUIDs, warnings, and info. Inspect the affected scene subtree when
visual placement or hierarchy matters. If validation or execution fails, fix
the canonical `main.lua`; do not add procedural-side aliases, fallback values,
or property whitelists to bypass the shared apply schema.
