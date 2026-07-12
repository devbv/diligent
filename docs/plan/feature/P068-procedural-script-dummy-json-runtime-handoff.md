---
id: P068-HANDOFF
parent: P068
created: 2026-06-02
status: active
---

# P068 Hand-off: Luau Procedural Script to Instance-Upsert-Ready JSON

## Why this hand-off exists

This hand-off captures the current state of the OVERDARE procedural script MVP so the next session can continue without rediscovering the design corrections made during implementation.

The key product direction is:

```text
Luau procedural script is the source of truth.
Generated objects are derived output.
The MVP output should be a nested `children: []` scene tree. Apply can recursively create each parent and immediately use the live returned GUID for that node's children.
```

## User corrections to preserve

- The compatibility layer must be named `ovdr-shim`.
- The system must be **Luau-based**, not a TypeScript regex/parser pretending to execute Luau.
- Libraries such as `Stair`, `GeometryPrimitives`, CSG helpers, etc. are dependencies used by scripts, not top-level generator registries.
- Procedural JSON should be a nested tree with `children: []`, not a flat `items[]` list.
- Procedural JSON does not need `refId` / `parentRefId` as its primary apply shape. Studio GUIDs are created live during apply, so applying a parent before its children is simpler and clearer.

## Current implementation state

### Plan document

- `docs/plan/feature/P068-procedural-script-dummy-json-runtime.md`

### Runtime source

- `apps/overdare-ai-agent/sidecar/src/procedural-model/types.ts`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/runtime.ts`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/script-metadata.ts`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/index.ts`

### Luau runner and libraries

- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/runner.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/json.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/ovdr-shim.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/dependencies/GeometryPrimitives.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/dependencies/ConstructiveSolidGeometry.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/dependencies/SmartObject.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/dependencies/MathUtils.lua`

### Examples

- `apps/overdare-ai-agent/sidecar/src/procedural-model/examples/pentagon.lua`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/examples/simple-house.lua`

### Vendored Luau 0.723 binaries

- `apps/overdare-ai-agent/sidecar/vendor/luau/0.723/darwin/luau`
- `apps/overdare-ai-agent/sidecar/vendor/luau/0.723/linux/luau`
- `apps/overdare-ai-agent/sidecar/vendor/luau/0.723/win32/luau.exe`

The runtime resolves Luau in this order:

1. explicit `luauBin`
2. `OVDR_LUAU_BIN`
3. `LUAU_BIN`
4. vendored Luau 0.723 for the current platform
5. PATH `luau`

## Current output contract

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

type ProceduralGeneratedNode = {
  class: "Model" | "Part";
  name: string;
  properties: ModelProperties | PartProperties;
  children?: ProceduralGeneratedNode[];
};
```

Later apply tool responsibility:

```ts
async function applyNode(node: ProceduralGeneratedNode, parentGuid: string) {
  const result = await instanceUpsert({
    items: [{
      class: node.class,
      parentGuid,
      name: node.name,
      properties: node.properties,
    }],
  });

  const nodeGuid = result.added[0].guid;
  for (const child of node.children ?? []) {
    await applyNode(child, nodeGuid);
  }
}

for (const child of generated.children) {
  await applyNode(child, targetParentGuid);
}
```

Initial apply should be recursive/sequential. It can become level-batched later only where parent GUIDs are already available.

## Implemented Luau capability

### `ovdr-shim.lua`

Implemented:

- `Vector3.new`
- `Vector3.zero`, `Vector3.xAxis`, `Vector3.yAxis`, `Vector3.zAxis`
- `Vector3` arithmetic: `+`, `-`, `*`, `/`
- `Vector3.Magnitude`
- `Vector3.Unit`
- `Vector3:Cross(other)`
- `Color3.fromRGB`
- `Color3.new`
- `CFrame.identity`
- `CFrame.new`
- `CFrame +/- Vector3`
- fake instances with `Parent`, `Children`, `GetDescendants`, `IsA`, `Destroy`
- deterministic local ids such as `node-2`, `node-3`
- approximate CFrame/Size serialization for two-point and point-cloud structural primitives
- apply-safe material normalization, e.g. `Sandstone` → `Rock`, `Sand` → `Ground`, `SmoothPlastic` → `Plastic`

`Primitive` instances are BasePart-like for transform loops:

```lua
primitive:IsA("BasePart") == true
primitive.CFrame -= Vector3.yAxis * offset
```

### `GeometryPrimitives.lua`

Implemented:

- `GP.model`
- `GP.sphere`
- `GP.block`
- `GP.cylinder(center, height, radius, ...)`
- `GP.cylinder(startPoint, endPoint, radius, ...)` overload
- `GP.taperedCylinder`
- `GP.regularPrism`
- `GP.strutFromTwoPoints`
- `GP.triangularPrismFromThreePoints`
- `GP.pyramid`
- `GP.quadFromFourPoints`

Complex primitives currently serialize as approximate `Part` geometry suitable for `instance_upsert`, not exact meshes. Two-point cylinders/struts now produce meaningful CFrame/Size; quad/triangle/pyramid-style primitives use axis-aligned bounding approximations.

### `ConstructiveSolidGeometry.lua`

Implemented:

- dummy `CSG.subtract(name, baseObject, cutters)`

Current limitation: output is still not a real boolean mesh/CSG result. The serialized Part now inherits the base object's approximate geometry instead of becoming a 1x1x1 placeholder, but cutters do not create actual holes yet. Since the output contract follows `instance_upsert` properties strictly, CSG metadata is not preserved in node `properties`. Decide in next work whether to preserve procedural metadata elsewhere, e.g. in a separate `sources` or `debug` section, not inside strict `properties`.

## Example outputs generated

Generated files during the session:

- `/tmp/ovdr-procedural-demo/pentagon.generated.json`
- `/tmp/ovdr-procedural-demo/simple-house.generated.json`

These are not committed; regenerate them when needed.

### Pentagon example

Script:

- `apps/overdare-ai-agent/sidecar/src/procedural-model/examples/pentagon.lua`

Produces:

- root model `Pentagon`
- 5 wall parts
- 5 corner parts
- 5 floor triangle approximation parts

### SimpleHouse example

Script:

- `apps/overdare-ai-agent/sidecar/src/procedural-model/examples/simple-house.lua`

Hierarchy demonstrated by nested `children: []`:

```text
SimpleHouse
  Foundation
    BaseSlab
  Walls
    WallFront
    WallBack
    WallLeft
    WallRight
    DoorGroup
      Door
      DoorKnob
    WindowGroup
      WindowLeft
      WindowRight
  Roof
    RoofLeft
    RoofRight
```

## Validation status

Commands run and passing:

```bash
bun test ./apps/overdare-ai-agent/sidecar/test/procedural-model/runtime.test.ts
./apps/overdare-ai-agent/sidecar/node_modules/.bin/tsc --pretty false --noEmit -p apps/overdare-ai-agent/sidecar/tsconfig.json
bunx biome check docs/plan/feature/P068-procedural-script-dummy-json-runtime.md apps/overdare-ai-agent/sidecar/src/procedural-model apps/overdare-ai-agent/sidecar/test/procedural-model/runtime.test.ts
```

Current test file:

- `apps/overdare-ai-agent/sidecar/test/procedural-model/runtime.test.ts`

It covers:

- metadata extraction
- missing Luau executable error
- deterministic Luau generation
- bunny-style primitive generation
- colosseum-style Vector3 math, CSG base-geometry approximation, destroy, and structural primitive compatibility

## Important current limitations

### 1. Complex primitive geometry is approximate, not exact

`strutFromTwoPoints`, `CylinderFromTwoPoints`, `quadFromFourPoints`, `triangularPrismFromThreePoints`, etc. currently emit `Part` properties that satisfy `instance_upsert` shape and roughly occupy the intended space, but do not yet represent exact authored geometry.

Current typical approximation:

```json
{
  "class": "Part",
  "properties": {
    "Shape": "Block",
    "CFrame": { "Position": { ... }, "Orientation": { ... } },
    "Size": { "X": "computed length/width", "Y": "computed height", "Z": "computed thickness/depth" },
    "Anchored": true,
    "Color": { ... },
    "Material": "Metal"
  }
}
```

Implemented approximations:

- `CylinderFromTwoPoints`
- `StrutFromTwoPoints`
- `QuadFromFourPoints` approximation
- `TriangularPrismFromThreePoints` approximation

Remaining work should improve exactness:

- oriented quad and triangular prism surfaces instead of axis-aligned bounding boxes
- real arch/window cutouts from CSG subtract
- mesh or multi-part decomposition where one Part cannot represent the shape

### 2. Strict `properties` means procedural metadata needs another place

Do not put custom keys like `ProceduralPrimitive`, `ProceduralData`, `baseId`, or `cutterIds` inside `properties`; `instance_upsert` validates properties strictly.

If metadata is needed, add it outside the instance item shape, for example:

```ts
{
  children: [...],
  proceduralMetadata: {
    [pathOrStableKey]: { primitive: "CSGSubtract", data: ... }
  }
}
```

This has not been implemented yet.

### 3. Apply tool does not exist yet

The runtime only generates procedural JSON. It does not yet:

- ask for target parent Studio GUID
- resolve `refId` / `parentRefId` to actual Studio `parentGuid` values
- call `studiorpc_instance_upsert`
- optionally batch siblings once their parent GUID is known

### 4. Packaging of vendored binaries should be verified

Vendored Luau binaries exist in the repo tree, but product packaging should be checked to ensure they are included in sidecar builds.

Relevant build script to inspect next:

- `scripts/build-overdare-sidecar.ts`

### 5. Runner input transport uses temporary Luau modules

The sidecar copies the runner dependencies into a unique OS temporary directory
and writes the input JSON and script source as separate Luau modules. Process
argv contains only the short input-module reference:

```text
luau runner.lua --program-args '--input-module=./procedural-input'
```

This avoids platform command-line limits for large inline scripts and whole-scene
snapshots. The temporary directory is removed after every outcome.

### 6. No timeout or sandbox policy yet

The Luau subprocess currently has no timeout/max-node/max-output guard. Add this before exposing as a user-facing tool.

## Recommended next tasks

## Helper library reference (historical)

The user added a top-level reference folder of helper modules (CSG, geometry primitives, math utilities, smart objects) as the primary API/signature reference while filling out the OVDR Luau dependencies. That folder has since been removed from the tree, and CSG and SmartObject were later dropped as unsupported.

### Public APIs discovered

`GeometryPrimitives` reference functions:

```text
strutFromTwoPoints(name, startPoint, endPoint, width, height, color, material, parent?, transparency?)
axisAlignedBlockFromCorners(name, corner1, corner2, color, material, parent?, transparency?)
cylinder(name, startFaceCenter, endFaceCenter, radius, color, material, parent?, transparency?)
hollowCylinder(name, p1, p2, outerRadius, wallThickness, color, material, parent?, transparency?)
sphere(name, position, radius, color, material, parent?, transparency?)
hemisphere(name, flatCenter, polePoint, color, material, parent?, transparency?)
hollowHemisphere(name, rimCenter, polePoint, wallThickness, color, material, parent?, transparency?)
triangularPrismFromThreePoints(name, p1, p2, p3, depth, extrusionDir?, color, material, parent?, transparency?)
ramp(name, startPoint, endPoint, width, color, material, parent?, transparency?)
model(name, parent?)
quadFromFourPoints(name, p1, p2, p3, p4, thickness, extrusionDir?, color, material, parent?, transparency?)
cone(name, basePoint, apexPoint, baseRadius, color, material, parent?, transparency?)
taperedCylinder(name, p1, p2, radius1, radius2, color, material, parent?, transparency?)
hollowTaperedCylinder(name, p1, p2, radius1, radius2, wallThickness, color, material, parent?, transparency?)
capsule(name, endpoint1, radius1, endpoint2, radius2, color, material, parent?, transparency?)
tube(name, points, radius, color, material, parent?, transparency?)
regularPrism(name, p1, p2, radius, sides, color, material, parent?, transparency?)
roundedBox(name, center, size, radius, color, material, parent?, transparency?)
pyramid(name, baseCorner1, baseCorner2, apex, color, material, parent?, transparency?)
text(name, text, p1, p2, p3, p4, faceDir?, textColor?, parent?, thickness?, font?)
```

`ConstructiveSolidGeometry` reference functions:

```text
union(name, mainPart, otherParts)
intersect(name, mainPart, otherParts)
subtract(name, mainPart, negateParts)
```

`MathUtils` reference functions:

```text
lerp(a, b, t)
lerpVector3(v1, v2, t)
lerpColor(c1, c2, t)
bezier(t, p0, p1, p2, p3)
quadraticBezier(t, p0, p1, p2)
polarToCartesian(center, radius, angle, plane)
sampleBezierPoints(p0, p1, p2, p3, segments)
linearArray(startPos, endPos, count, callback)
radialArray(center, radius, count, axis, callback)
radialArrayConnected(center, radius, count, axis, callback)
```

`SmartObject` reference function:

```text
getAttribute(instanceOrParameterTable, key, defaultValue)
```

### Reference details to reuse

