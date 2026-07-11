---
name: procedural-luau-json
description: Write or adapt OVERDARE procedural Luau scripts and generate instance-upsert-ready nested JSON. Use this skill when the user asks to create Luau procedural code, port or adapt existing procedural examples, run a procedural script, generate dummy JSON, or inspect/apply OVDR procedural output.
---

# Procedural Luau JSON Generator

Use this skill to write, adapt, and run OVERDARE procedural Luau scripts that produce nested `children: []` JSON compatible with `studiorpc_instance_upsert`.

## When to use procedural_run (vs manual instance edits)

Default to `studiorpc_procedural_run` whenever placement or editing is **algorithmic, parametric, or rule-based** — do **not** hand-place/move objects one-by-one with `instance_upsert`/`instance_move` in those cases. Procedural runs are deterministic and re-runnable: the same script reproduces the same scene, and you can tune parameters and re-run.

**Use `procedural_run` when:**

- Placement follows a pattern or formula: grids, rings, arcs, stairs, spirals, symmetry/mirroring, curves (Bezier), radial layouts.
- You need to create many objects (roughly a dozen or more), or the count/spacing is parameter-driven.
- You want a **bulk transform** over existing objects by rule: "shift every part +X", "recolor by height", "scale all by Attribute", "delete all named Marker". The script reads the injected `workspace` and mutates in place; ops are diffed automatically.
- The result should be reproducible, tweakable, or regenerated later (save it as a model with `procedural_model_save`/`_run`).

**Use `instance_upsert` / `instance_move` / `instance_delete` when:**

- You are placing, nudging, or editing a **few specific, hand-picked** objects (no rule or repetition).
- You need to reparent a specific instance (`instance_move`) — procedural cannot reparent.
- The change is a one-off property tweak on a known GUID.

**Rule of thumb:** if you would write a loop or a formula to decide where things go, use `procedural_run`. If you would point at 1–3 specific objects, use the instance tools.

## Product Direction

- Luau procedural script is the source of truth.
- Generated objects are derived output.
- Output shape is nested scene JSON, not a flat `items[]` list.
- Use `ovdr-shim` naming consistently; never rename the shim.
- Keep generated node `properties` strict to the `instance_upsert` schema. Do not add custom procedural metadata inside `properties`.
- **Temporary output only:** When creating ad-hoc procedural scripts or generated JSON for a user request, write both the `.lua` script and `.json` output under `/tmp`. Do not add one-off generated models to repo example/source directories unless the user explicitly asks for a persistent repo asset.
- **Comment procedural intent:** Author generated Luau with useful comments that explain what each major group, helper, and non-obvious transform is for. Future edits should be able to identify “what this part represents” and “why these coordinates/orientations were chosen” without reverse-engineering the model.

## OVERDARE Scene Authoring Rules

Procedural JSON is static level geometry for OVERDARE Studio. When writing or adapting scripts, follow OVERDARE placement semantics:

- **Units:** OVERDARE units are centimeters. If an adapted script looks too small, its source likely used a smaller unit scale (roughly `28` OVERDARE units per source unit) — scale dimensions by about `28x`, or choose explicit centimeter-scale defaults.
- **CFrame placement:** Treat every serialized `CFrame` as world space. Even when an object is nested under a parent model, compute absolute world positions; do not use parent-relative offsets.
- **Parent-child movement:** In OVERDARE, children follow parent transforms. For generated static JSON, keep child `CFrame`s absolute at generation time so the scene is correct immediately after apply.
- **Cylinder orientation:** `Part` with `Shape = "Cylinder"` is aligned along the **Y axis**. Size is `(diameter, height, diameter)`. Use small `Y` for flat discs, and rotate only when a sideways cylinder is intentionally needed.
  - Coin/disc: `Size = (100, 5, 100)`, `Orientation = (0, 0, 0)`.
  - Log/pipe laid along the X axis: `Size = (50, 200, 50)`, `Orientation = (0, 0, 90)`.
  - Wheel on its side: `Size = (80, 20, 80)`, `Orientation = (0, 0, 90)`.
  - For directed two-point `GP.cylinder(startPoint, endPoint, ...)`, the local **Y axis** is serialized along `startPoint -> endPoint`. Current shim expectations: +X direction uses negative Z rotation, -X direction uses positive Z rotation, and +Z direction uses positive X rotation.