- `strutFromTwoPoints` computes a real block Part using `Size = Vector3.new(width, height, length)` and `CFrame.fromMatrix(mid, xAxis, yAxis, zAxis)` where `zAxis = (end - start).Unit`.
- `cylinder` computes a real cylinder Part using `Shape = "Cylinder"`, `Size = Vector3.new(distance, radius * 2, radius * 2)`, and `CFrame.fromMatrix(midpoint, xAxis, yAxis)`.
- `axisAlignedBlockFromCorners` is a clean direct mapping to `Shape = "Block"`, center CFrame, and corner-derived size.
- `quadFromFourPoints` and `triangularPrismFromThreePoints` include degenerate handling and sometimes delegate to each other.
- `MathUtils` needs additional shim APIs such as `Vector3:Dot` and `Vector3:Lerp`.
- `SmartObject.getAttribute` should work with the procedural `parameters` table (`Size` + `Attributes`) and write defaults into `Attributes` when missing.

### Current OVDR gaps against the reference library

1. `ovdr-shim` lacks `Vector3:Dot` and `Vector3:Lerp`.
2. `ovdr-shim` lacks `CFrame.fromMatrix`, needed for strut/cylinder orientation.
3. Some GP functions are still absent: `axisAlignedBlockFromCorners`, `hollowCylinder`, `hemisphere`, `hollowHemisphere`, `ramp`, `cone`, `hollowTaperedCylinder`, `capsule`, `tube`, `roundedBox`, `text`.
4. `MathUtils.lua` in OVDR dependencies is still a placeholder.
5. `SmartObject.lua` in OVDR dependencies is still a placeholder.
6. `ConstructiveSolidGeometry.union` and `intersect` are missing; `subtract` is placeholder/approximate.

Recommended adaptation order:

1. Add `Vector3:Dot`, `Vector3:Lerp`, and `CFrame.fromMatrix`.
2. Update `strutFromTwoPoints` and two-point `cylinder` to use the reference formulas while outputting strict `instance_upsert` properties.
3. Implement `axisAlignedBlockFromCorners`.
4. Implement `SmartObject.getAttribute` for parameter-table inputs.
5. Implement the pure `MathUtils` functions.
6. Add placeholder-compatible signatures for the remaining GP functions, keeping `properties` strict.

### Task A: Improve complex primitives from approximate Part geometry to better shape decomposition

Initial approximation exists for these because they are used by the colosseum and house examples:

- `CylinderFromTwoPoints` → `Part` with `Shape: "Cylinder"`, center CFrame, height-based Size
- `StrutFromTwoPoints` → `Part` with `Shape: "Block"`, midpoint CFrame, length/thickness/height Size

Next Task A work should focus on:

- `QuadFromFourPoints` as an oriented thin block or decomposed surface
- `TriangularPrismFromThreePoints` as a closer wedge approximation or decomposed mesh-like parts
- `CSG.subtract` preserving visible base shape while optionally exposing debug/source metadata outside `properties`

Use `instance_upsert` property names exactly:

```ts
{
  Shape: "Block" | "Cylinder",
  CFrame: { Position, Orientation },
  Size: { X, Y, Z },
  Anchored: true,
  Color,
  Material,
}
```

### Task B: Add an apply tool prototype

Create a tool that takes:

```ts
{
  targetParentGuid: string;
  scriptSource: string;
  parameters: ProceduralParameters;
}
```

Then:

1. run `generateProceduralDummyJson`
2. iterate `items` in parent-before-child order
3. resolve `parentRefId == nil` to `targetParentGuid`
4. resolve non-null `parentRefId` through a `refId -> actualGuid` map
5. call `studiorpc_instance_upsert` with `{ class, parentGuid, name, properties }`
6. save returned GUID back into the ref map

### Task C: Add metadata channel if needed

If procedural metadata is needed for regeneration/debugging, add it outside `properties` so item properties remain strict `instance_upsert` compatible.

### Task D: Add subprocess guardrails

Add runtime options:

```ts
{
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxItems?: number;
}
```

## Git status notes

Expected uncommitted changes include:

- `.diligent/knowledge/knowledge.jsonl`
- `docs/plan/feature/P068-procedural-script-dummy-json-runtime.md`
- `docs/plan/feature/P068-procedural-script-dummy-json-runtime-handoff.md`
- `apps/overdare-ai-agent/sidecar/src/procedural-model/`
- `apps/overdare-ai-agent/sidecar/test/procedural-model/`
- `apps/overdare-ai-agent/sidecar/vendor/luau/`

The `.diligent/knowledge/knowledge.jsonl` change records the user preference that this system should use `ovdr-shim` naming.