- **Plain, compatible assets:** Asset ids, if ever used, must be `ovdrassetid://[number]`. Do not use other asset path formats.
- **Doors, tunnels, and openings:** OVERDARE procedural JSON does not currently provide a GeometryService-style boolean cutout. Build openings by leaving space empty: skip wall/dome blocks where the door should be, and assemble tunnels from separate side walls, floor, and arch/roof pieces. Do not place arbitrary solid objects inside the passage just to imply a hole; if players should pass through it, the center volume must actually remain empty.

## Key Files

| Purpose | Path |
|---|---|
| Runtime generator | `apps/overdare-ai-agent/sidecar/src/procedural/runtime.ts` |
| Public exports/types | `apps/overdare-ai-agent/sidecar/src/procedural/` |
| Luau runner | `apps/overdare-ai-agent/sidecar/src/procedural/luau/runner.lua` |
| OVDR shim | `apps/overdare-ai-agent/sidecar/src/procedural/luau/ovdr-shim.lua` |
| OVDR helper libs | `apps/overdare-ai-agent/sidecar/src/procedural/luau/dependencies/` |
| Runtime tests | `apps/overdare-ai-agent/sidecar/test/procedural/runtime.test.ts` |
| Example scripts | `apps/overdare-ai-agent/sidecar/src/procedural/examples/` |
| Geometry/math API and roadmap | `docs/guide/procedural-geometry-math.md` |
| Handoff notes | `docs/plan/feature/P068-procedural-script-dummy-json-runtime-handoff.md` |

## Supported MVP Output

`generateProceduralDummyJson(...)` returns:

```ts
type ProceduralDummyJson = {
  version: 1;
  kind: "overdare.procedural-dummy-json";
  generationId: string;
  scriptName: string;
  parameters: ProceduralParameters;
  children: ProceduralGeneratedNode[];
};
```

Each generated node should be directly creatable through `studiorpc_instance_upsert`:

```ts
type ProceduralGeneratedNode = {
  class: "Model" | "Part";
  name: string;
  properties: ModelProperties | PartProperties;
  children?: ProceduralGeneratedNode[];
};
```

## Current Luau Compatibility Notes

The current runtime supports the example scripts with these important APIs:

- `Vector3.new`, axes, arithmetic, `.Magnitude`, `.Unit`, `:Cross`, `:Dot`, `:Lerp`
- `Color3.fromRGB`, `Color3.new`
- `CFrame.identity`, `CFrame.new`, `CFrame.fromMatrix`, `CFrame +/- Vector3`
- fake instances with `Parent`, `Children`, `GetDescendants`, `IsA`, `Destroy`
- `GeometryPrimitives`: `model`, `sphere`, `block`, `cylinder`, `cylinderBetween`, `ellipsoid`, `panel`, `disc`, `taperedCylinder`, `capsule`, `regularPrism`, `boxBetween`, `triangle`, `quad`
- `MathUtils`: interpolation/Bezier helpers; `pointsOnLine`, `pointsOnCircle`, `pointsOnArc`, `pointsOnEllipse`, `segmentsFromPoints`; `frameBetween`, `frameFromNormal`, `rotateAroundAxis`, `mirrorPoint`, `transformPoints`, `projectOnPlane`; and the `forEach*` wrappers

There is no `SmartObject` dependency. Read tunable inputs directly from `parameters.Size` / `parameters.Attributes`.

OVERDARE has no CSG (boolean geometry): there is no `ConstructiveSolidGeometry` dependency and no `subtract`/`union`/`intersect`. Build shapes additively from parts instead of carving them.

Geometry fidelity is approximate for complex primitives. Prefer apply-safe `Part` approximations over unsupported schema fields.

The geometry/math guide also describes planned APIs. Do not call a roadmap API
unless it appears in the current compatibility list above or exists in the
dependency source. Planned names are design guidance, not runtime capability.

## Quick Library Spec

Use this as the fast authoring reference before opening source files.

### Script contract

Write scripts so humans can safely revise them later:

- Add a short file/header comment describing the generated model and its main editable parameters.
- Add one comment before each major model group (`Body`, `Head`, `Ears`, `Whiskers`, architectural floors, wall rings, etc.) explaining its role.
- Add comments for non-obvious coordinates, rotations, scale factors, symmetry mirroring, or OVERDARE-specific workarounds.
- Prefer intent comments over line-by-line noise. Avoid comments that only restate the function name.
- Keep comments in the `.lua` script; do not place custom metadata inside generated JSON `properties`.

```lua
-- Builds a readable example model. Size/Attributes control high-level proportions;
-- individual part coordinates below are absolute OVERDARE world-space centimeters.
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

### Globals

```lua
Vector3.new(x, y, z)
Vector3.zero
Vector3.xAxis
Vector3.yAxis
Vector3.zAxis
vector.Magnitude
vector.Unit
vector:Cross(other)
vector:Dot(other)
vector:Lerp(other, alpha)
-- operators: +, -, unary -, *, /

Color3.fromRGB(r, g, b)
Color3.new(r, g, b) -- 0..1 inputs, serialized as 0..255 RGB

CFrame.identity
CFrame.new(x, y, z)
CFrame.fromMatrix(position, rightVector, upVector, backVector?)
-- operators: cframe + Vector3, cframe - Vector3
```

`CFrame.fromMatrix` serializes an approximate Euler orientation for static geometry. When using it for elongated parts, validate both mirrored sides because equivalent rotations can look correct numerically but flip visual direction in Studio.

### Instance-like behavior

```lua
instance.Parent = parent
instance.Children
instance:GetDescendants()
instance:IsA("Model")
instance:IsA("BasePart")
instance:Destroy()

part.CFrame -= Vector3.yAxis * amount
model.WorldPivot -= Vector3.yAxis * amount
```

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

-- Options use lower-camel-case keys. Property-style keys such as Color,
-- Material, and Parent are invalid and are rejected before instance creation.
local options = {
	color = Color3.fromRGB(255, 255, 255),
	material = "Plastic",
	parent = model,
	transparency = 0,
	canCollide = true,
}

GP.taperedCylinder(name, startPoint, endPoint, radiusTop, radiusBottom, color, material, parent?)
GP.capsule(name, endpoint1, radius1, endpoint2, radius2, color, material, parent?)
GP.regularPrism(name, startPoint, endPoint, radius, sides, color, material, parent?)
GP.boxBetween(name, startPoint, endPoint, thickness, height, color, material, parent?)
GP.triangle(name, point1, point2, point3, thickness, normal?, color, material, parent?)
GP.quad(name, point1, point2, point3, point4, thickness, normal?, color, material, parent?)
```

MVP geometry notes:

- `sphere` -> `Part` / `Shape = "Ball"`
- `ellipsoid` -> non-uniform `Part` / `Shape = "Ball"` (verify final appearance in Studio)
- `panel` -> thin `Block`; `disc` -> short Y-axis `Cylinder`
- `block`, `boxBetween`, `triangle`, `quad` -> `Part` / `Shape = "Block"` approximation
- `cylinder`, `taperedCylinder`, `capsule`, `regularPrism` -> `Part` / `Shape = "Cylinder"` approximation where possible
- Two-point `cylinder`, `taperedCylinder`, `capsule`, and `regularPrism` serialize the cylinder height on local Y along `startPoint -> endPoint`; verify sign-sensitive mirrored details such as whiskers, spokes, or rails.
- `capsule` may become a `Ball` if one endpoint radius fully dominates the segment
- no `WedgePart` / `CornerWedgePart` in the current apply-safe JSON contract
- no CSG / boolean geometry: holes, cutouts, and true cones/pyramids cannot be produced. Approximate additively with the primitives above, or omit the feature.

### MathUtils (`MU`)

```lua
local MU = require(script.Dependencies.MathUtils)

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

The older implementation-oriented names remain as compatibility aliases, but
new scripts should use the names above. Prefer names that describe the geometry
or callback behavior instead of the number of input points or an array-like
implementation detail.

All values are built through `ovdr-shim`, so `MU` outputs interoperate with the
`Vector3`/`Color3` globals and with `GP` helpers. Interpolation helpers clamp
`t` to `0..1`; the number/curve helpers reject `NaN`/infinite inputs.

There is no `SmartObject` dependency: read tunable inputs directly from
`parameters.Size` and `parameters.Attributes`.

### Materials

Output must normalize to `instance_upsert`-safe materials. Known unsupported materials fall back through aliases or to `Plastic`.

Common safe materials:

```text
Basic, Plastic, Brick, Rock, Metal, Unlit, Bark, SmallBrick, LeafyGround,
MossyGround, Ground, Glass, Paving, MossyRock, Wood, Neon
```

Useful aliases:

```text
SmoothPlastic -> Plastic
Sandstone -> Rock
Sand -> Ground
Concrete/Granite/Marble/Slate -> Rock
```

## Workflow

### 1. Understand the script target

Before writing code, identify:

- Desired model name and `generationId`
- Expected `parameters.Size` and `parameters.Attributes`
- Which helper APIs the script needs from `GeometryPrimitives` or `MathUtils`
- Whether the output only needs MVP dummy geometry or closer visual fidelity

If adapting a script that uses CSG (`subtract`/`union`/`intersect`), rework it additively first — OVERDARE cannot carve geometry.

When adapting an existing script, first grep the source for helper calls:

```bash
grep -n "GP\.\|MU\." path/to/script.lua
```

Implement only missing prerequisites needed by the target script.

### 2. Author Luau in the supported pattern

For ad-hoc model creation, write the script to `/tmp/<model-name>.lua` first. Keep repo paths for persistent examples, tests, or runtime implementation changes only.

Use this script shape:

```lua
--!strict
-- generationId: replace-with-stable-id
-- Generates <ModelName>. Edit the constants near the top of OnGenerate to tune proportions.
local GP = require(script.Dependencies.GeometryPrimitives)

local ModelScript = {}

ModelScript.OnGenerate = function(parameters, targetContainer)
	-- Root model: one parent for all generated pieces.
	local root = GP.model("ModelName", nil)
	root.WorldPivot = CFrame.identity

	-- Example visible part: placed in absolute OVERDARE centimeters.
	GP.sphere("Example", Vector3.new(0, 2, 0), 1, Color3.fromRGB(255, 255, 255), "SmoothPlastic", root)

	root.Parent = targetContainer
end

return ModelScript
```

Guidelines:

- Parent generated objects into a root `Model`, then parent the root to `targetContainer`.
- Use `parameters.Size.X/Y/Z` and `parameters.Attributes` for user-tunable generation.
- Use materials that normalize to the apply schema. Unknown materials become safe aliases, usually `Plastic`.
- Keep shape generation deterministic.
- Comment every major generated group and every transform that is visually important or easy to break during edits.

### 3. Generate JSON from a Luau file

In Studio, prefer the agent tools (`studiorpc_procedural_run` / `studiorpc_procedural_model_run`) — they execute the script and apply the result directly. For local inspection of the raw generated tree (no Studio), use this temporary Bun runner from repo root, keeping the input script and generated output in `/tmp`:

```bash
cat > /tmp/ovdr-generate-procedural-json.ts <<'TS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , scriptPath, outputPath = "/tmp/ovdr-procedural.generated.json"] = process.argv;
if (!scriptPath) {
  throw new Error("Usage: bun /tmp/ovdr-generate-procedural-json.ts <script.lua> [output.json]");
}

const moduleUrl = pathToFileURL(join(process.cwd(), "apps/overdare-ai-agent/sidecar/src/procedural/index.ts")).href;
const { generateProceduralDummyJson } = await import(moduleUrl);
const scriptSource = readFileSync(scriptPath, "utf8");
const result = await generateProceduralDummyJson({
  scriptSource,
  parameters: {
    Size: { X: 10, Y: 10, Z: 10 },
    Attributes: {},
  },
});

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(outputPath);
TS

bun /tmp/ovdr-generate-procedural-json.ts /tmp/model.lua /tmp/model.generated.json
```

Inspect the output:

```bash
jq '.children | length' /tmp/model.generated.json
jq '.children[0].name' /tmp/model.generated.json
```

### 4. Add regression coverage when runtime behavior changes

If you add shim/dependency support, update:

```text
apps/overdare-ai-agent/sidecar/test/procedural/runtime.test.ts
```

Targeted validation:

```bash
bun test ./apps/overdare-ai-agent/sidecar/test/procedural/runtime.test.ts
./apps/overdare-ai-agent/sidecar/node_modules/.bin/tsc --pretty false --noEmit -p apps/overdare-ai-agent/sidecar/tsconfig.json
bunx biome check apps/overdare-ai-agent/sidecar/test/procedural/runtime.test.ts
```

## Agent Tool Surface

**Where the script lives (important):** A procedural script is *host-side Luau
source* — either passed inline (`script`) or written as an external `.lua` file
on disk (`scriptPath`, e.g. under `/tmp` for ad-hoc runs, or
`.overdare/procedural/scripts/` once saved). It is **not** authored as a `Script`
instance inside the Studio scene, and the sidecar executes it out-of-scene. What
lands in the scene is the **generated geometry** (`Model`/`Part` instances), never
a `Script` object. So: create/edit the `.lua` file (or inline source) and run it —
do not create a Script in Studio and paste code into it.

Scripts are executed and applied through Studio RPC tools, split by **lifetime**
(not by what the script does — a script can generate or transform in either):

| Tool | When | Behavior |
|---|---|---|
| `studiorpc_procedural_run` | One-shot | Runs a script once against the current scene and applies the result. Pass `script` inline or use `scriptPath` when a file is easier to author/reuse, plus optional `targetGuid` and `parameters`. `targetGuid` defaults to the whole Workspace. Nothing is persisted. |
| `studiorpc_procedural_model_save` | Persist | Writes the script + a manifest under `<project>/.overdare/procedural/`. Validates via a dry-run. Requires the `-- generationId:` comment (the model's identity). Does not touch the scene. |
| `studiorpc_procedural_model_run` | Run persisted | Looks the model up by `id`, runs it, **deletes the prior generation and re-applies** so repeat runs replace rather than duplicate. Updates the manifest. |
| `studiorpc_procedural_model_list` | Discover | Lists saved models (`id`, params, whether applied, last-updated) so `model_run` can find ids. |

`generationId` is required for `model_save`/`model_run`; for one-shot `procedural_run` it is auto-generated when the comment is absent.

The runtime always stages the complete input and script source in a unique OS
temporary directory before starting Luau; large inline scripts and whole-Workspace
scene snapshots do not travel through process argv. `targetGuid` is therefore
not a transport-size workaround; it remains the explicit scene-injection scope
and the parent for fresh top-level nodes. When omitted, Workspace is deliberately
used for both roles. Temporary files are removed after success, failure, or
timeout. Existing injected nodes do not consume the internal 5,000-node
generation guard, which applies only to freshly generated nodes and is not
exposed as an agent-tool argument.

### Generate vs Transform

The runner injects the current scene subtree (`targetGuid`, or the whole
Workspace) as a **`workspace` global** whose descendants carry their real scene
GUIDs. A script can therefore:

- **Generate** — build fresh geometry under `targetContainer` (the `OnGenerate`
  second argument), exactly as before. Fresh nodes become `add`s.
- **Transform** — read and mutate existing objects via `workspace`
  (`workspace:GetDescendants()`, `part.CFrame -= …`, `inst:Destroy()`).

Ops are derived by diffing the script's final state against the injected
snapshot: changed → `update`, `Destroy()`ed/detached → `delete`, fresh → `add`.

```lua
-- Transform example: nudge every part 1 unit along +X and delete markers.
Move.OnGenerate = function(parameters, targetContainer)
    for _, inst in workspace:GetDescendants() do
        if inst:IsA("BasePart") then
            if inst.Name == "Marker" then
                inst:Destroy()
            else
                inst.CFrame += Vector3.xAxis * 1
            end
        end
    end
end
```

**Transform limitations (MVP):**

- Only these properties are read/diffed/written: `CFrame`, `Size`, `Color`,
  `Material`, `WorldPivot`. Everything else stays untouched.
- **Reparenting an existing object is unsupported** — `update` cannot change a
  parent. Move/scale/recolor/delete/add are all supported.

Apply order is delete → update → add; new subtrees are created parent-first
using the live returned GUID. Do not design output around `refId` / `parentRefId`.
